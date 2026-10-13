// Serialize browser operations for one account, without blocking other accounts.
export function createSessionQueue(){
 const pending=new Map();
 return async(id,operation)=>{
  const before=pending.get(id)||Promise.resolve();
  const task=before.catch(()=>{}).then(operation);pending.set(id,task);
  try{return await task;}finally{if(pending.get(id)===task)pending.delete(id);}
 };
}
