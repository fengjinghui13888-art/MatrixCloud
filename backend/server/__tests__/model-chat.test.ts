import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createGreyApp } from '../grey-app';
import { createStore } from '../store';

test.each(['chat-completions','anthropic-messages'])('model gateway uses %s contract without executing account actions',async(protocol)=>{
  const dir=mkdtempSync(join(tmpdir(),'model-chat-'));const token='test-token-longer-than-32-characters';
  const outgoing:{url:string;headers:Record<string,string>;body:unknown}[]=[];
  const app=createGreyApp(createStore(join(dir,'ops.sqlite')),token,{modelDataDir:dir,modelTransport:async(url:string,headers:Record<string,string>,body:unknown)=>{
    outgoing.push({url,headers,body});
    return protocol==='chat-completions'?{choices:[{message:{content:'fixture response'}}]}:{content:[{type:'text',text:'fixture response'}]};
  }});
  const auth='Bearer '+token;
  await request(app).post('/api/models').set('Authorization',auth).send({label:'Fixture',protocol,baseUrl:'https://provider.example/v1',model:'test-model',apiKey:'fixture-key'});
  expect((await request(app).post('/api/models/chat').set('Authorization',auth).send({prompt:'hello'})).status).toBe(400);
  const response=await request(app).post('/api/models/chat').set('Authorization',auth).send({prompt:'hello',confirmCharge:true});
  expect(response.status).toBe(200);expect(response.body.text).toBe('fixture response');
  expect(outgoing[0].url).toBe(protocol==='chat-completions'?'https://provider.example/v1/chat/completions':'https://provider.example/v1/messages');
  expect(outgoing[0].body).toMatchObject({model:'test-model',messages:[{role:'user',content:'hello'}],stream:false,max_tokens:512});
  expect(outgoing[0].headers[protocol==='chat-completions'?'Authorization':'x-api-key']).toBe(protocol==='chat-completions'?'Bearer fixture-key':'fixture-key');
  expect((await request(app).get('/api/operations').set('Authorization',auth)).body.accounts).toEqual([]);
});
