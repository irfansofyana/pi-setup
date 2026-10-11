import test from "node:test";
import assert from "node:assert/strict";
import { parentProvider } from "./parent-provider.ts";

test("native child provider resolves current exact parent auth and rejects model drift", async () => {
  const model: any = {provider:"example",id:"chosen",api:"example-api",baseUrl:"https://example.test"};
  let key = "first", current = model;
  const registry: any = {find:()=>current,getProvider:()=>({id:"example",name:"Example",stream:()=>"stream",streamSimple:()=>"simple"}),
    getApiKeyAndHeaders:async()=>({ok:true,apiKey:key,headers:{"x-fixture":"header"},env:{REGION:"fixture"},baseUrl:"https://auth-resolved.test"})};
  const provider = parentProvider(registry,"example/chosen");
  assert.deepEqual(provider.getModels(),[model]);
  assert.equal((await provider.auth.apiKey!.resolve({} as any))?.auth.apiKey,"first");
  key="second";
  const auth = await provider.auth.apiKey!.resolve({} as any);
  assert.equal(auth?.auth.apiKey,"second"); assert.deepEqual(auth?.auth.headers,{"x-fixture":"header"});
  assert.deepEqual(auth?.env,{REGION:"fixture"});
  assert.equal(provider.streamSimple({...model,baseUrl:"https://auth-resolved.test"},{} as any),"simple");
  assert.throws(()=>provider.streamSimple({...model,id:"other"},{} as any),/assignment/);
  current={...model,baseUrl:"https://changed.test"};
  assert.equal(await provider.auth.apiKey!.resolve({} as any),undefined);
});

test("native provider acquisition rejects missing exact model/provider rather than falling back",()=>{
  assert.throws(()=>parentProvider({find:()=>undefined} as any,"example/missing"),/unavailable/);
  assert.throws(()=>parentProvider({find:()=>({provider:"example",id:"chosen"}),getProvider:()=>undefined} as any,"example/chosen"),/unavailable/);
});
