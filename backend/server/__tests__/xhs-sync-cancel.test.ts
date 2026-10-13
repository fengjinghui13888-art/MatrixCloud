import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';import {createXhsSync,type XhsSyncJob} from '../xhs-sync';import {BrowserRuns} from '../browser-runs';
vi.mock('node:child_process',async importOriginal=>{const actual=await importOriginal<any>(),fake=vi.fn();return {...actual,spawn:fake,default:{...actual.default,spawn:fake}};});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

test.each(['saving','media'] as const)('cancelling cloud %s still stops its worker after the device confirmed collection has stopped',async stage=>{
 const dir=mkdtempSync(join(tmpdir(),'sync-cloud-cancel-'));
 const child=Object.assign(new EventEmitter(),{kill:vi.fn(()=>true)});vi.mocked(spawn).mockReturnValue(child as any);
 let receipt:XhsSyncJob|null=null;
 const durable={latest:async()=>receipt,read:async()=>receipt,create:async(state:XhsSyncJob)=>{receipt=state;return {state,fresh:true};},update:async(_id:string,patch:Partial<XhsSyncJob>)=>{receipt={...receipt!,...patch};return receipt;}} as any;
 const account={id:'fixture',profile:'local:fixture',handle:'fixture',name:'fixture'};
 const remote=async()=>({url:'http://fixture.invalid',token:'fixture'});
 const fetcher=vi.fn(async()=>{throw Error('device has already confirmed stopping');});vi.stubGlobal('fetch',fetcher);
 try{
  const runs=new BrowserRuns(join(dir,'browser-runs.sqlite'));
  const sync=createXhsSync(dir,{listAccounts:async()=>[account]} as any,remote,durable,runs);
  const job=await sync.start(account.id,account.profile);
  await sync.update!(job.id,{stage,stopConfirmed:true,counts:{notes:3,comments:0,messages:0}});
  expect(runs.active(account.handle)?.id).toBe(job.id);
  const stopped=await sync.cancel(job.id);
  expect(stopped).toMatchObject({status:'blocked',stage:'blocked',stopConfirmed:true,counts:{notes:3,comments:0,messages:0}});
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');expect(fetcher).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(join(dir,'xhs-sync',job.id+'.json'),'utf8'))).toMatchObject({status:'blocked',stopConfirmed:true});
  expect(runs.active(account.handle)).toBeNull();
 }finally{child.emit('exit',null);await new Promise(resolve=>setImmediate(resolve));rmSync(dir,{recursive:true,force:true});}
});
