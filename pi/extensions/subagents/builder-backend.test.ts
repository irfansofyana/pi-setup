import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createWorktree } from "./worktrees.ts";
import { createTrustedRoleBackend } from "./trusted.ts";
const exec = promisify(execFile);

test("builder binds scoped mutation tools to an owned worktree and keeps parent checkout unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "builder-sdk-")), repo = join(root, "repo"), agentDir = join(root, "agent");
  try {
    await mkdir(repo); await mkdir(join(agentDir, "agents"), { recursive: true });
    await exec("git", ["init", "--quiet", repo]); await writeFile(join(repo, "file.txt"), "parent\n");
    await exec("git", ["-C", repo, "add", "file.txt"]);
    await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-C", repo, "commit", "--quiet", "-m", "fixture"]);
    const base = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    const lease = await createWorktree({ repo, root: join(root, "artifacts"), base, files: ["file.txt"] });
    await writeFile(join(agentDir, "agents", "builder.md"), await readFile(new URL("../../agents/builder.md", import.meta.url), "utf8"));
    const fffPath = join(agentDir, "fff.mjs"), skill = join(agentDir, "code-review.md");
    await writeFile(fffPath, 'export default function(pi) { for (const name of ["fffind","ffgrep","fff-multi-grep"]) pi.registerTool({ name, label:name, description:name, parameters:{type:"object",properties:{}}, execute:async()=>({content:[{type:"text",text:"fixture"}]}) }); }');
    await writeFile(skill, "---\nname: code-review\ndescription: fixture\n---\nReview changes.\n");
    let calls = 0;
    const model: any = { id: "offline", provider: "fixture", name: "Fixture", api: "fixture", baseUrl: "offline://fixture", input: ["text"], cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, reasoning: false, contextWindow: 32768, maxTokens: 1024 };
    const respond = () => {
      const stream = createAssistantMessageEventStream(), current = ++calls;
      queueMicrotask(() => {
        const content = current === 1 ? [{type:"toolCall",id:"write-ok",name:"write",arguments:{path:"file.txt",content:"child\n"}}, {type:"toolCall",id:"write-escape",name:"write",arguments:{path:join(repo,"file.txt"),content:"escaped\n"}}] : [{type:"text",text:"finished"}];
        const message: any = { role:"assistant",provider:"fixture",model:"offline",api:"fixture",content,stopReason:current===1?"toolUse":"stop",timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} };
        stream.push({type:"start",partial:message}); stream.push({type:"done",reason:message.stopReason,message});
      }); return stream;
    };
    const provider: any = {id:"fixture",name:"Fixture",getModels:()=>[model],auth:{apiKey:{name:"fixture",check:async()=>({type:"api_key"}),resolve:async()=>({auth:{apiKey:"fixture"}})}},stream:respond,streamSimple:respond};
    const resources = {models:["fixture/offline"],tools:["read","grep","find","ls","edit","write","ext:fff/fffind","ext:fff/ffgrep","ext:fff/fff-multi-grep"],extensions:["fff"],skills:["code-review"]};
    const result = await createTrustedRoleBackend({role:"builder",agentDir,cwd:lease.path,model:"fixture/offline",provider,available:resources,routing:"native",fffPath,skillPaths:{"code-review":skill},worktreeLease:lease});
    assert.equal(result.ok,true,result.ok?undefined:result.code); if(!result.ok)return;
    try {
      const errors: any[] = [];
      assert.equal((await result.backend.run("Change file.txt only",e=>{if(e.type==="tool_execution_end"&&e.isError)errors.push(e);})).outcome,"completed");
      assert.equal(await readFile(join(lease.path,"file.txt"),"utf8"),"child\n");
      assert.equal(await readFile(join(repo,"file.txt"),"utf8"),"parent\n");
      assert.equal(errors.length,1); assert.equal(errors[0].toolName,"write");
    } finally {await result.backend.dispose();}
  } finally {await rm(root,{recursive:true,force:true});}
});
