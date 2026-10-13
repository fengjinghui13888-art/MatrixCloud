// @vitest-environment node
import express from 'express';
import request from 'supertest';
import {mkdtempSync,statSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {it,expect,afterEach} from 'vitest';
import {createConnectorPairing,connectorPairingRoutes} from '../connector-pairing';
const roots:string[]=[];const db=()=>{const root=mkdtempSync(join(tmpdir(),'pairing-flow-'));roots.push(root);return join(root,'pairing.sqlite');};
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
function setup(){const file=db(),pairing=createConnectorPairing(file),app=express();app.use(express.json());connectorPairingRoutes(app,pairing,{user:req=>req.header('x-user')??null,workspace:req=>req.header('x-user')??null,sameOrigin:req=>req.header('origin')==='http://127.0.0.1'});return {app,pairing,file};}
it('registers once, keeps secrets hashed, heartbeats and revokes all credential access',async()=>{
 const {app,pairing,file}=setup();
 const created=await request(app).post('/api/connector/pairings').set('Host','127.0.0.1').set('x-user','customer').set('Origin','http://127.0.0.1').send({});
 expect(created.status).toBe(201);expect(created.body).toMatchObject({status:'pending',expiresInSeconds:300});
 const input={code:created.body.code,deviceName:'客户 | 电脑',platform:'darwin',version:'3.0.0'};
 const registered=await request(app).post('/api/connector/register').set('Host','127.0.0.1').send(input);
 expect(registered.status).toBe(201);const {deviceId,deviceToken}=registered.body;
 expect(pairing.devices('customer')[0]).toMatchObject({name:'客户 | 电脑',online:false});
 expect((await request(app).post('/api/connector/register').set('Host','127.0.0.1').send(input)).status).toBe(409);
 expect(readFileSync(file).includes(Buffer.from(deviceToken))).toBe(false);
 if(process.platform!=='win32')expect(statSync(file).mode&0o777).toBe(0o600); // POSIX modes do not represent Windows ACLs.
 expect((await request(app).post('/api/connector/heartbeat').set('Host','127.0.0.1').set('Authorization','Bearer '+deviceToken)).status).toBe(200);
 expect(pairing.devices('customer')[0].online).toBe(true);
 expect(pairing.devices('other')).toEqual([]);
 expect((await request(app).get('/api/connector/pairings/'+created.body.id).set('x-user','other')).status).toBe(404);
 expect((await request(app).post('/api/connector/devices/'+deviceId+'/revoke').set('x-user','other').set('Origin','http://127.0.0.1')).status).toBe(404);
 pairing.revoke(deviceId,'customer');expect(pairing.workspaceOfToken(deviceToken)).toBeNull();
 expect((await request(app).post('/api/connector/heartbeat').set('Host','127.0.0.1').set('Authorization','Bearer '+deviceToken)).status).toBe(401);
});
it('expires codes, cancels superseded codes, persists restart, limits attempts and requires TLS',async()=>{
 let stamp=Date.now();const file=db(),p=createConnectorPairing(file,{now:()=>stamp});
 const first=p.create('a'),second=p.create('a');expect(p.pairingStatus(first.id,'a').status).toBe('cancelled');stamp+=300001;
 expect(()=>p.register(second.code,'test','win32','3.0.0')).toThrow('已过期');
 const third=p.create('a');const restarted=createConnectorPairing(file,{now:()=>stamp});const d=restarted.register(third.code,'a','linux','3.0.0');
 expect(restarted.workspaceOfToken(d.deviceToken)).toBe('a');
 for(let i=0;i<10;i++){try{p.register('00000000','a','linux','3.0.0','attacker');}catch{}}
 expect(()=>p.register('00000000','a','linux','3.0.0','attacker')).toThrow('频繁');
 const {app}=setup();const denied=await request(app).post('/api/connector/register').set('Host','public.test').set('X-Forwarded-Proto','https').send({});expect(denied.status).toBe(426);expect(denied.headers['cache-control']).toBe('no-store');
 expect((await request(app).get('/api/connector/devices')).status).toBe(401);
});
it('atomically consumes a code under two independent Node processes',async()=>{
 const file=db(),p=createConnectorPairing(file),code=p.create('a').code;
 const source=`import {createConnectorPairing} from './server/connector-pairing.ts';try{createConnectorPairing(process.argv[1]).register(process.argv[2],'device','darwin','3.0.0');process.exitCode=0;}catch{process.exitCode=2;}`;
 const run=()=>new Promise<number|null>((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source,file,code],{stdio:'ignore'});child.once('error',reject);child.once('exit',resolve);});
 expect((await Promise.all([run(),run()])).sort()).toEqual([0,2]);expect(p.devices('a')).toHaveLength(1);
});

it('hides revoked devices and never silently switches an invalid browser selection',async()=>{
 const {app,pairing}=setup();
 const first=pairing.register(pairing.create('customer').code,'旧电脑','darwin','4.0.0');
 const second=pairing.register(pairing.create('customer').code,'另一位成员','win32','4.0.0');
 const cookie='matrix_execution_device='+encodeURIComponent('customer:'+first.deviceId);
 const revoked=await request(app).post('/api/connector/devices/'+first.deviceId+'/revoke').set('x-user','customer').set('Origin','http://127.0.0.1').send({});
 expect(revoked.status).toBe(200);
 const list=await request(app).get('/api/connector/devices').set('x-user','customer').set('Cookie',cookie);
 expect(list.body.devices.map((d:any)=>d.id)).toEqual([second.deviceId]);
 expect(list.body.selectedDeviceId).toBeUndefined();
 expect(pairing.devices('customer')).toHaveLength(2);
});
