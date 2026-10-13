export function createBoundedQueue(limit=1){
 const active=new Map(),pending=[];
 const start=item=>{active.set(item.id,item);let released=false;const release=()=>{if(released)return;released=true;active.delete(item.id);pump();};try{item.start(release);}catch(error){release();item.onError?.(error);}};
 const pump=()=>{while(active.size<limit&&pending.length)start(pending.shift());};
 return {submit(item){if(active.has(item.id)||pending.some(x=>x.id===item.id))return {status:'duplicate'};if(active.size>=limit){pending.push(item);return {status:'queued',queuePosition:pending.length};}start(item);return {status:'running'};},cancel(id){const at=pending.findIndex(x=>x.id===id);if(at<0)return false;pending.splice(at,1);return true;},pending:()=>pending.map(x=>x.id),active:()=>[...active.keys()],pump};
}
const devices=new Map();
export function deviceQueue(root){if(!devices.has(root))devices.set(root,createBoundedQueue(1));return devices.get(root);}
