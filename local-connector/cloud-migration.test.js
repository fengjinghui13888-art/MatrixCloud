// @vitest-environment node
import {describe,it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveCloudTarget,registerCloudConnector,loadCloudDevice} from './cloud-client.mjs';
import {reconnectDecision} from './reconnect.mjs';

const roots=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

const device={cloudUrl:'https://old.example',deviceId:'a'.repeat(64),deviceToken:'b'.repeat(64),workspace:'workspace'};

describe('cloud origin migration',()=>{
 it('does not reuse a persisted token when the package points at another origin',()=>{
  expect(resolveCloudTarget({device,cloudUrl:'https://new.example'})).toEqual({
   cloudUrl:'https://new.example',device:null,requiresPairing:true,
  });
 });

 it('re-pairs at the new origin while preserving existing account directories',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cloud-migration-'));roots.push(root);
  await writeFile(join(root,'cloud-device.json'),JSON.stringify(device));
  await writeFile(join(root,'account-marker'),'keep');
  const fetcher=vi.fn(async(_url,options)=>{
   expect(options.headers.Authorization).toBeUndefined();
   return new Response(JSON.stringify({deviceId:'c'.repeat(64),deviceToken:'d'.repeat(64),workspace:'workspace'}),{status:201});
  });
  await registerCloudConnector({cloudUrl:'https://new.example',pairingCode:'12345678',root,fetcher});
  expect((await loadCloudDevice(root)).cloudUrl).toBe('https://new.example');
  expect(await readFile(join(root,'account-marker'),'utf8')).toBe('keep');
 });
});

describe('running connector reconnect decisions',()=>{
 it('requires a fresh pairing code for an origin change',()=>{
  expect(reconnectDecision({existing:device,targetCloudUrl:'https://new.example'})).toEqual({
   action:'re-pair',cloudUrl:'https://new.example',requiresPairing:true,
  });
 });
 it('allows explicit re-pairing at the same origin for a revoked device',()=>{
  expect(reconnectDecision({existing:device,targetCloudUrl:'https://old.example',pairingCode:'12345678'})).toEqual({
   action:'pair',cloudUrl:'https://old.example',requiresPairing:false,
  });
 });
});

it('running connector asks for a pairing code before switching origins',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cloud-running-migration-'));roots.push(root);
 const localToken='e'.repeat(64);
 await writeFile(join(root,'cloud-device.json'),JSON.stringify(device));
 await writeFile(join(root,'connector-token'),localToken,{mode:0o600});
 const port=48000+Math.floor(Math.random()*500);
 const child=spawn(process.execPath,[fileURLToPath(new URL('./connector.mjs',import.meta.url)),'--data-dir',root,'--port',String(port),'--cloud-url','https://new.example'],{stdio:['ignore','pipe','pipe']});
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('connector startup timeout')),10000);child.stdout.on('data',data=>{if(data.toString().includes('已启动')){clearTimeout(timer);resolve();}});child.stderr.on('data',data=>{if(data.toString().includes('云端配对失败')){clearTimeout(timer);reject(Error(data.toString()));}});child.once('exit',code=>{clearTimeout(timer);reject(Error('connector exited '+code));});});
  const response=await fetch(`http://127.0.0.1:${port}/reconnect`,{method:'POST',headers:{Authorization:`Bearer ${localToken}`,'Content-Type':'application/json'},body:JSON.stringify({cloudUrl:'https://new.example'})});
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({requiresPairing:true});
  expect(await readFile(join(root,'cloud-device.json'),'utf8')).toContain('old.example');
 }finally{
  child.kill();
  await new Promise(resolve=>child.once('exit',resolve));
 }
});
