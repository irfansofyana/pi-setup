#!/usr/bin/env node
import { mkdtemp, mkdir, copyFile, writeFile, access, readFile,lstat,realpath } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node pi/extensions/subagents/preview.mjs [--prepare-only] [--profile=/existing/private/profile] [--persist] [--schedules] [--workflows] [--integration] [--theme-ui] [--fff=/absolute/src/index.ts] [--pi=/absolute/pi] [--model=provider/model-id]\nCreates/reuses a retained private marked profile; installs nothing. Features are off unless explicitly enabled. Integration adds reviewed Goal/Prompt Loop entrypoints; theme-ui adds the canonical theme/editor in this process only. Launch is hard memory/CPU/time capped. Credentials: environment or /login in this profile only.");
  process.exit(0);
}
for (const arg of args) if (!["--prepare-only","--persist","--schedules","--workflows","--integration","--theme-ui"].includes(arg) && !/^--(fff|pi|model|profile)=.+$/.test(arg)) throw Error(`Unknown argument: ${arg}`);
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const exists = async path => { try { await access(path); return true; } catch { return false; } };
const reused=option("profile");
const agentDir = reused?resolve(reused):await mkdtemp(join(tmpdir(), "pi-subagents-preview-"));
const profile = join(agentDir,"subagents-preview.json");
let previous;
if(reused){
 if(!reused.startsWith("/")||[repo,homedir(),join(homedir(),".pi/agent"),resolve(tmpdir()),"/"].includes(agentDir)||await realpath(agentDir)!==agentDir)throw Error("private marked profile required");
 for(const [path,directory]of [[agentDir,true],[profile,false],[join(agentDir,"settings.json"),false]]){const stat=await lstat(path);if((directory?!stat.isDirectory():!stat.isFile())||(stat.mode&0o077)||(process.getuid&&stat.uid!==process.getuid()))throw Error("private profile ownership required");}
 previous=JSON.parse(await readFile(profile,"utf8"));
 const settings=JSON.parse(await readFile(join(agentDir,"settings.json"),"utf8"));
 if(previous.version!==1||previous.agentDir!==agentDir||previous.routing!=="native"||settings.packages?.length||settings.extensions?.length)throw Error("exclusive preview profile required");
}
if(!reused){
await mkdir(join(agentDir, "agents"), {mode:0o700});
for (const role of ["researcher", "code-mapper", "builder", "reviewer"]) await copyFile(join(repo,"pi/agents",`${role}.md`),join(agentDir,"agents",`${role}.md`));
}
const candidate = option("fff") ?? join(homedir(),".pi/agent/npm/node_modules/@ff-labs/pi-fff/src/index.ts");
const fffPath = await exists(candidate) ? resolve(candidate) : undefined;
if (option("fff") && !fffPath) throw Error("Explicit FFF entrypoint does not exist");
const skillPaths = {};
for (const name of ["mermaid","teach","code-review"]) {
  for (const root of [".pi/agent/skills", ".agents/skills"]) {
    const path = join(homedir(),root,name,"SKILL.md");
    if (await exists(path)) { skillPaths[name] = path; break; }
  }
}
const config=previous??{version:1,agentDir,routing:"native",fffPath,skillPaths};
if(option("fff"))config.fffPath=fffPath;
for(const feature of ["persist","schedules","workflows","integration"])if(args.includes(`--${feature}`))config[feature]=true;
if(args.includes("--theme-ui"))config.themeUI=true;
if(!reused){await writeFile(join(agentDir,"settings.json"),JSON.stringify({packages:[],extensions:[],skills:[],defaultThinkingLevel:"medium"}),{mode:0o600,flag:"wx"});await writeFile(profile,JSON.stringify(config),{mode:0o600,flag:"wx"});}
else if(option("fff")||args.some(arg=>["--persist","--schedules","--workflows","--integration","--theme-ui"].includes(arg)))await writeFile(profile,JSON.stringify(config),{mode:0o600});
console.log(`Preview profile retained at: ${agentDir}\nRouting: native; concurrency: 1; parent/global configuration untouched.\nFFF: ${config.fffPath ?? "missing (local roles unavailable)"}\nSkills: ${Object.keys(config.skillPaths??{}).join(", ") || "none (local roles unavailable)"}\nBuilder worktrees are retained; do not delete this profile before inspecting them.`);
console.log(`Persistence: ${config.persist===true}; schedules: ${config.schedules===true}; workflows: ${config.workflows===true}; integration: ${config.integration===true}`);
if (!args.includes("--prepare-only")) {
  const memory = /MemAvailable:\s+(\d+) kB/.exec(await readFile("/proc/meminfo","utf8"));
  if (!memory || Number(memory[1]) < 2 * 1024 * 1024) throw Error("Preview not started: at least 2 GiB host memory headroom required. Profile retained.");
  const command = option("pi") ?? "pi";
  const entries=[join(repo,"pi/extensions/subagents/index.ts"),...(config.integration?["goal-loop","loop"].map(name=>join(repo,`pi/extensions/${name}/index.ts`)):[]),...(config.themeUI?[join(repo,"pi/themes/pi-irfan-devs/index.ts")]:[])];
  const cliArgs = ["--no-extensions","--no-skills","--no-prompt-templates","--no-themes",...entries.flatMap(path=>["-e",path]),...(config.themeUI?["--theme",join(repo,"pi/themes/pi-irfan-devs/theme.json"),"--use-theme","pi-irfan-devs"]:[]),...(option("model") ? ["--model",option("model")] : [])];
  const child = spawn("systemd-run",["--user","--scope","-p","MemoryMax=1G","-p","MemorySwapMax=0","-p","CPUQuota=50%","-p","TasksMax=64","-p","RuntimeMaxSec=3600",command,...cliArgs],{stdio:"inherit",env:{...process.env,PI_CODING_AGENT_DIR:agentDir,PI_SETUP_SUBAGENTS_PREVIEW:"1",PI_SETUP_SUBAGENTS_PROFILE:profile,PI_FFF_MULTIGREP:"1"}});
  child.on("error",error=>{console.error(`Preview not started: ${error.message}. No unbounded fallback.`);process.exitCode=1;});
  child.on("exit",(code,signal)=>{console.log(`Retained preview: ${agentDir}`);process.exitCode=code ?? (signal ? 1 : 0);});
}
