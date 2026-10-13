import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function createWorkspaceScope(root?:string){
  const context=new AsyncLocalStorage<string>();
  function scoped<T extends object>(owner:T,factory:(dir:string)=>T):T{
    const cache=new Map<string,T>();
    return new Proxy(owner,{get(_target,key){
      const id=context.getStore();let target=owner;
      if(root&&id&&id!=='owner'){
        if(!/^[a-f0-9-]{36}$/.test(id))throw Error('无效工作区');
        if(!cache.has(id)){const dir=join(root,'workspaces',id);mkdirSync(dir,{recursive:true,mode:0o700});cache.set(id,factory(dir));}
        target=cache.get(id)!;
      }
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
  }
  return {scoped,current:()=>context.getStore()??'owner',run:<T>(id:string,next:()=>T)=>context.run(id,next)};
}
