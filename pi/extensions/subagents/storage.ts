import {mkdir,lstat,readFile,open,rename,unlink}from"node:fs/promises";
import {join,resolve}from"node:path";
import {randomUUID,createHash}from"node:crypto";
type Stored<T>={version:1;owner:string;revision:number;data:T};
// Results (8 MiB), notification outbox (8 MiB), and workflow journals (8 MiB)
// have independent bounded shelves; leave finite metadata headroom.
const maximum=32*1024*1024;
export async function inspectStorageLease(root:string){
 const directory=await lstat(root),path=join(root,"owner.lock"),file=await lstat(path);
 if(!directory.isDirectory()||!file.isFile()||((directory.mode|file.mode)&0o077)||file.size>4096||(process.getuid&&[directory.uid,file.uid].some(uid=>uid!==process.getuid!())))throw Error("private storage lease required");
 const raw=await readFile(path,"utf8"),lease=JSON.parse(raw);
 if(lease.version!==1||typeof lease.owner!=="string"||!Number.isSafeInteger(lease.pid)||lease.pid<1||typeof lease.token!=="string"||!lease.token)throw Error("unsupported storage lease; original preserved");
 return Object.freeze({...lease,fingerprint:createHash("sha256").update(raw).digest("hex")});
}
/** Call only after explicit human review; dead PID is not proof of retained context. */
export async function reconcileStorageLease(root:string,review:Awaited<ReturnType<typeof inspectStorageLease>>){
 const current=await inspectStorageLease(root);
 if(current.fingerprint!==review.fingerprint)throw Error("storage lease drift");
 try{process.kill(current.pid,0);throw Error("storage lease process still alive");}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}
 if((await inspectStorageLease(root)).fingerprint!==review.fingerprint)throw Error("storage lease drift");
 await rename(join(root,"owner.lock"),join(root,`owner.lock.recovered-${randomUUID()}`));
}
export async function openStore<T=any>(options:{root:string;owner:string;enabled:boolean}){
 if(!options.enabled)return {load:async():Promise<Stored<T>|undefined>=>undefined,save:async(_revision:number,_data:T):Promise<Stored<T>>=>{throw Error("persistence disabled");},close:async()=>{}};
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(options.owner))throw Error("invalid owner");
 const root=resolve(options.root);await mkdir(root,{recursive:true,mode:0o700});
 const privateFile=async(path:string,directory=false)=>{const stat=await lstat(path);if((directory?!stat.isDirectory():!stat.isFile())||(stat.mode&0o077)||(process.getuid&&stat.uid!==process.getuid()))throw Error("private regular storage required");if(stat.size>maximum)throw Error("storage capacity");return stat;};
 await privateFile(root,true);
 const lock=join(root,"owner.lock"),token=randomUUID();let handle;
 try{handle=await open(lock,"wx",0o600);}catch{throw Error("storage lease conflict; reconcile retained owner.lock manually");}
 try{await handle.writeFile(JSON.stringify({version:1,owner:options.owner,pid:process.pid,token}));await handle.sync();}finally{await handle.close();}
 const path=join(root,"state.json");let closed=false,queue:Promise<any>=Promise.resolve();
 const owned=async()=>{if(closed)throw Error("storage closed");await privateFile(lock);const lease=JSON.parse(await readFile(lock,"utf8"));if(lease.token!==token||lease.owner!==options.owner)throw Error("storage lease drift");};
 const load=async():Promise<Stored<T>|undefined>=>{
  await owned();try{await privateFile(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}
  let value;try{value=JSON.parse(await readFile(path,"utf8"));}catch{throw Error("corrupt storage; original preserved");}
  if(value?.version!==1)throw Error("unsupported storage version; original preserved");
  if(value.owner!==options.owner)throw Error("storage owner mismatch");
  if(!Number.isSafeInteger(value.revision)||value.revision<1||!value.data||typeof value.data!=="object")throw Error("corrupt storage");
  return value;
 };
 const save=(revision:number,data:T):Promise<Stored<T>>=>{
  const captured=structuredClone(data);
  const operation=queue.then(async()=>{
   await owned();const current=await load();if(!Number.isSafeInteger(revision)||revision<0||(current?.revision??0)!==revision)throw Error("storage revision conflict");
   if(revision===Number.MAX_SAFE_INTEGER)throw Error("storage revision exhausted");
   const value:Stored<T>={version:1,owner:options.owner,revision:revision+1,data:captured};const text=JSON.stringify(value);if(Buffer.byteLength(text)>maximum)throw Error("storage capacity");
   const staging=join(root,`.state-${randomUUID()}.tmp`),file=await open(staging,"wx",0o600);
   try{await file.writeFile(text);await file.sync();}finally{await file.close();}
   await owned();await rename(staging,path);const directory=await open(root,"r");try{await directory.sync();}finally{await directory.close();}
   return value;
  });queue=operation.catch(()=>{});return operation;
 };
 const close=async()=>{await queue;if(closed)return;await owned();closed=true;await unlink(lock);};
 return {load,save,close};
}
