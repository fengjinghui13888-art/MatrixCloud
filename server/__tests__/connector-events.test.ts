// @vitest-environment node
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {it,expect,vi} from 'vitest';
import {createConnectorPairing} from '../connector-pairing';import {createConnectorChannel} from '../connector-channel';
// @ts-ignore cross-platform ESM client
import {startCloudChannel} from '../../local-connector/cloud-channel.mjs';
const listen=(s:any)=>new Promise<number>(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
const event={eventId:'11111111-1111-4111-8111-111111111111',profile:'local:one',kind:'notes',fingerprint:'a'.repeat(64)};
it('sends watch and acknowledges an event only after persistence',async()=>{
 const root=mkdtempSync(join(tmpdir(),'events-')),file=join(root,'pairing.sqlite'),pairing=createConnectorPairing(file),channel=createConnectorChannel(pairing,file);
 const server=createServer();channel.attach(server);const port=await listen(server);const d=pairing.register(pairing.create('workspace').code,'device','win32','4.0.0');
 let stop:any,watch:any,acked:any;const handled=new Promise<void>(resolve=>{channel.onEvent(async input=>{expect(input.workspace).toBe('workspace');expect(input.deviceId).toBe(d.deviceId);expect(input.event).toEqual(event);resolve();return true;});});
 try{await new Promise<void>((resolve,reject)=>{stop=startCloudChannel({...d,cloudUrl:'http://127.0.0.1:'+port},{port:1,token:'unused',onStatus:(s:string)=>s==='connected'&&resolve(),onError:reject,onWatch:(s:any)=>watch=s,onEventAck:(id:string)=>acked=id});});
  await channel.bind('workspace','local:one',d.deviceId);
  channel.watch(d.deviceId,[{profile:'local:one',accountId:'a',handle:'h',knownNotes:[],knownComments:[],knownMessages:[]}]);
  await new Promise(r=>setTimeout(r,20));expect(watch).toHaveLength(1);await stop.sendEvent(event);await handled;await new Promise(r=>setTimeout(r,20));expect(acked).toBe(event.eventId);
 }finally{stop?.();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});

it('processes command replies while a later event waits for the earlier drain',async()=>{
 const root=mkdtempSync(join(tmpdir(),'events-replies-')),file=join(root,'pairing.sqlite'),pairing=createConnectorPairing(file),channel=createConnectorChannel(pairing,file);
 const server=createServer();channel.attach(server);const port=await listen(server);const device=pairing.register(pairing.create('workspace').code,'device','win32','4.0.0');
 let releaseReply:()=>void=()=>{},stop:any,firstDrain:Promise<any>=Promise.resolve(),secondEntered=false;const acks:string[]=[];
 let requested!:()=>void;const requestArrived=new Promise<void>(resolve=>requested=resolve);
 const local=createServer((_req,res)=>{releaseReply=()=>{if(res.writableEnded)return;res.setHeader('content-type','application/json');res.end(JSON.stringify({version:4}));};requested();});const localPort=await listen(local);
 channel.onEvent(async input=>{
  if(input.event.eventId===event.eventId){firstDrain=channel.json('workspace',device.deviceId,'GET','/verify').catch(()=>null);return true;}
  secondEntered=true;await firstDrain;return true;
 });
 try{
  await new Promise<void>((resolve,reject)=>{stop=startCloudChannel({...device,cloudUrl:'http://127.0.0.1:'+port},{port:localPort,token:'fixture-local',onStatus:(s:string)=>s==='connected'&&resolve(),onError:reject,onEventAck:(id:string)=>acks.push(id)});});
  await channel.bind('workspace','local:one',device.deviceId);await stop.sendEvent(event);await requestArrived;
  const second={...event,eventId:'22222222-2222-4222-8222-222222222222',kind:'messages',fingerprint:'b'.repeat(64)};await stop.sendEvent(second);
  await vi.waitFor(()=>expect(secondEntered).toBe(true));releaseReply();
  const reply=await Promise.race([firstDrain,new Promise<null>(resolve=>setTimeout(()=>resolve(null),500))]);
  expect(reply).toMatchObject({version:4});await vi.waitFor(()=>expect(acks).toEqual([event.eventId,second.eventId]));
 }finally{releaseReply();stop?.();await new Promise<void>(r=>server.close(()=>r()));await firstDrain;await new Promise<void>(r=>local.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});
