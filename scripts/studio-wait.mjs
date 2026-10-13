import {setTimeout as delay} from 'node:timers/promises';

// Browser timers are heavily throttled in hidden Chrome windows. Poll from
// Node so each browser command is short and cannot leave a timed-out loop alive.
export async function waitForSignal(read,ready,{timeout=15000,interval=150,now=Date.now,sleep=delay}={}) {
 const deadline=now()+timeout;
 let actual;
 do {
  actual=await read();
  if(ready(actual))return actual;
  if(now()>=deadline)break;
  await sleep(Math.min(interval,deadline-now()));
 } while(now()<=deadline);
 return actual;
}
