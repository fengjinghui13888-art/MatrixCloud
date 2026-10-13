import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createStore } from '../store';
import { createGreyApp } from '../grey-app';
import { createStudio } from '../studio';
import { createPublishQueue } from '../publish-queue';

const account = (id: string) => ({ id, name: id, handle: id, profile: 'local:' + id, avatar: '', state: 'connected' as const, followers: 1, lastSyncedAt: new Date().toISOString() });
const note = (accountId: string, id: string) => ({ id, accountId, title: id, summary: 'body', cover: null, url: null, publishedAt: '2026-09-11', metrics: { likes: null, collects: null, comments: null, shares: null } });
const comment = (accountId: string, noteId: string, id: string) => ({ id, accountId, noteId, author: 'reader', avatar: '', body: 'hello', createdAt: '2026-09-11', status: 'pending' as const, tags: [] });

test('account deletion removes all account-owned data', () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), 'delete-')), 'ops.sqlite'));
  store.importSnapshot({ account: account('a'), notes: [note('a', 'n')], comments: [comment('a', 'n', 'c')], messages: [{ id: 'm', accountId: 'a', conversationId: 't', author: 'reader', body: 'hi', createdAt: '2026-09-11', direction: 'incoming' }] });
  store.createLeadFromComment('c', { level: 'medium' });
  const result = store.deleteAccount('a');
  expect(result).toMatchObject({ notes: 1, comments: 1, messages: 1, leads: 1, followUps: 0 });
  expect(store.listAccounts()).toEqual([]);
  expect(store.listNotes()).toEqual([]);
  expect(store.listComments()).toEqual([]);
  expect(store.listMessages()).toEqual([]);
  expect(store.listLeads()).toEqual([]);
});

test('customer API can delete one note and clear scoped history', async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), 'delete-api-')), 'ops.sqlite'));
  store.importSnapshot({ account: account('a'), notes: [note('a', 'n1'), note('a', 'n2')], comments: [comment('a', 'n1', 'c1')], messages: [] });
  const app = createGreyApp(store, 'test-access-token-with-32-characters');
  const auth = { Authorization: 'Bearer test-access-token-with-32-characters' };
  expect((await request(app).post('/api/accounts/a/notes/n1/delete').set(auth).send({})).status).toBe(200);
  expect(store.listNotes().map(n => n.id)).toEqual(['n2']);
  expect((await request(app).post('/api/content/clear').set(auth).send({ accountId: 'a' })).status).toBe(200);
  expect(store.listNotes()).toEqual([]);
});

test('scoped account deletion does not affect another account', () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), 'delete-scope-')), 'ops.sqlite'));
  store.importSnapshot({ account: account('a'), notes: [note('a', 'na')], comments: [] });
  store.importSnapshot({ account: account('b'), notes: [note('b', 'nb')], comments: [] });
  store.deleteAccount('a');
  expect(store.listAccounts().map(a => a.id)).toEqual(['b']);
  expect(store.listNotes().map(n => n.id)).toEqual(['nb']);
});

test('account deletion is atomic and refuses when a publish task is running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'delete-running-'));
  const store = createStore(join(dir, 'ops.sqlite'));
  store.importSnapshot({ account: account('a'), notes: [], comments: [] });
  const studio = createStudio(join(dir, 'studio.sqlite'));
  const made = studio.create({ accountId: 'a', topic: 'topic', persona: 'persona', style: 'style', imageCount: 1, size: '1024x1024', requestId: 'delete-running-studio', confirmCharge: true });
  const reviewed = studio.update(made.task.id, made.task.revision, { status: 'review', title: '标题', body: '正文', tags: [], images: ['https://example.com/image.png'] });
  expect(reviewed.status).toBe('review');
  const publish = createPublishQueue(join(dir, 'publish.sqlite'));
  const task = publish.create({ accountId: 'a', title: '标题', body: '正文', media: ['https://example.com/image.png'], delivery: 'draft', requestId: 'delete-running-publish' });
  publish.claim(task.id);
  const token = 'delete-running-token-with-more-than-32-chars';
  const app = createGreyApp(store, token, { modelDataDir: dir });
  const response = await request(app).post('/api/accounts/a/delete').set('Authorization', `Bearer ${token}`).send({});
  expect(response.status).toBe(409);
  expect(response.body.message).toContain('发布任务');
  expect(store.listAccounts().map(a => a.id)).toEqual(['a']);
  expect(studio.list().map(t => t.id)).toEqual([made.task.id]);
  expect(publish.list().map(t => t.id)).toEqual([task.id]);
});

test('bulk delete validates explicit ids and leaves unknown ids reported', async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), 'delete-bulk-')), 'ops.sqlite'));
  store.importSnapshot({ account: account('a'), notes: [note('a', 'n1'), note('a', 'n2')], comments: [] });
  const token = 'delete-bulk-token-with-more-than-32-chars';
  const app = createGreyApp(store, token);
  const auth = { Authorization: `Bearer ${token}` };
  const invalid = await request(app).post('/api/notes/bulk-delete').set(auth).send({ items: [{ accountId: 'a' }] });
  expect(invalid.status).toBe(409);
  const result = await request(app).post('/api/notes/bulk-delete').set(auth).send({ items: [{ accountId: 'a', noteId: 'n1' }, { accountId: 'a', noteId: 'n1' }, { accountId: 'a', noteId: 'missing' }] });
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ deleted: 1, missing: ['missing'] });
  expect(store.listNotes().map(n => n.id)).toEqual(['n2']);
});

test('deleting a lead restores its source comment so a customer can create it again', () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), 'delete-lead-')), 'ops.sqlite'));
  store.importSnapshot({ account: account('a'), notes: [note('a', 'n')], comments: [comment('a', 'n', 'c')] });
  const first = store.createLeadFromComment('c', { level: 'medium' });
  expect(store.getComment('c')?.status).toBe('lead_created');
  store.deleteLead(first.id);
  expect(store.getComment('c')?.status).toBe('pending');
  const second = store.createLeadFromComment('c', { level: 'high' });
  expect(second.id).not.toBe(first.id);
  expect(store.getComment('c')?.status).toBe('lead_created');
});

test('reopening storage repairs comments left as lead_created after an earlier incomplete deletion', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'repair-lead-')), 'ops.sqlite');
  const store = createStore(path);
  store.importSnapshot({ account: account('a'), notes: [note('a', 'n')], comments: [{...comment('a', 'n', 'c'),status:'lead_created'}] });
  expect(createStore(path).getComment('c')?.status).toBe('pending');
});
