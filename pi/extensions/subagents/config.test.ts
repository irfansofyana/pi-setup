import test from"node:test";import assert from"node:assert/strict";
import{validateNativeConfig,companionConfigured}from"./config.ts";
test("native activation is explicit, validates finite caps, and rejects routed fallback or known companion sources",()=>{
 assert.equal(companionConfigured({packages:["npm:@tintinweb/pi-subagents@0.14.3"]}),true);
 assert.equal(companionConfigured({packages:[{source:"npm:@tintinweb/pi-subagents"}]}),true);
 assert.equal(companionConfigured({extensions:["/private/node_modules/@tintinweb/pi-subagents/index.ts"]}),true);
 assert.equal(companionConfigured({packages:["npm:pi-stats-ext@0.2.0","npm:@ff-labs/pi-fff@0.10.5"]}),false);
 assert.throws(()=>validateNativeConfig({version:1,enabled:true,routing:"headroom"}),/routing/);
 assert.throws(()=>validateNativeConfig({version:1,enabled:true,routing:"native",concurrency:100}),/caps/);
 assert.throws(()=>validateNativeConfig({version:99,enabled:true,routing:"native"}),/version/);
 assert.equal(validateNativeConfig({version:1,enabled:true,routing:"native"}).concurrency,3);
 assert.equal(validateNativeConfig({version:1,enabled:true,routing:"native"}).persist,false);
});
