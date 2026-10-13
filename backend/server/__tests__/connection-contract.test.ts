import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createGreyApp } from '../grey-app';
import { createStore } from '../store';

test('connector discovery describes the paired device without requiring retired integrations',async()=>{
  const app=createGreyApp(createStore(join(mkdtempSync(join(tmpdir(),'contract-')),'ops.sqlite')),'test-credential-longer-than-32-characters');
  expect((await request(app).get('/api/connections')).status).toBe(401);
  const res=await request(app).get('/api/connections').set('Authorization','Bearer test-credential-longer-than-32-characters');
  expect(res.status).toBe(200);
  expect(res.body.connector).toMatchObject({transport:'paired-device',loginPath:'/api/xhs/qr-login'});
  expect(JSON.stringify(res.body)).not.toMatch(/workbuddy|opencli/i);
  expect(res.body.models.protocols).toContain('chat-completions');
  expect(res.body.models.protocols).toContain('anthropic-messages');
  expect(res.body.models.liveExecutionAvailable).toBe(false);
});
