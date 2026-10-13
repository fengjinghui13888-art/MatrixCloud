// @vitest-environment node
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import request from 'supertest';
import {it,expect,vi} from 'vitest';
import {createGreyApp} from '../grey-app';
import {createStore} from '../store';
import {createStudio} from '../studio';
import {finishStudioExecution} from '../studio-execution';
// @ts-ignore actual client shipped to customers
import {startCloudChannel} from '../../local-connector/cloud-channel.mjs';
const listen=(s:ReturnType<typeof createServer>)=>new Promise<number>(resolve=>s.listen(0,'127.0.0.1',()=>resolve((s.address() as any).port)));
it('keeps browser device selections independent and verifies a fresh Windows login before moving a Mac account',async()=>{
 const root=mkdtempSync(join(tmpdir(),'device-switch-'));
 const app=createGreyApp(createStore(join(root,'operations.sqlite')),'fixture-owner-token-with-at-least-32-characters',{authDataDir:root,modelDataDir:root});
 const web=createServer(app);app.locals.connectorChannel.attach(web);const port=await listen(web);
 const calls:{computer:string;path:string}[]=[];let handle='123456';
 const previousEnv={PORT:process.env.PORT,STUDIO_URL:process.env.STUDIO_URL,DATA_DIR:process.env.DATA_DIR,STUDIO_TOKEN:process.env.STUDIO_TOKEN,CUSTOMER_PUBLIC_ORIGIN:process.env.CUSTOMER_PUBLIC_ORIGIN};
 process.env.PORT=String(port);process.env.STUDIO_URL='http://127.0.0.1:'+port;process.env.DATA_DIR=root;
 process.env.STUDIO_TOKEN='fixture-studio-token';process.env.CUSTOMER_PUBLIC_ORIGIN='http://127.0.0.1:'+port;
 let draftId='';
 const locals:ReturnType<typeof createServer>[]=[];const stops:(()=>void)[]=[];
 const post=(path:string,cookie='')=>request(web).post('/api/'+path).set('Host','127.0.0.1:'+port).set('Origin','http://127.0.0.1:'+port).set('Cookie',cookie);
 const get=(path:string,cookie:string)=>request(web).get('/api/'+path).set('Cookie',cookie);
 const cookie=(r:any)=>r.headers['set-cookie']?.map((v:string)=>v.split(';')[0]).join('; ')??'';
 try{
  const auth=cookie(await post('auth/setup').send({username:'owner',password:'fixture-password-owner'}));
  const other=cookie(await post('auth/register').send({username:'other',password:'fixture-password-other'}));
  async function computer(name:string){
   const results=new Map<string,any>();
   const local=createServer(async(req,res)=>{
    calls.push({computer:name,path:req.url!});res.setHeader('content-type','application/json');
    if(req.url?.startsWith('/sync/')){
     const id=req.url.split('/')[2];
     if(req.method==='POST'&&!req.url.endsWith('/cancel')){
      let raw='';for await(const chunk of req)raw+=chunk;const {target}=JSON.parse(raw);
      results.set(id,{account:{...target,state:'connected',lastSyncedAt:new Date().toISOString()},notes:[{id:'note-from-windows',accountId:target.id,title:'Collected on '+name,summary:'Fixture data transported through the real customer channel',cover:null,url:null,publishedAt:'2026-09-17',metrics:{likes:1,collects:0,comments:0,shares:0}}],comments:[],messages:[],coverage:{notes:'fixture'},evidence:{computer:name}});
     }
     res.end(JSON.stringify(req.url.endsWith('/result')?results.get(id):{status:'complete',stage:'finished',counts:{notes:1,comments:0,messages:0}}));return;
    }
    res.end(JSON.stringify(req.url?.endsWith('/state')?{creatorLoggedIn:true,webLoggedIn:true,handle,webHandle:handle,name:'Real fixture account'}:{ok:true,version:4,capabilities:['device-queue','stop-ack','passive-state','paced-actions']}));
   });
   locals.push(local);const localPort=await listen(local);
   const pair=await post('connector/pairings',auth).send({});
   const reg=await post('connector/register').send({code:pair.body.code,deviceName:name,platform:name==='Windows'?'win32':'darwin',version:'3.0.1'});
   expect(reg.status).toBe(201);
   await new Promise<void>((resolve,reject)=>{stops.push(startCloudChannel({...reg.body,cloudUrl:'http://127.0.0.1:'+port},{port:localPort,token:'local',onStatus:(s:string)=>{if(s==='connected')resolve();},onError:reject}));});
   return reg.body.deviceId as string;
  }
  const mac=await computer('Mac');const win=await computer('Windows');
  const macChoice=await post('connector/devices/'+mac+'/select',auth).send({});
  const macBrowser=auth+'; '+cookie(macChoice);
  const winChoice=await post('connector/devices/'+win+'/select',auth).send({});
  const winBrowser=auth+'; '+cookie(winChoice);
  expect((await get('connector/devices',macBrowser)).body.selectedDeviceId).toBe(mac);
  expect((await get('connector/devices',winBrowser)).body.selectedDeviceId).toBe(win);
  // A browser without a choice must not borrow another browser's choice.
  const unknown=await post('xhs/qr-login',auth).send({});expect(unknown.status).toBe(400);expect(calls).toEqual([]);
  const start=await post('xhs/qr-login',macBrowser).send({});expect(start.body.deviceId).toBe(mac);
  const verified=await get('xhs/qr-login/'+start.body.id,macBrowser);expect(verified.body.status).toBe('authenticated');
  const account=verified.body.account;calls.length=0;
  const studio=createStudio(join(root,'studio.sqlite'));
  let draft=studio.create({accountId:account.id,topic:'fixture',persona:'',style:'',imageCount:1,size:'1024x1536',requestId:'fixture-device-draft',confirmCharge:true}).task;
  draft=studio.update(draft.id,draft.revision,{status:'approved',title:'Fixture draft',body:'Fixture content',tags:[],images:['https://example.com/image.png']});draftId=draft.id;
  const wrongDraft=await post('studio/'+draft.id+'/execute',winBrowser).send({});expect(wrongDraft.status).toBe(409);expect(wrongDraft.body.message).toContain('账号矩阵');expect(calls).toEqual([]);
  const move=await post('accounts/'+account.id+'/sync',winBrowser).send({});
  expect(move.status).toBe(202);expect(move.body.loginRequired).toBe(true);expect(move.body.loginJob.deviceId).toBe(win);
  expect(calls.filter(c=>c.path.endsWith('/login')).map(c=>c.computer)).toEqual(['Windows']);
  expect(calls.every(c=>c.computer==='Windows')).toBe(true);
  expect((await get('accounts',winBrowser)).body[0].profile).toBe(account.profile);
  handle='different-account';
  const mismatch=await get('xhs/qr-login/'+move.body.loginJob.id,winBrowser);expect(mismatch.body.status).toBe('failed');
  expect((await get('accounts',winBrowser)).body[0].profile).toBe(account.profile);
  handle='123456';
  const retry=await post('accounts/'+account.id+'/sync',winBrowser).send({});
  const success=await get('xhs/qr-login/'+retry.body.loginJob.id,winBrowser);expect(success.body.status).toBe('authenticated');
  const moved=(await get('accounts',winBrowser)).body[0];expect(moved.profile).not.toBe(account.profile);expect(moved.executionDevice.id).toBe(win);
  calls.length=0;
  const synced=await post('accounts/'+account.id+'/sync',winBrowser).send({deviceId:win});expect(synced.status).toBe(201);
  let state:any;const deadline=Date.now()+10000;
  do{await new Promise(r=>setTimeout(r,100));state=(await get('accounts/'+account.id+'/sync/'+synced.body.id,winBrowser)).body;}while(state.status==='running'&&Date.now()<deadline);
  expect(state.status,state.message).toBe('partial');expect(state.counts.notes).toBe(1);
  expect((await get('operations',winBrowser)).body.notes[0].title).toBe('Collected on Windows');
  expect(calls.some(c=>c.path.startsWith('/sync/'))).toBe(true);expect(calls.every(c=>c.computer==='Windows')).toBe(true);
  calls.length=0;
  const correctDraft=await post('studio/'+draft.id+'/execute',winBrowser).send({});expect(correctDraft.status).toBe(200);
  await vi.waitFor(()=>expect(calls.some(c=>c.path==='/studio'&&c.computer==='Windows')).toBe(true));expect(calls.every(c=>c.computer==='Windows')).toBe(true);finishStudioExecution(draft.id);
  expect((await post('xhs/qr-login',other).send({deviceId:win})).status).toBe(400);
  calls.length=0;
  stops[1]();await new Promise(r=>setTimeout(r,100));
  const disconnected=await post('accounts/'+account.id+'/sync',winBrowser).send({});expect(disconnected.status).toBe(400);expect(disconnected.body.message).toContain('离线');expect(calls).toEqual([]);
  await post('connector/devices/'+win+'/revoke',winBrowser).send({});
  const offline=await post('accounts/'+account.id+'/sync',winBrowser).send({});expect(offline.status).toBe(400);expect(calls).toEqual([]);
 }finally{if(draftId)finishStudioExecution(draftId);stops.forEach(stop=>stop());await new Promise<void>(r=>web.close(()=>r()));for(const s of locals)await new Promise<void>(r=>s.close(()=>r()));for(const [key,value]of Object.entries(previousEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}rmSync(root,{recursive:true,force:true});}
},30000);
