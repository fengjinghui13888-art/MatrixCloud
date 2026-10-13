// Keep browser identity transitions ordered across awaits within one connector owner.
const queues=new Map<string,Promise<unknown>>();
export function serial<T>(key:string,fn:()=>Promise<T>):Promise<T>{
 const before=queues.get(key);
 const next=before?before.catch(()=>{}).then(fn):fn();queues.set(key,next);
 void next.finally(()=>{if(queues.get(key)===next)queues.delete(key);}).catch(()=>{});
 return next;
}
