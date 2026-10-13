// @vitest-environment node
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {collectRemote,copyRemoteMedia} from '../../../scripts/remote-sync.mjs';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

function remoteFixture(states,{cancelReceipt={status:'cancelled',stopConfirmed:true}}={}){
 let now=0,poll=0,cancels=0;const progress=[];
 vi.spyOn(Date,'now').mockImplementation(()=>now);
 vi.stubGlobal('fetch',async(url,{method}={})=>{
  if(method==='POST'){
   if(String(url).endsWith('/cancel')){cancels++;return new Response(JSON.stringify(cancelReceipt));}
   return new Response(JSON.stringify({status:states[0].status}));
  }
  if(String(url).endsWith('/result'))return new Response(JSON.stringify({account:{id:'fixture'},notes:[],comments:[],messages:[]}));
  const state=states[Math.min(poll++,states.length-1)];now=state.at;
  return new Response(JSON.stringify(state));
 });
 const run=()=>collectRemote({base:'http://fixture.invalid',token:'fixture',jobId:'fixture',target:{id:'fixture',handle:'fixture',profile:'local:fixture'},pollMs:0,onProgress:async p=>progress.push(p)});
 return {run,progress,cancels:()=>cancels};
}

test('queued progress exposes its queue position while the cloud job remains active',async()=>{
 const fixture=remoteFixture([{status:'queued',queuePosition:2,stage:'starting',message:'waiting',at:0},{status:'complete',stage:'finished',at:1}]);
 await fixture.run();
 expect(fixture.progress[0]).toMatchObject({stage:'queued',queuePosition:2,message:'waiting'});
 expect(fixture.progress[1].queuePosition).toBeNull();
});

test('waiting for another account does not consume the next account collection budget',async()=>{
 const minute=60000,fixture=remoteFixture([
  {status:'queued',queuePosition:1,at:7.5*minute},
  {status:'running',stage:'notes',at:7.5*minute},
  {status:'running',stage:'comments',at:8.1*minute},
  {status:'complete',stage:'finished',at:8.5*minute}
 ]);
 expect((await fixture.run()).account.id).toBe('fixture');
 expect(fixture.cancels()).toBe(0);
});

test('an account that never leaves the device queue receives a bounded queue timeout and one cancel',async()=>{
 const fixture=remoteFixture([{status:'queued',queuePosition:1,at:8.1*60000}]);
 await expect(fixture.run()).rejects.toThrow('排队');
 expect(fixture.cancels()).toBe(1);
});

test('a device launch received after the queue deadline does not reset the expired wait budget',async()=>{
 const fixture=remoteFixture([{status:'queued',at:7.5*60000},{status:'running',stage:'notes',at:8.1*60000},{status:'complete',at:8.2*60000}]);
 await expect(fixture.run()).rejects.toThrow('排队');
 expect(fixture.cancels()).toBe(1);
});

test('an active collection still stops after eight minutes and sends one cancel',async()=>{
 const fixture=remoteFixture([{status:'running',stage:'notes',at:8.1*60000}]);
 await expect(fixture.run()).rejects.toThrow('8 分钟');
 expect(fixture.cancels()).toBe(1);
});

test('a blocked device receipt carries its confirmed stop to the cloud',async()=>{
 const fixture=remoteFixture([{status:'blocked',stage:'blocked',message:'fixture failure',stopConfirmed:true,at:0}]);
 await expect(fixture.run()).rejects.toThrow('fixture failure');
 expect(fixture.progress[0]).toMatchObject({stage:'blocked',stopConfirmed:true});
});

test('a completed device receipt preserves its stop confirmation while the cloud can continue saving',async()=>{
 const fixture=remoteFixture([{status:'running',stage:'notes',at:0},{status:'complete',stage:'finished',stopConfirmed:true,at:1}]);
 await fixture.run();
 expect(fixture.progress.at(-1)).toMatchObject({stage:'finished',stopConfirmed:true});
 expect(fixture.cancels()).toBe(0);
});

test('a later cancellation acknowledgement is reported without reopening a blocked collection',async()=>{
 const fixture=remoteFixture([{status:'blocked',stage:'blocked',message:'fixture failure',stopConfirmed:false,at:0}]);
 await expect(fixture.run()).rejects.toThrow('fixture failure');
 expect(fixture.progress.some(p=>p.stopConfirmed===true)).toBe(true);
 expect(fixture.cancels()).toBe(1);
});
test('cloud receives checkpoint then result and verifies transferred media without browser ports',async()=>{
 const bytes=Buffer.from('fixture-media');const sha256=createHash('sha256').update(bytes).digest('hex');
 const asset={id:'a'.repeat(32),path:'account/2026-09-11/image/note/'+ 'a'.repeat(32)+'.webp',sha256,bytes:bytes.length};
 const snapshot={account:{id:'account',handle:'123',profile:'local:session'},notes:[{id:'note',accountId:'account',mediaAssets:[asset]}],comments:[],messages:[]};
 let polls=0,checkpoint=false;
 const server=createServer((req,res)=>{if(req.headers.authorization!=='Bearer paired'){res.writeHead(401).end();return;}
  if(req.url.endsWith('/media/'+asset.id)){res.end(bytes);return;}
  res.setHeader('content-type','application/json');
  if(req.method==='POST'){res.end('{}');return;}
  if(req.url.endsWith('/result')){res.end(JSON.stringify(snapshot));return;}
  res.end(JSON.stringify({status:++polls===1?'running':'complete',stage:'media',message:'下载',checkpoint:true}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const options={base:'http://127.0.0.1:'+server.address().port,token:'paired',jobId:'11111111-1111-1111-1111-111111111111',target:snapshot.account,pollMs:1};
 try{
  const result=await collectRemote({...options,onCheckpoint:async r=>{checkpoint=true;expect(r.notes).toHaveLength(1);}});
  expect(checkpoint).toBe(true);expect(result.notes[0].id).toBe('note');
  const root=mkdtempSync(join(tmpdir(),'remote-media-'));
  await copyRemoteMedia({...options,result,root});expect(readFileSync(join(root,asset.path))).toEqual(bytes);
  result.notes[0].mediaAssets[0].sha256='0'.repeat(64);
  const badRoot=mkdtempSync(join(tmpdir(),'bad-media-'));
  expect((await copyRemoteMedia({...options,result,root:badRoot})).failed).toBe(1);
  result.notes[0].mediaAssets=[{...asset,path:'../escape'}];
  expect((await copyRemoteMedia({...options,result,root:badRoot})).failed).toBe(1);
 }finally{await new Promise(r=>server.close(r));}
});
