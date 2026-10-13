import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createStore } from '../store';
import { createGreyApp } from '../grey-app';

test('partial note import persists unknown fields as null, not invented zeroes', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'partial-')), 'ops.sqlite');
  const store = createStore(path);
  const token = 'test-only-token-longer-than-32-characters';
  const app = createGreyApp(store, token);
  const body = {
    account: {id:'fixture',name:'Fixture',handle:'fixture',profile:'test',avatar:'',state:'connected',followers:0,lastSyncedAt:'2026-09-06T00:00:00Z'},
    notes:[{id:'fixture-note',accountId:'fixture',title:'Fixture note',summary:null,cover:null,url:null,publishedAt:'2026-09-06',metrics:{likes:null,collects:null,comments:null,shares:null}}],
    comments:[]
  };
  expect((await request(app).post('/api/import').set('Authorization','Bearer '+token).send(body)).status).toBe(200);
  const note = createStore(path).listNotes()[0];
  expect(note.url).toBeNull();
  expect(note.metrics.likes).toBeNull();
  expect(note.title).toBe('Fixture note');
  const complete = {...body, notes: [{...body.notes[0], url:'https://www.xiaohongshu.com/explore/fixture',metrics:{likes:7,collects:0,comments:1,shares:0}}]};
  await request(app).post('/api/import').set('Authorization','Bearer '+token).send(complete);
  await request(app).post('/api/import').set('Authorization','Bearer '+token).send(body);
  expect(createStore(path).listNotes()[0].metrics.likes).toBe(7);
  expect(createStore(path).listNotes()[0].url).toBe('https://www.xiaohongshu.com/explore/fixture');
});
