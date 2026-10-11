import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, realpath, rename, writeFile,readFile,readlink } from "node:fs/promises";
import {createReadStream}from"node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID,createHash } from "node:crypto";
export async function reviewWorktree(lease:WorktreeLease){
 const artifact=await inspectWorktree(lease);
 if(artifact.truncated)throw Error("worktree review capacity");
 const tracked=await git(lease.path,["diff","--name-only","-z",lease.base],true),untracked=await git(lease.path,["ls-files","-z","--others","--exclude-standard"],true),ignored=await git(lease.path,["ls-files","-z","--others","--ignored","--exclude-standard"],true);
 const paths=[...new Set([tracked,untracked,ignored].flatMap(list=>list.split("\0").filter(Boolean)))].sort();
 if(paths.length>512)throw Error("worktree review capacity; manual preservation required");
 const hash=createHash("sha256").update(JSON.stringify(artifact));let bytes=0;
 for(const name of paths){
  const path=resolve(lease.path,name);if(!inside(lease.path,path)||name.split("/").includes(".git"))throw Error("worktree review path unavailable");
  hash.update(JSON.stringify(name));let stat;try{stat=await lstat(path);}catch(error){if((error as any).code!=="ENOENT")throw error;hash.update("missing");continue;}
  if(stat.isSymbolicLink()){hash.update("link:").update(await readlink(path));continue;}
  if(!stat.isFile()||await realpath(path)!==path)throw Error("worktree review linked/non-file path");
  bytes+=stat.size;if(bytes>32*1024*1024)throw Error("worktree review capacity; manual preservation required");
  hash.update(`file:${stat.mode}:`);for await(const chunk of createReadStream(path,{highWaterMark:65536}))hash.update(chunk);
 }
 return {artifact,fingerprint:hash.digest("hex")};
}
export async function recoverWorktree(root:string,id:string):Promise<WorktreeLease>{
  if(!/^[a-f0-9-]{36}$/.test(id))throw Error("invalid ownership record");
  const directory=await lstat(root),file=join(root,`${id}.json`),stat=await lstat(file);
  if(!directory.isDirectory()||(directory.mode&0o077)||!stat.isFile()||(stat.mode&0o077)||(process.getuid&&[directory.uid,stat.uid].some(uid=>uid!==process.getuid!())))throw Error("private ownership record required");
  const canonical=await realpath(root),record=JSON.parse(await readFile(file,"utf8"));
  if(record.version!==1||record.state!=="retained"||record.id!==id||record.path!==join(canonical,id)||record.branch!==`pi-subagent/${id}`||
    !/^[a-f0-9]{40,64}$/.test(record.base)||!Array.isArray(record.files)||!record.files.length||record.files.length>64||!record.files.every(scopeValid)||
    typeof record.repo!=="string"||typeof record.commonDir!=="string"||await realpath(record.repo)!==record.repo)throw Error("invalid ownership record");
  const lease:WorktreeLease=Object.freeze({version:1,id,repo:record.repo,commonDir:record.commonDir,path:record.path,branch:record.branch,base:record.base,files:Object.freeze([...record.files])});
  issued.add(lease);if(!(await validateWorktree(lease))){issued.delete(lease);throw Error("owned worktree unavailable");}return lease;
}
export async function discardWorktree(lease:WorktreeLease,review:{expectedStatus:string;expectedFingerprint?:string;discardDirty:boolean}):Promise<void>{
  if(!(await validateWorktree(lease)))throw Error("owned worktree required");
  const record=await recoverWorktree(dirname(lease.path),lease.id);
  if(JSON.stringify(record)!==JSON.stringify(lease))throw Error("ownership drift");
  const artifact=await inspectWorktree(lease);
  if(artifact.truncated||artifact.status!==review.expectedStatus)throw Error("worktree review drift");
  if(artifact.dirty&&review.discardDirty!==true)throw Error("dirty worktree requires explicit discard");
  const fresh=await reviewWorktree(lease);
  if(!review.expectedFingerprint||fresh.fingerprint!==review.expectedFingerprint)throw Error("worktree review drift");
  // Destructive only after exact ownership/status/content review. Keep branch and record;
  // uncommitted discarded files are not recoverable from that branch.
  await git(lease.repo,["worktree","remove",...(artifact.dirty?["--force"]:[]),lease.path]);
  const path=join(dirname(lease.path),`${lease.id}.json`),staging=`${path}.discard-${randomUUID()}`;
  await writeFile(staging,JSON.stringify({...lease,state:"discarded"}),{flag:"wx",mode:0o600});await rename(staging,path);issued.delete(lease);
}
const exec = promisify(execFile), issued = new WeakSet<object>();
export type WorktreeLease = Readonly<{ version: 1; id: string; repo: string; commonDir: string; path: string; branch: string; base: string; files: readonly string[] }>;
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel); };
const scopeValid = (path: string) => typeof path === "string" && path.length > 0 && path.length <= 1024 && !isAbsolute(path) &&
  !path.includes("\\") && !path.split("/").some(part => part === ".." || part === "." || part === ".git") && !path.includes("\0");
async function git(cwd: string, args: string[],raw=false) {
  const result = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", cwd, ...args], { timeout: 15000, maxBuffer: 256 * 1024 });
  return raw?result.stdout:result.stdout.trim();
}
export async function committedBase(cwd: string): Promise<{ repo: string; base: string }> {
  const repo = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
  return { repo, base: await git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]) };
}
export async function createWorktree(options: { repo: string; root: string; base: string; files: readonly string[] }): Promise<WorktreeLease> {
  if (!/^[a-f0-9]{40,64}$/.test(options.base) || !Array.isArray(options.files) || !options.files.length || options.files.length > 64 || Buffer.byteLength(JSON.stringify(options.files))>16384 || !options.files.every(scopeValid)) throw Error("invalid worktree base or file scope");
  const repo = await realpath(options.repo), commonDir = await realpath(resolve(repo, await git(repo, ["rev-parse", "--git-common-dir"])));
  if (await git(repo, ["rev-parse", "--verify", `${options.base}^{commit}`]) !== options.base) throw Error("invalid committed base");
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const stat=await lstat(options.root);
  if(!stat.isDirectory()||(stat.mode&0o077)||(process.getuid&&stat.uid!==process.getuid()))throw Error("private worktree root required");
  const root = await realpath(options.root), id = randomUUID(), path = join(root, id), branch = `pi-subagent/${id}`;
  const lease: WorktreeLease = Object.freeze({ version: 1, id, repo, commonDir, path, branch, base: options.base, files: Object.freeze([...options.files]) });
  const record = join(root, `${id}.json`);
  // Record ownership before Git can create anything. Failed/dirty artifacts are
  // retained; this module has no automatic remove, commit, merge or push path.
  await writeFile(record, JSON.stringify({ ...lease, state: "creating" }), { flag: "wx", mode: 0o600 });
  await git(repo, ["worktree", "add", "-b", branch, path, options.base]);
  const staging = `${record}.tmp`;
  await writeFile(staging, JSON.stringify({ ...lease, state: "retained" }), { flag: "wx", mode: 0o600 });
  await rename(staging, record); issued.add(lease);
  return lease;
}
export async function validateWorktree(lease: WorktreeLease): Promise<boolean> {
  if (!lease || !issued.has(lease)) return false;
  try {
    if (!(await lstat(lease.path)).isDirectory() || await realpath(lease.path) !== lease.path) return false;
    const common = await realpath(resolve(lease.path, await git(lease.path, ["rev-parse", "--git-common-dir"])));
    return common === lease.commonDir && await git(lease.path, ["symbolic-ref", "--short", "HEAD"]) === lease.branch;
  } catch { return false; }
}
export async function assertWritable(lease: WorktreeLease, target: string): Promise<string> {
  if (typeof target !== "string" || target.includes("\0") || !(await validateWorktree(lease))) throw Error("forbidden worktree target");
  const path = resolve(lease.path, target), rel = relative(lease.path, path).split(sep).join("/");
  // SDK paths normalize Unicode whitespace. Reject those ambiguous names before
  // passing the exact absolute target, so validation and execution cannot diverge.
  if (/[^\S ]/u.test(path)) throw Error("forbidden ambiguous whitespace in target");
  if (!inside(lease.path, path) || rel.split("/").includes(".git") || !lease.files.some(scope => scope.endsWith("/") ? rel.startsWith(scope) : rel === scope)) throw Error("forbidden file scope");
  try { if (!(await lstat(path)).isFile()) throw Error("forbidden linked/non-file target"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let ancestor = dirname(path);
  while (ancestor !== lease.path) {
    try { if ((await lstat(ancestor)).isSymbolicLink()) throw Error("forbidden linked ancestor"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    ancestor = dirname(ancestor);
  }
  return path;
}
export async function inspectWorktree(lease: WorktreeLease) {
  if (!(await validateWorktree(lease))) throw Error("owned worktree unavailable; retained artifact requires manual recovery");
  const status = await git(lease.path, ["status", "--porcelain=v1", "--untracked-files=all","--ignored=matching"]);
  const diff=await git(lease.path,["diff","--stat",lease.base]);
  return Object.freeze({ id:lease.id,path: lease.path, repo: lease.repo, branch: lease.branch, base: lease.base, commit: await git(lease.path, ["rev-parse", "HEAD"]), dirty: status.length > 0,
    status: status.slice(0, 16384),diff:diff.slice(0,16384), truncated: status.length > 16384||diff.length>16384, files: lease.files });
}
