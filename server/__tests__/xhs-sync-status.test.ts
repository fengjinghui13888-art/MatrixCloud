import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createXhsSync} from '../xhs-sync';import {createStore} from '../store';
import {BrowserRuns} from '../browser-runs';
test.each(['complete','partial','blocked'])('repeated cancellation preserves a terminal %s result without contacting the computer',async status=>{
 const dir=mkdtempSync(join(tmpdir(),'sync-cancel-terminal-'));
 try{
  mkdirSync(join(dir,'xhs-sync'));
  const job={id:'33333333-3333-3333-3333-333333333333',accountId:'a',profile:'local:a',status,stopConfirmed:status==='blocked',startedAt:'2026-09-17',counts:{notes:6,comments:2,messages:0}};
  writeFileSync(join(dir,'xhs-sync',job.id+'.json'),JSON.stringify(job));
  const remote=vi.fn();const sync=createXhsSync(dir,createStore(join(dir,'ops.sqlite')),remote);
  expect(await sync.cancel(job.id)).toEqual(job);expect(remote).not.toHaveBeenCalled();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('latest sync survives service recreation and remains account scoped',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sync-status-'));mkdirSync(join(dir,'xhs-sync'));
 const job={id:'11111111-1111-1111-1111-111111111111',accountId:'a',status:'partial',startedAt:'2026-01-01',counts:{notes:6,comments:2,messages:11}};
 writeFileSync(join(dir,'xhs-sync',job.id+'.json'),JSON.stringify(job));
 const sync=createXhsSync(dir,createStore(join(dir,'ops.sqlite')));
 expect(await sync.latest('a')).toMatchObject({id:job.id,counts:job.counts});expect(await sync.latest('b')).toBeNull();
});

test('interrupted running jobs become retryable after restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sync-restart-'));mkdirSync(join(dir,'xhs-sync'));
 const job={id:'22222222-2222-2222-2222-222222222222',accountId:'a',status:'running',stage:'media',message:'下载中',startedAt:new Date().toISOString(),counts:{notes:6,comments:2,messages:0}};
 writeFileSync(join(dir,'xhs-sync',job.id+'.json'),JSON.stringify(job));
 const sync=createXhsSync(dir,createStore(join(dir,'ops.sqlite')));
 expect(await sync.latest('a')).toMatchObject({status:'blocked',counts:job.counts});
 expect((await sync.latest('a'))?.message).toContain('重启');
});

test('restart interruption releases the stale account lease for a retry',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sync-restart-lease-'));mkdirSync(join(dir,'xhs-sync'));
 const id='44444444-4444-4444-4444-444444444444';
 const job={id,accountId:'a',profile:'local:a',status:'running',stage:'notes',message:'读取中',startedAt:new Date().toISOString(),counts:{notes:0,comments:0,messages:0}};
 writeFileSync(join(dir,'xhs-sync',id+'.json'),JSON.stringify(job));
 const runs=new BrowserRuns(join(dir,'browser-runs.sqlite'));runs.claim('1111',id,job.profile);
 createXhsSync(dir,createStore(join(dir,'ops.sqlite')),undefined,undefined,runs);
 expect(runs.active('1111')).toBeNull();
});

test.each(['status','latest'])('a %s receipt releases a blocked account only after a confirmed stop',async lookup=>{
 const dir=mkdtempSync(join(tmpdir(),'sync-stop-receipt-'));mkdirSync(join(dir,'xhs-sync'));
 try{
  const id='55555555-5555-5555-5555-555555555555';
  const job={id,accountId:'a',profile:'local:a',status:'blocked',stage:'blocked',message:'fixture failure',startedAt:new Date().toISOString(),counts:{notes:2,comments:0,messages:0},stopConfirmed:false};
  const path=join(dir,'xhs-sync',id+'.json');writeFileSync(path,JSON.stringify(job));
  const runs=new BrowserRuns(join(dir,'browser-runs.sqlite'));runs.claim('1111',id,job.profile);
  const sync=createXhsSync(dir,createStore(join(dir,'ops.sqlite')),undefined,undefined,runs);
  await (lookup==='status'?sync.status(id):sync.latest('a'));expect(runs.active('1111')?.id).toBe(id);
  writeFileSync(path,JSON.stringify({...job,stopConfirmed:true}));
  await (lookup==='status'?sync.status(id):sync.latest('a'));expect(runs.active('1111')).toBeNull();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a durable blocked progress acknowledgement releases its lease and preserves the failed result',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sync-stop-progress-'));
 try{
  const id='66666666-6666-6666-6666-666666666666';
  let receipt={id,accountId:'a',profile:'local:a',status:'blocked',stage:'blocked',message:'fixture failure',startedAt:new Date().toISOString(),counts:{notes:2,comments:0,messages:0},stopConfirmed:false};
  const durable={update:async(_id:string,patch:any)=>(receipt={...receipt,stopConfirmed:patch.stopConfirmed===true}),read:async()=>receipt,latest:async()=>receipt} as any;
  const runs=new BrowserRuns(join(dir,'browser-runs.sqlite'));runs.claim('1111',id,receipt.profile);
  const sync=createXhsSync(dir,createStore(join(dir,'ops.sqlite')),undefined,durable,runs);
  const result=await sync.update!(id,{stopConfirmed:true} as any);
  expect(result).toMatchObject({status:'blocked',message:'fixture failure',counts:{notes:2},stopConfirmed:true});
  expect(runs.active('1111')).toBeNull();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test.each([false,true])('cancellation of an existing blocked result requires an explicit stop acknowledgement (%s)',async stopConfirmed=>{
 const dir=mkdtempSync(join(tmpdir(),'sync-blocked-cancel-'));mkdirSync(join(dir,'xhs-sync'));
 try{
  const id='88888888-8888-8888-8888-888888888888';
  const job={id,accountId:'a',profile:'local:a',status:'blocked',stage:'blocked',message:'fixture failure',error:'fixture failure',finishedAt:'2026-10-07T00:00:00Z',startedAt:'2026-10-06T00:00:00Z',counts:{notes:2,comments:0,messages:0},stopConfirmed:false};
  writeFileSync(join(dir,'xhs-sync',id+'.json'),JSON.stringify(job));
  const runs=new BrowserRuns(join(dir,'browser-runs.sqlite'));runs.claim('1111',id,job.profile);
  vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({status:'cancelled',stopConfirmed})));
  const sync=createXhsSync(dir,createStore(join(dir,'ops.sqlite')),async()=>({url:'http://fixture.invalid',token:'fixture'}),undefined,runs);
  const result=await sync.cancel(id);
  expect(result).toMatchObject({status:'blocked',error:job.error,counts:job.counts,finishedAt:job.finishedAt,stopConfirmed});
  expect(runs.active('1111')).toEqual(stopConfirmed?null:{id,profile:job.profile});
 }finally{vi.unstubAllGlobals();rmSync(dir,{recursive:true,force:true});}
});

test('a durable terminal progress receipt notifies subscribers once after releasing lease',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sync-terminal-notify-'));
 try{
  const job={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',accountId:'a',profile:'local:a',status:'running',stage:'notes',startedAt:'now',counts:{notes:0,comments:0,messages:0}};
  let receipt:any=job;const durable={update:async(_id:string,patch:any)=>(receipt={...receipt,...patch}),read:async()=>receipt} as any;
  const runs=new BrowserRuns(join(dir,'browser-runs.sqlite'));runs.claim('h',job.id,job.profile);
  const sync=createXhsSync(dir,createStore(join(dir,'ops.sqlite')),undefined,durable,runs);
  const seen:any[]=[];sync.onTerminal(async state=>{expect(runs.active('h')).toBeNull();seen.push(state);});
  await sync.update!(job.id,{status:'partial',finishedAt:'done'});await sync.update!(job.id,{status:'partial',finishedAt:'done'});
  expect(seen).toHaveLength(1);expect(seen[0].finishedAt).toBe('done');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('recent baseline IDs are capped, ordered newest first and written to a private UUID file',async()=>{
 const {recentSyncIds,writeSyncBaseline}=await import('../xhs-sync');const dir=mkdtempSync(join(tmpdir(),'sync-baseline-'));
 try{const ids=recentSyncIds(Array.from({length:10005},(_,n)=>({id:String(n),createdAt:String(n).padStart(8,'0')})));expect(ids).toHaveLength(10000);expect(ids[0]).toBe('10004');expect(ids).not.toContain('0');
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',file=writeSyncBaseline(dir,id,'a',ids,[]);expect(file).toBe(join(dir,id+'.baseline.json'));expect(JSON.parse((await import('node:fs')).readFileSync(file,'utf8'))).toMatchObject({jobId:id,accountId:'a',knownComments:ids,knownMessages:[]});
 expect(()=>writeSyncBaseline(dir,'../outside','a',[],[])).toThrow();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('restarting an event worker keeps its unknown account lease until a confirmed terminal receipt',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'event-restart-lease-'));try{
  mkdirSync(join(dir,'xhs-sync'));const id='cccccccc-cccc-4ccc-8ccc-cccccccccccc',job={id,accountId:'a',profile:'local:p',source:'event',status:'running',stage:'notes',startedAt:'now',counts:{notes:0,comments:0,messages:0}};
  writeFileSync(join(dir,'xhs-sync',id+'.json'),JSON.stringify(job));const runs=new BrowserRuns(join(dir,'runs.sqlite'));runs.claim('h',id,'local:p');const sync=createXhsSync(dir,createStore(join(dir,'ops.sqlite')),undefined,undefined,runs);
  expect(sync.status(id)).toMatchObject({status:'blocked'});expect(runs.active('h')?.id).toBe(id);
  writeFileSync(join(dir,'xhs-sync',id+'.json'),JSON.stringify({...job,status:'blocked',stopConfirmed:true}));sync.status(id);expect(runs.active('h')).toBeNull();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
