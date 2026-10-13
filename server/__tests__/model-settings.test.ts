import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createGreyApp } from '../grey-app';
import { createStore } from '../store';
import { createModelSettings } from '../model-settings';

test('multiple encrypted profiles survive restart and switch without re-entering keys',()=>{
 const dir=mkdtempSync(join(tmpdir(),'model-profiles-'));const settings=createModelSettings(dir);
 const input={label:'First',protocol:'chat-completions',baseUrl:'https://first.example.com',model:'one',apiKey:'first-secret'};
 settings.save(input);const first=settings.profiles().activeId;
 settings.save({...input,label:'Second',baseUrl:'https://second.example.com',model:'two',apiKey:'second-secret'},true);
 const reopened=createModelSettings(dir);expect(reopened.profiles().profiles).toHaveLength(2);
 expect(reopened.read()?.model).toBe('two');reopened.activate(first);
 expect(reopened.read()?.apiKey).toBe('first-secret');
 expect(JSON.stringify(reopened.profiles())).not.toContain('secret');
 expect(JSON.stringify(reopened.summary())).not.toContain('secret');
});

test('model settings encrypt customer key and never return it',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'model-settings-'));
  const token='test-credential-longer-than-32-characters';
  const app=createGreyApp(createStore(join(dir,'ops.sqlite')),token,{modelDataDir:dir});
  const input={label:'Test provider',protocol:'chat-completions',baseUrl:'https://api.example.com/v1',model:'fixture-model',apiKey:'fixture-secret-not-real'};
  expect((await request(app).post('/api/models').send(input)).status).toBe(401);
  const saved=await request(app).post('/api/models').set('Authorization','Bearer '+token).send(input);
  expect(saved.status).toBe(200);
  expect(saved.text).not.toContain(input.apiKey);
  expect(readFileSync(join(dir,'model-settings.enc'),'utf8')).not.toContain(input.apiKey);
  const reopened=createGreyApp(createStore(join(dir,'ops.sqlite')),token,{modelDataDir:dir});
  const res=await request(reopened).get('/api/models').set('Authorization','Bearer '+token);
  expect(res.body).toMatchObject({label:'Test provider',model:'fixture-model',hasKey:true});
  expect(res.text).not.toContain(input.apiKey);
  expect((await request(app).post('/api/models').set('Authorization','Bearer '+token).send({...input,baseUrl:'http://127.0.0.1:4174'})).status).toBe(400);
  expect((await request(app).post('/api/models').set('Authorization','Bearer '+token).send({...input,protocol:'made-up-protocol'})).status).toBe(400);
});
