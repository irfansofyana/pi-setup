type Record = {threadId:string;role:string};
type Inspect = (threadId:string)=>{threadState:string;consumed:boolean}|undefined;
export function hasLiveBuilder(records:Map<string,Record>,inspect:Inspect){
 return [...records.values()].some(record=>{
  const snapshot=inspect(record.threadId);return record.role==="builder"&&snapshot!==undefined&&snapshot.threadState!=="closed";
 });
}
export function pruneRuntimeRecords(records:Map<string,Record>,activity:Map<string,string>,receipts:Map<string,string>,inspect:Inspect){
 const retired=(threadId:string)=>{const snapshot=inspect(threadId);return !snapshot||(snapshot.threadState==="closed"&&snapshot.consumed);};
 for(const[id,record]of records)if(retired(record.threadId))records.delete(id);
 for(const shelf of[activity,receipts])for(const threadId of shelf.keys())if(retired(threadId))shelf.delete(threadId);
}
