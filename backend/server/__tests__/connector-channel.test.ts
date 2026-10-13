// @vitest-environment node
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {it,expect} from 'vitest';
import {createConnectorPairing} from '../connector-pairing';import {createConnectorChannel} from '../connector-channel';
// @ts-ignore cross-platform ESM client
import {startCloudChannel} from '../../../local-connector/cloud-channel.mjs';
const listen=(server:ReturnType<typeof createServer>)=>new Promise<number>(resolve=>server.listen(0,'127.0.0.1',()=>resolve((server.address() as any).port)));
it('routes actual outbound WebSocket commands, media, isolation, restart bindings and revocation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'channel-')),file=join(root,'pairing.sqlite'),pairing=createConnectorPairing(file),channel=createConnectorChannel(pairing,file);
 const server=createServer();channel.attach(server);const port=await listen(server);
 const received:string[]=[];const local=createServer((req,res)=>{
   received.push(req.url!);if(req.headers.authorization!=='Bearer local-secret'){res.writeHead(401).end();return;}
   if(req.url?.includes('/media/')){res.writeHead(200,{'content-type':'application/octet-stream'});res.end(Buffer.alloc(130000,7));return;}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(req.url==='/verify'?{ok:true,version:4,capabilities:['device-queue','stop-ack','passive-state','paced-actions']}:{status:'complete',handle:'test-account'}));
 });const localPort=await listen(local);
 const a=pairing.register(pairing.create('a').code,'a','darwin','3.0.0'),b=pairing.register(pairing.create('b').code,'b','win32','3.0.0');
 let stop:()=>void=()=>{};
 try{
   await new Promise<void>((resolve,reject)=>{stop=startCloudChannel({...a,cloudUrl:'http://127.0.0.1:'+port},{port:localPort,token:'local-secret',onStatus:(s:string)=>{if(s==='connected')resolve();},onError:reject});});
   expect(await channel.online(a.deviceId)).toBe(true);await channel.bind('a','local:profile-a',a.deviceId);
   expect(await channel.active('a')).toBe(a.deviceId);expect(await channel.selected('a')).toBe(a.deviceId);
   expect(await channel.json('a',a.deviceId,'GET','/verify')).toMatchObject({ok:true});
   expect(await channel.json('a',a.deviceId,'GET','/accounts/profile-a/state')).toMatchObject({handle:'test-account'});
   await expect(channel.request('b',a.deviceId,'GET','/accounts/profile-a/state')).rejects.toThrow('不属于');
   await expect(channel.request('a',a.deviceId,'GET','/accounts/profile-b/state')).rejects.toThrow('未绑定');
   await expect(channel.request('a',a.deviceId,'POST','/accounts/profile-a/evaluate',{script:'bad'})).rejects.toThrow('不支持');
   const job='11111111-1111-4111-8111-111111111111';
   await expect(channel.request('a',a.deviceId,'GET','/sync/'+job+'/result')).rejects.toThrow('不属于');
   await channel.json('a',a.deviceId,'POST','/sync/'+job,{target:{id:'account',profile:'local:profile-a',handle:'123'},knownNotes:[]});
   const media=await channel.request('a',a.deviceId,'GET','/sync/'+job+'/media/'+'a'.repeat(32));expect(media.data.equals(Buffer.alloc(130000,7))).toBe(true);
   expect(createConnectorChannel(pairing,file).binding('a','local:profile-a')).toBe(a.deviceId);
   pairing.revoke(a.deviceId,'a');expect(await channel.online(a.deviceId)).toBe(false);
   await expect(channel.request('a',a.deviceId,'GET','/verify')).rejects.toThrow('撤销');
   expect(received).not.toContain('/accounts/profile-b/state');expect(pairing.devices('b')).toHaveLength(1);
 }finally{stop();await new Promise<void>(r=>server.close(()=>r()));await new Promise<void>(r=>local.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});
