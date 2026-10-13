import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createGreyApp } from '../grey-app';
import { createStore } from '../store';

test('creation returns generated text and images through MCP, persists them and never creates a publishing task',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'creation-'));
  const store=createStore(join(dir,'ops.sqlite'));
  const token='creation-test-token-longer-than-32-characters';
  const app=createGreyApp(store,token,{modelDataDir:dir});
  const auth={'Authorization':'Bearer '+token};
  const input={topic:'新品介绍',sellingPoints:'轻便',audience:'通勤人群',style:'简洁',imageCount:2,requestId:'creation-request-1'};
  const created=await request(app).post('/api/creation-tasks').set(auth).send(input);
  expect(created.status).toBe(201);
  expect(created.body.status).toBe('queued');
  const call=async(name:string,args:object)=>{
    const response=await request(app).post('/mcp').set(auth).set('Accept','application/json, text/event-stream').send({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
    const json=JSON.parse(response.text.split('\n').find(line=>line.startsWith('data: '))!.slice(6));return json.result;
  };
  expect((await call('claim_xhs_creation_task',{taskId:created.body.id})).isError).not.toBe(true);
  expect((await call('claim_xhs_creation_task',{taskId:created.body.id})).isError).toBe(true);
  const result={taskId:created.body.id,status:'completed',titles:['新品通勤好物','轻装出门'],body:'测试生成正文',images:['https://example.com/generated-1.png','https://example.com/generated-2.png'],message:'已生成',imageProvider:'Test image provider'};
  expect((await call('complete_xhs_creation_task',{...result,images:[]})).isError).toBe(true);
  expect((await call('complete_xhs_creation_task',result)).isError).not.toBe(true);
  const reopened=createGreyApp(store,token,{modelDataDir:dir});
  const tasks=await request(reopened).get('/api/creation-tasks').set(auth);
  expect(tasks.body[0].titles).toEqual(result.titles);
  expect(tasks.body[0].images).toEqual(result.images);
  expect((await request(app).get('/api/publish-tasks').set(auth)).body).toEqual([]);
});
