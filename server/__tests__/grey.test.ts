import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../store';
import request from 'supertest';
import { createGreyApp } from '../grey-app';

test('grey database starts empty and persists real imports across reopen', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'grey-')), 'ops.sqlite');
  const store = createStore(path);
  expect(store.listAccounts()).toEqual([]);
  store.importSnapshot({account: {id:'test-only',name:'Test fixture',handle:'test-only',profile:'test',avatar:'',state:'connected',followers:0,lastSyncedAt:new Date().toISOString()}, notes:[], comments:[]});
  expect(createStore(path).listAccounts().map(a=>a.id)).toEqual(['test-only']);
});

test('grey API refuses anonymous access and MCP reads the same empty database',async()=>{
  const store=createStore(join(mkdtempSync(join(tmpdir(),'grey-api-')),'ops.sqlite'));
  const token='test-access-token-with-32-characters'; const app=createGreyApp(store,token);
  expect((await request(app).get('/api/operations')).status).toBe(401);
  const response=await request(app).get('/api/operations').set('Authorization','Bearer '+token);
  expect(response.body).toEqual({accounts:[],notes:[],comments:[],messages:[],leads:[]});
  const result=await request(app).post('/mcp').set('Authorization','Bearer '+token).set('Accept','application/json, text/event-stream').send({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_xhs_operations_overview',arguments:{}}});
  expect(result.status).toBe(200);expect(result.text).toContain('accounts');
  expect((await request(app).post('/api/billing/topup-orders/test/complete').send({})).status).toBe(401);
});

test('sync checkpoint with an account that has never synced is accepted without exposing validation internals', async () => {
  const store=createStore(join(mkdtempSync(join(tmpdir(),'grey-empty-sync-')),'ops.sqlite'));
  const token='test-access-token-with-32-characters';
  const app=createGreyApp(store,token);
  const account={id:'xhs-123',name:'测试账号',handle:'123',profile:'local:session',avatar:'',state:'connected' as const,followers:0,lastSyncedAt:''};
  store.addAccount(account);
  const response=await request(app).post('/api/import').set('Authorization','Bearer '+token).send({account,notes:[],comments:[]});
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ok:true});
  expect((await request(app).get('/api/operations').set('Authorization','Bearer '+token)).status).toBe(200);
});
