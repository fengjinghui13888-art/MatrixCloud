import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import request from 'supertest';import {createGreyApp} from '../grey-app';import {createStore} from '../store';
test('obsolete execution APIs cannot accept server executable paths or launch tasks',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'retired-api-'));const token='audit-token-more-than-32-characters';const app=createGreyApp(createStore(join(dir,'ops.sqlite')),token,{authDataDir:dir});
 for(const path of ['workbuddy/connection','creation-tasks/unknown/run-text','one-click/publish']){
  const r=await request(app).post('/api/'+path).set('Authorization','Bearer '+token).set('Host','127.0.0.1').set('Origin','http://127.0.0.1').send({transport:'cli',cliPath:'/bin/sh',confirmCharge:true});
  expect(r.status).toBe(410);expect(r.body.message).not.toMatch(/workbuddy|opencli/i);
 }
 expect((await request(app).get('/api/publish-tasks').set('Authorization','Bearer '+token)).body).toEqual([]);
});
