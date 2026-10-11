/** Process-wide, reload-safe admission ownership. Never reattach guessed SDK sessions. */
const key=Symbol.for("pi-setup.native-subagents.owners.v1");
const host=globalThis as any;
const owners:Map<string,{token:symbol;quarantined:boolean}>=host[key]??=new Map();
export function claimOwner(id:string){
 const old=owners.get(id);
 if(old)throw Error(old.quarantined?"Subagent owner quarantined: restart this Pi process after inspecting retained evidence":"Subagent owner is still draining");
 const token=Symbol(id);owners.set(id,{token,quarantined:false});
 return {quarantine(){const own=owners.get(id);if(own?.token===token)own.quarantined=true;},
  release(){const own=owners.get(id);if(own?.token===token&&!own.quarantined)owners.delete(id);}};
}
