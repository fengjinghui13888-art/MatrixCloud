import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createEventSync} from '../event-sync';
const event=(n:number,kind='comments')=>({eventId:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,profile:'local:p',kind,fingerprint:String(n%10).repeat(64)});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'event-sync-'));let bound='d',connected=true,busy=false;
 const account={id:'a',profile:'local:p',handle:'h'};const jobs=new Map<string,any>();const subscribers=new Set<any>();let launched=0;
 const sync={start:async()=>{launched++;const j={id:`job-${launched}`,accountId:'a',profile:'local:p',status:'running'};jobs.set(j.id,j);return j;},status:async(id:string)=>jobs.get(id),onTerminal:(fn:any)=>{subscribers.add(fn);return()=>subscribers.delete(fn);}};
 const channel={binding:async()=>bound,online:async()=>connected,json:async(_w:any,_d:any,_m:any,path:string)=>path==='/verify'?{version:4,capabilities:['event-sync','stop-ack']}:{creatorLoggedIn:true,webLoggedIn:true,handle:'h',webHandle:'h'}};
 const opts={dir,workspace:'w',accounts:[account],xhsSync:sync,connectorChannel:channel,isBusy:()=>busy};const queue=createEventSync(opts);
 return {dir,queue,opts,jobs,account,launched:()=>launched,binding:(v:string)=>bound=v,online:(v:boolean)=>connected=v,busy:(v:boolean)=>busy=v,complete:async(id:string,status='partial',stopConfirmed=true)=>{const job={...jobs.get(id),status,stopConfirmed,finishedAt:'2026-10-13T01:02:03Z'};jobs.set(id,job);await queue.observeCompletion(job);},send:(n:number,kind?:string)=>queue.receive({workspace:'w',deviceId:'d',event:event(n,kind)}),dispose:()=>rmSync(dir,{recursive:true,force:true})};
}
test('serialized concurrent events persist once, complete and drain merged work without new events',async()=>{const f=fixture();try{
 await f.queue.setEnabled(true);await Promise.all([f.send(1),f.send(1)]);await f.queue.status();await f.send(2,'messages');await f.queue.status();
 expect(f.launched()).toBe(1);expect((await f.queue.status()).accounts[0].lastSyncedAt).toBeUndefined();
 expect(JSON.parse(readFileSync(join(f.dir,'event-sync.json'),'utf8')).accounts.a.inflight.events).toHaveLength(1);
 await f.complete('job-1');expect(f.launched()).toBe(2);await f.complete('job-2');
 const s=(await f.queue.status()).accounts[0];expect(s.status).toBe('idle');expect(s.lastSyncedAt).toBe('2026-10-13T01:02:03Z');expect(s.pendingKinds).toEqual([]);
 const restored=createEventSync(f.opts);expect((await restored.status()).accounts[0].status).toBe('idle');
 }finally{f.dispose();}});
test('busy pending work drains on another job completion and offline work drains on reconnect',async()=>{const f=fixture();try{
 await f.queue.setEnabled(true);f.busy(true);await f.send(3);expect(f.launched()).toBe(0);f.busy(false);
 await f.queue.observeCompletion({id:'manual',accountId:'a',profile:'local:p',status:'partial',finishedAt:'now'});expect(f.launched()).toBe(1);
 await f.complete('job-1');f.online(false);await f.send(4);expect(f.launched()).toBe(1);f.online(true);await f.queue.drainForDevice('d');expect(f.launched()).toBe(2);
 }finally{f.dispose();}});
test('pins workspace and original binding, and disabled events are acknowledged without replay',async()=>{const f=fixture();try{
 expect(await f.send(5)).toBe(true);await f.queue.setEnabled(true);expect(await f.send(5)).toBe(true);expect(f.launched()).toBe(0);
 expect(await f.queue.receive({workspace:'other',deviceId:'d',event:event(6)})).toBe(false);
 f.busy(true);await f.send(6);f.binding('new');f.busy(false);await f.queue.drainForDevice('new');expect(f.launched()).toBe(0);expect((await f.queue.status()).accounts[0].status).toBe('paused');
 }finally{f.dispose();}});
test('unknown terminal and platform stop remain paused, restart reconciles successful receipt',async()=>{const f=fixture();try{
 await f.queue.setEnabled(true);await f.send(7);await f.queue.status();await f.send(8);await f.queue.status();await f.complete('job-1','blocked',false);await f.queue.drainForDevice('d');expect(f.launched()).toBe(1);expect((await f.queue.status()).accounts[0].status).toBe('paused');
 }finally{f.dispose();}
 const g=fixture();try{await g.queue.setEnabled(true);await g.send(9);await g.queue.status();g.jobs.set('job-1',{id:'job-1',accountId:'a',status:'partial',finishedAt:'done'});const restored=createEventSync(g.opts);await restored.drainForDevice('d');expect((await restored.status()).accounts[0].status).toBe('idle');expect(g.launched()).toBe(1);}finally{g.dispose();}});


test('legacy connector capability and a confirmed platform stop never cause automatic retries',async()=>{
 const f=fixture();try{(f.opts.connectorChannel as any).json=async()=>({version:4,capabilities:['stop-ack']});await f.queue.setEnabled(true);await f.send(10);await f.queue.status();expect(f.launched()).toBe(0);expect((await f.queue.status()).accounts[0].status).toBe('paused');}finally{f.dispose();}
 const g=fixture();try{await g.queue.setEnabled(true);await g.send(11);await g.queue.status();await g.complete('job-1','blocked',true);await g.send(12);await g.queue.drainForDevice('d');expect(g.launched()).toBe(1);expect((await g.queue.status()).accounts[0].status).toBe('paused');}finally{g.dispose();}
});

test('pending event hints coalesce by kind and recent acknowledgements stay bounded on disk',async()=>{
 const f=fixture();try{await f.queue.setEnabled(true);f.busy(true);for(let n=1;n<=300;n++)await f.send(n,n%2?'comments':'messages');await f.queue.status();const s=JSON.parse(readFileSync(join(f.dir,'event-sync.json'),'utf8')).accounts.a;expect(s.pending).toHaveLength(2);expect(s.eventIds.length).toBeLessThanOrEqual(256);expect(f.launched()).toBe(0);f.busy(false);await f.queue.drainForDevice('d');expect(f.launched()).toBe(1);}finally{f.dispose();}
});

test('a studio lease release consumes persisted busy hints while an empty release creates no sync',async()=>{
 const f=fixture();const {BrowserRuns}=await import('../browser-runs');const runs=new BrowserRuns(join(f.dir,'runs.sqlite'));
 const queue=createEventSync({...f.opts,isBusy:()=>!!runs.active('h')});runs.onRelease(()=>queue.drainForDevice().then(()=>{}));
 try{
  await queue.setEnabled(true);runs.claim('h','studio-1','local:p');await queue.receive({workspace:'w',deviceId:'d',event:event(21)});await queue.status();
  expect(JSON.parse(readFileSync(join(f.dir,'event-sync.json'),'utf8')).accounts.a.pending).toHaveLength(1);expect(f.launched()).toBe(0);
  runs.release('studio-1');await queue.status();expect(f.launched()).toBe(1);expect(JSON.parse(readFileSync(join(f.dir,'event-sync.json'),'utf8')).accounts.a.inflight.jobId).toBe('job-1');
  f.jobs.set('job-1',{id:'job-1',accountId:'a',status:'partial',finishedAt:'done'});await queue.observeCompletion(f.jobs.get('job-1'));
  runs.claim('h','studio-empty','local:p');runs.release('studio-empty');await queue.status();expect(f.launched()).toBe(1);
  runs.claim('h','unknown','local:p');await queue.receive({workspace:'w',deviceId:'d',event:event(22)});await queue.status();expect(f.launched()).toBe(1);expect(runs.active('h')?.id).toBe('unknown');
 }finally{f.dispose();}
});

test('watch delivery capacity failures persist a visible paused state',async()=>{
 const f=fixture();try{await f.queue.setEnabled(true);await f.queue.pauseAccounts(['a'],'设备超过100个订阅');const restored=createEventSync(f.opts);expect((await restored.status()).accounts[0]).toMatchObject({status:'paused',message:'设备超过100个订阅'});await f.send(33);await f.queue.status();expect(f.launched()).toBe(0);}finally{f.dispose();}
});

test('restart pauses an inflight event when PostgreSQL still says running despite the local interruption record',async()=>{
 const {createXhsSync}=await import('../xhs-sync');const {createStore}=await import('../store');const {mkdirSync,writeFileSync}=await import('node:fs');const f=fixture();
 try{
  const id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',job={id,accountId:'a',profile:'local:p',status:'running',stage:'notes',message:'reading',startedAt:'now',counts:{notes:0,comments:0,messages:0}};
  const opts={...f.opts,start:async()=>job};const queue=createEventSync(opts);await queue.setEnabled(true);await queue.receive({workspace:'w',deviceId:'d',event:event(44)});await queue.status();
  mkdirSync(join(f.dir,'xhs-sync'));writeFileSync(join(f.dir,'xhs-sync',id+'.json'),JSON.stringify(job));
  const durable={read:async()=>job,running:async()=>true} as any;const sync=createXhsSync(f.dir,createStore(join(f.dir,'ops.sqlite')),undefined,durable);
  expect(JSON.parse(readFileSync(join(f.dir,'xhs-sync',id+'.json'),'utf8')).status).toBe('blocked');
  const restored=createEventSync({...opts,xhsSync:sync});expect((await restored.status()).accounts[0].status).toBe('paused');await restored.drainForDevice('d');expect((await restored.status()).accounts[0].message).toContain('核对');
 }finally{f.dispose();}
});

test('an explicit re-enable may resume known stopped work, but never an unknown or platform-blocked job',async()=>{
 const f=fixture();try{await f.queue.setEnabled(true);await f.send(55);await f.queue.status();const stopped={...f.jobs.get('job-1'),status:'blocked',stopConfirmed:true,message:'停止已确认'};f.jobs.set('job-1',stopped);await f.queue.observeCompletion(stopped);expect((await f.queue.status()).accounts[0].status).toBe('paused');await f.queue.setEnabled(false);await f.queue.setEnabled(true);expect(f.launched()).toBe(2);}finally{f.dispose();}
});
