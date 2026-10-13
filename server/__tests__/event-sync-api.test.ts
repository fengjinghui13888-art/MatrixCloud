// @vitest-environment node
import {createServer} from 'node:http';import {mkdtempSync,readFileSync,readdirSync,existsSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import request from 'supertest';import {createGreyApp} from '../grey-app';import {createStore} from '../store';
// @ts-ignore packaged connector
import {startCloudChannel} from '../../local-connector/cloud-channel.mjs';
const listen=(server:any)=>new Promise<number>(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const waitFor=async(check:()=>Promise<boolean>)=>{const end=Date.now()+12000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw Error('condition timeout');};
test('real WS event ACK, spawned sync worker, import and terminal callback close the queue without UI polling',async()=>{
 const root=mkdtempSync(join(tmpdir(),'event-loop-')),store=createStore(join(root,'ops.sqlite')),token='fixture-event-loop-token-with-32-characters';
 const account={id:'a',name:'fixture',handle:'h',profile:'local:p',avatar:'',state:'connected' as const,followers:0,lastSyncedAt:''};store.addAccount(account);
 const app=createGreyApp(store,token,{authDataDir:root}),web=createServer(app);app.locals.connectorChannel.attach(web);const port=await listen(web);
 const previous={PORT:process.env.PORT,STUDIO_URL:process.env.STUDIO_URL,STUDIO_TOKEN:process.env.STUDIO_TOKEN};process.env.PORT=String(port);process.env.STUDIO_URL=`http://127.0.0.1:${port}`;process.env.STUDIO_TOKEN=token;
 const results=new Map<string,any>();let syncRequests=0,watch:any[]=[];const acks:string[]=[];
 const local=createServer(async(req,res)=>{res.setHeader('content-type','application/json');
  if(req.url?.startsWith('/sync/')){const id=req.url.split('/')[2];if(req.method==='POST'){
   let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);expect(input.mode).toBe('incremental');expect(input.source).toBe('event');syncRequests++;
   results.set(id,{account:{...input.target,lastSyncedAt:new Date().toISOString()},notes:[],comments:[],messages:[{id:'m'+syncRequests,accountId:'a',conversationId:'peer',author:'peer',body:'real transport fixture',createdAt:new Date().toISOString(),direction:'incoming'}],coverage:{messages:'fixture'},evidence:{fixture:true}});res.end(JSON.stringify({status:'running'}));return;
  }res.end(JSON.stringify(req.url.endsWith('/result')?results.get(id):{status:'complete',counts:{notes:0,comments:0,messages:1},checkpoint:false}));return;}
  res.end(JSON.stringify(req.url==='/verify'?{version:4,capabilities:['event-sync','device-queue','stop-ack','passive-state','paced-actions']}:{creatorLoggedIn:true,webLoggedIn:true,handle:'h',webHandle:'h'}));
 });const localPort=await listen(local);let stop:any;
 try{
  const auth={'Authorization':'Bearer '+token};expect((await request(web).get('/api/event-sync')).status).toBe(401);expect((await request(web).post('/api/event-sync').send({enabled:true})).status).toBe(401);
  const login=await request(web).post('/api/auth/setup').set('Origin','http://127.0.0.1:'+port).set('Host','127.0.0.1:'+port).send({username:'owner',password:'fixture-password-owner'});const cookie=(login.headers['set-cookie'] as unknown as string[])?.map((s:string)=>s.split(';')[0]).join('; ')||'';
  const pairing=(await request(web).post('/api/connector/pairings').set('Cookie',cookie).set('Origin','http://127.0.0.1:'+port).set('Host','127.0.0.1:'+port).send({})).body;
  const registration=await request(web).post('/api/connector/register').send({code:pairing.code,deviceName:'fixture',platform:'win32',version:'4.0.0'});expect(registration.status).toBe(201);
  await new Promise<void>((resolve,reject)=>{stop=startCloudChannel({...registration.body,cloudUrl:`http://127.0.0.1:${port}`},{port:localPort,token:'local',onStatus:(s:string)=>s==='connected'&&resolve(),onError:reject,onEventAck:(id:string)=>acks.push(id),onWatch:(s:any)=>watch=s});});
  await app.locals.connectorChannel.bind('owner','local:p',registration.body.deviceId);
  expect((await request(web).post('/api/event-sync').set(auth).send({enabled:true})).status).toBe(200);
  const event={eventId:'11111111-1111-4111-8111-111111111111',profile:'local:p',kind:'messages',fingerprint:'a'.repeat(64)};await stop.sendEvent(event);
  await waitFor(async()=>acks.includes(event.eventId));await waitFor(async()=>store.listMessages().length===1);
  await waitFor(async()=>JSON.parse(readFileSync(join(root,'event-sync.json'),'utf8')).accounts.a.status==='idle');
  expect(syncRequests).toBe(1);expect(JSON.parse(readFileSync(join(root,'event-sync.json'),'utf8')).accounts.a.lastSyncedAt).toBeTruthy();
  await waitFor(async()=>watch.some(s=>s.knownMessages.includes('m1')));
  expect(readdirSync(join(root,'xhs-sync')).filter(name=>name.endsWith('.baseline.json'))).toEqual([]);
 }catch(error){console.log('fixture queue',readFileSync(join(root,'event-sync.json'),'utf8'));if(existsSync(join(root,'xhs-sync')))for(const file of readdirSync(join(root,'xhs-sync')).filter(f=>f.endsWith('.json')))console.log('fixture job',readFileSync(join(root,'xhs-sync',file),'utf8'));throw error;}finally{stop?.();await new Promise<void>(r=>local.close(()=>r()));await new Promise<void>(r=>web.close(()=>r()));for(const [name,value]of Object.entries(previous)){if(value===undefined)delete process.env[name];else process.env[name]=value;}rmSync(root,{recursive:true,force:true});}
},20000);





test('event-sync settings and account status stay inside the authenticated customer workspace',async()=>{
 const root=mkdtempSync(join(tmpdir(),'event-api-scope-')),store=createStore(join(root,'ops.sqlite')),token='fixture-api-scope-token-at-least-32-characters';
 store.addAccount({id:'owner-only',name:'owner',handle:'owner',profile:'local:owner',avatar:'',state:'connected',followers:0,lastSyncedAt:''});
 const app=createGreyApp(store,token,{authDataDir:root});
 const post=(path:string)=>request(app).post(path).set('Host','localhost').set('Origin','http://localhost');
 const cookie=(r:any)=>r.headers['set-cookie']?.map((s:string)=>s.split(';')[0]).join('; ')||'';
 try{
  const owner=cookie(await post('/api/auth/setup').send({username:'owner',password:'fixture-password-owner'}));
  const other=cookie(await post('/api/auth/register').send({username:'other',password:'fixture-password-other'}));
  expect((await post('/api/event-sync').set('Cookie',owner).send({enabled:true})).body.enabled).toBe(true);
  const status=await request(app).get('/api/event-sync').set('Cookie',other);expect(status.status).toBe(200);expect(status.body).toMatchObject({enabled:false,accounts:[]});
  await post('/api/event-sync').set('Cookie',other).send({enabled:false});
  const ownerStatus=await request(app).get('/api/event-sync').set('Cookie',owner);expect(ownerStatus.body.enabled).toBe(true);expect(ownerStatus.body.accounts.map((a:any)=>a.accountId)).toEqual(['owner-only']);
 }finally{rmSync(root,{recursive:true,force:true});}
});


test('more than 100 profiles on a device returns and persists paused capacity status instead of silently losing watch',async()=>{
 const root=mkdtempSync(join(tmpdir(),'event-watch-capacity-')),store=createStore(join(root,'ops.sqlite')),token='fixture-capacity-token-at-least-32-characters';
 try{
  for(let n=0;n<101;n++)store.addAccount({id:'a'+n,name:'a'+n,handle:'h'+n,profile:'local:p'+n,avatar:'',state:'connected',followers:0,lastSyncedAt:''});
  const app=createGreyApp(store,token,{modelDataDir:root}),channel=app.locals.connectorChannel;const watches:any[]=[];
  channel.binding=async()=> 'device';channel.online=async()=>true;channel.watch=(_device:string,subscriptions:any[])=>watches.push(subscriptions);
  const response=await request(app).post('/api/event-sync').set('Authorization','Bearer '+token).send({enabled:true});
  expect(response.status).toBe(200);expect(response.body.accounts).toHaveLength(101);expect(response.body.accounts.every((a:any)=>a.status==='paused'&&a.message.includes('容量'))).toBe(true);expect(watches).toEqual([[]]);
  const saved=JSON.parse(readFileSync(join(root,'event-sync.json'),'utf8'));expect(saved.accounts.a0.status).toBe('paused');
 }finally{rmSync(root,{recursive:true,force:true});}
});
