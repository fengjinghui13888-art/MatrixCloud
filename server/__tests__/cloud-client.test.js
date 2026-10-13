// @vitest-environment node
import {it,expect,vi,afterEach} from 'vitest';
import {registerCloudConnector,loadCloudDevice,normalizeCloudUrl,heartbeatCloudConnector,startCloudHeartbeat} from '../../local-connector/cloud-client.mjs';
import {mkdtemp,readFile,stat,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const roots=[];afterEach(async()=>{vi.useRealTimers();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
it('persists a private credential, validates TLS and reloads after restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cloud-client-'));roots.push(root);
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({deviceId:'d1',deviceToken:'a'.repeat(64),workspace:'w1',heartbeatIntervalSeconds:30}),{status:201}));
 expect(await registerCloudConnector({cloudUrl:'https://cloud.test/',pairingCode:'12345678',root,fetcher})).toMatchObject({deviceId:'d1'});
 expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:'error'});if(process.platform!=='win32')expect((await stat(join(root,'cloud-device.json'))).mode&0o777).toBe(0o600); // POSIX modes do not represent Windows ACLs.
 expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({version:'4.0.0'});
 expect((await loadCloudDevice(root)).deviceToken).toBe('a'.repeat(64));
 expect(()=>normalizeCloudUrl('http://public.test')).toThrow('HTTPS');expect(()=>normalizeCloudUrl('https://cloud.test/path')).toThrow();
 expect(normalizeCloudUrl('http://127.0.0.1:4174')).toBe('http://127.0.0.1:4174');
 await writeFile(join(root,'cloud-device.json'),'{');await expect(loadCloudDevice(root)).rejects.toThrow('损坏');
});
it('does not overlap requests and stops reconnecting after credential revocation',async()=>{
 vi.useFakeTimers();let resolve;const heartbeat=vi.fn(()=>new Promise(r=>{resolve=r;}));const status=vi.fn(),error=vi.fn();
 const stop=startCloudHeartbeat({}, {intervalMs:100,heartbeat,onStatus:status,onError:error});
 await vi.advanceTimersByTimeAsync(1000);expect(heartbeat).toHaveBeenCalledTimes(1);
 resolve({online:true});await vi.advanceTimersByTimeAsync(0);expect(status).toHaveBeenCalledTimes(1);
 heartbeat.mockRejectedValueOnce(Object.assign(Error('revoked'),{status:401}));await vi.advanceTimersByTimeAsync(100);await vi.advanceTimersByTimeAsync(10000);expect(heartbeat).toHaveBeenCalledTimes(2);expect(error).toHaveBeenCalledTimes(1);stop();
});
it('propagates authentication failures without treating them as online',async()=>{
 await expect(heartbeatCloudConnector({cloudUrl:'https://cloud.test',deviceToken:'a'.repeat(64)},{fetcher:async()=>new Response('{"message":"revoked"}',{status:401})})).rejects.toMatchObject({status:401});
});
