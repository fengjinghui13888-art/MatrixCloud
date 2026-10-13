// @vitest-environment node
import {createServer} from 'node:http';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import request from 'supertest';import {it,expect} from 'vitest';
import {createGreyApp} from '../grey-app';import {createStore} from '../store';import {executionRequestAllowed,executionToken,withExecutionAccess} from '../execution-access';
// @ts-ignore same client shipped with connector
import {startCloudChannel} from '../../../local-connector/cloud-channel.mjs';
const listen=(s:ReturnType<typeof createServer>)=>new Promise<number>(r=>s.listen(0,'127.0.0.1',()=>r((s.address() as any).port)));
it('customer login uses only the paired customer computer and saves account binding in that workspace',async()=>{
 const root=mkdtempSync(join(tmpdir(),'customer-delivery-'));const token='fixture-owner-token-with-at-least-32-characters';
 const app=createGreyApp(createStore(join(root,'operations.sqlite')),token,{authDataDir:root,modelDataDir:root});
 const web=createServer(app);app.locals.connectorChannel.attach(web);const port=await listen(web);
 const calls:string[]=[];const local=createServer((req,res)=>{calls.push(req.url!);res.setHeader('content-type','application/json');
   res.end(JSON.stringify(req.url?.endsWith('/state')?{creatorLoggedIn:true,webLoggedIn:true,handle:'123456',webHandle:'123456',name:'Customer account',followers:9}:req.url?.endsWith('/image')?{data:Buffer.from('png').toString('base64')}:{ok:true,version:4,capabilities:['device-queue','stop-ack','passive-state','paced-actions']}));
 });const localPort=await listen(local);let stop=()=>{};
 const post=(path:string,cookie='')=>request(web).post('/api/'+path).set('Host','127.0.0.1:'+port).set('Origin','http://127.0.0.1:'+port).set('Cookie',cookie);
 const cookie=(r:any)=>r.headers['set-cookie'][0].split(';')[0];
 try{
   const owner=cookie(await post('auth/setup').send({username:'owner',password:'fixture-password-owner'}));
   const customer=cookie(await post('auth/register').send({username:'customer',password:'fixture-password-customer'}));
   const before=await post('xhs/qr-login',customer).send({});expect(before.status).toBe(400);expect(before.body.message).toContain('配对');expect(calls).toEqual([]);
   const paired=await post('connector/pairings',customer).send({});expect(paired.status).toBe(201);
   const reg=await post('connector/register').send({code:paired.body.code,deviceName:'customer-pc',platform:'darwin',version:'3.0.0'});expect(reg.status).toBe(201);
   await new Promise<void>((resolve,reject)=>{stop=startCloudChannel({...reg.body,cloudUrl:'http://127.0.0.1:'+port},{port:localPort,token:'local',onStatus:(s:string)=>{if(s==='connected')resolve();},onError:reject});});
   const started=await post('xhs/qr-login',customer).send({});expect(started.body.status).toBe('waiting_scan');
   const poll=await request(web).get('/api/xhs/qr-login/'+started.body.id).set('Cookie',customer);expect(poll.body.status).toBe('authenticated');
   expect((await request(web).get('/api/accounts').set('Cookie',customer)).body).toMatchObject([{handle:'123456',name:'Customer account'}]);
   expect((await request(web).get('/api/accounts').set('Cookie',owner)).body).toEqual([]);
   expect((await request(web).get('/api/connector/devices').set('Cookie',customer)).body.devices[0].executionReady).toBe(true);
   expect((await request(web).get('/api/accounts').set('Authorization','Bearer '+reg.body.deviceToken)).status).toBe(401);
   expect((await post('connector/devices/'+reg.body.deviceId+'/revoke',owner).send({})).status).toBe(404);
   expect((await post('connector/devices/'+reg.body.deviceId+'/revoke',customer).send({})).status).toBe(200);
   const offline=await request(web).get('/api/local-connector/status').set('Cookie',customer);expect(offline.body.ok).toBe(false);
 }finally{stop();await new Promise<void>(r=>web.close(()=>r()));await new Promise<void>(r=>local.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});
it('draft device credentials are scoped to the specified task and immediately stop on revocation',()=>{
 let credential='',valid=true;withExecutionAccess('customer',()=>{credential=executionToken({taskId:'task-a',accountId:'account-a',valid:()=>valid})!;});
 expect(executionRequestAllowed(credential,'POST','/api/studio/task-a/receipt')).toBe(true);
 expect(executionRequestAllowed(credential,'POST','/api/studio/task-b/receipt')).toBe(false);
 expect(executionRequestAllowed(credential,'POST','/api/model-settings')).toBe(false);
 expect(executionRequestAllowed(credential,'POST','/api/accounts/bulk-delete')).toBe(false);
 valid=false;expect(executionRequestAllowed(credential,'POST','/api/studio/task-a/receipt')).toBe(false);
});
