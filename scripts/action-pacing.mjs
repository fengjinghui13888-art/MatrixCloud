import {setTimeout as delay} from 'node:timers/promises';
export function createActionPacer({signal,intervalMs=5000,jitterMs=2000,random=Math.random,wait=delay}={}){
 return async()=>{signal?.throwIfAborted();await wait(intervalMs+Math.floor(random()*jitterMs),undefined,{signal});signal?.throwIfAborted();};
}
