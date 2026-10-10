import{isAbsolute}from"node:path";
export function companionConfigured(settings:any){
 const sources=[...(settings?.packages??[]).map((entry:any)=>typeof entry==="string"?entry:entry?.source),...(settings?.extensions??[]).map((entry:any)=>typeof entry==="string"?entry:entry?.path)].filter((entry:any)=>typeof entry==="string");
 return sources.some((source:string)=>/@tintinweb\/pi-subagents|tintinweb[^\s]*pi-subagents/i.test(source));
}
export function validateNativeConfig(input:any){
 if(!input||input.version!==1||input.enabled!==true)throw Error("native subagent version/enabled configuration required");
 if(input.routing!=="native")throw Error("Unsupported native activation routing: Headroom is not a CLI-supported adapter; no native fallback");
 const allowed=["version","enabled","routing","fffPath","skillPaths","concurrency","threads","slots","pending","persist","schedules","workflows","profileOwner","maxTokens","maxCost","elapsedMs"];
 if(Object.keys(input).some(key=>!allowed.includes(key)))throw Error("unsupported native configuration key");
 const caps={concurrency:input.concurrency??3,threads:input.threads??16,slots:input.slots??32,pending:input.pending??32};
 if(Object.entries(caps).some(([key,value])=>!Number.isSafeInteger(value)||value<1||value>(key==="threads"?16:32)))throw Error("invalid native caps");
 for(const key of ["persist","schedules","workflows"])if(input[key]!==undefined&&typeof input[key]!=="boolean")throw Error("invalid native feature flag");
 for(const[key,maximum]of[["maxTokens",1e9],["maxCost",1e6],["elapsedMs",3600000]]as const)if(input[key]!==undefined&&(!Number.isFinite(input[key])||input[key]<=0||input[key]>maximum||(key!=="maxCost"&&!Number.isSafeInteger(input[key]))))throw Error("invalid native observed budget");
 if(input.fffPath!==undefined&&(typeof input.fffPath!=="string"||!isAbsolute(input.fffPath)))throw Error("absolute approved FFF path required");
 if(input.skillPaths!==undefined&&(!input.skillPaths||typeof input.skillPaths!=="object"||Array.isArray(input.skillPaths)||Object.entries(input.skillPaths).some(([name,path])=>!["mermaid","teach","code-review"].includes(name)||typeof path!=="string"||!isAbsolute(path))))throw Error("approved named skill paths required");
 return {...input,...caps,persist:input.persist??false,schedules:input.schedules??false,workflows:input.workflows??false,skillPaths:input.skillPaths??{}};
}
