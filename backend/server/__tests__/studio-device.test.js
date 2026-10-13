// @vitest-environment node
import {createServer} from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {test,expect,vi} from 'vitest';
import {studioJobs} from '../../../local-connector/studio-jobs.mjs';
test('paired device dispatch is idempotent, uses local paths, rejects unpaired callbacks and reports exits',async()=>{
 const root=mkdtempSync(join(tmpdir(),'device-studio-'));writeFileSync(join(root,'connector-token'),'local-secret');
 const child=Object.assign(new EventEmitter(),{kill:vi.fn()});const launch=vi.fn(()=>child);
 const handler=studioJobs(root,47821,{launch,allowedBase:'http://127.0.0.1:47824'});
 const server=createServer(async(req,res)=>{try{if(!await handler(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end();}}catch{res.writeHead(500);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const input={runId:randomUUID(),taskId:randomUUID(),profile:'local:fixture',apiBase:'http://127.0.0.1:47824',token:'t'.repeat(40),startedAt:new Date().toISOString()};
 const post=body=>fetch(base+'/studio',{method:'POST',body:JSON.stringify(body)});
 try{
  expect((await post({...input,apiBase:'https://unpaired.example'})).status).toBe(400);
  expect((await post(input)).status).toBe(202);
  expect((await post(input)).status).toBe(200);expect(launch).toHaveBeenCalledTimes(1);
  const env=launch.mock.calls[0][2].env;expect(env.LOCAL_CONNECTOR_ROOT).toBe(root);expect(env.STUDIO_URL).toBe(input.apiBase);expect(env.LOCAL_CONNECTOR_URL).toBe('http://127.0.0.1:47821');
  expect(readFileSync(join(root,'studio-jobs',input.runId+'.json'),'utf8')).not.toContain(input.token);
  const second={...input,runId:randomUUID(),taskId:randomUUID(),profile:'local:second'};
  expect((await (await post(second)).json()).status).toBe('queued');expect(launch).toHaveBeenCalledTimes(1);
  expect((await post({...second,runId:randomUUID()})).status).toBe(409);
  child.emit('exit',1);const status=await (await fetch(base+'/studio/'+input.runId)).json();expect(status.status).toBe('blocked');
  expect(launch).toHaveBeenCalledTimes(2);expect((await (await fetch(base+'/studio/'+second.runId)).json()).status).toBe('running');
 }finally{child.emit('exit',1);await new Promise(r=>server.close(r));}
});
