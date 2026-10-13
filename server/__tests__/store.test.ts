import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../store';

function tempFile() {
  return join(mkdtempSync(join(tmpdir(), 'xhs-matrix-')), 'store.json');
}

test('creates at most one lead for a source comment', () => {
  const store = createStore(tempFile());
  const first = store.createLead({ sourceCommentId: 'comment-1', sourceNoteId: 'note-1', accountId: 'acc-1' });
  const second = store.createLead({ sourceCommentId: 'comment-1', sourceNoteId: 'note-1', accountId: 'acc-1' });

  expect(first.id).toBe(second.id);
  expect(store.listLeads()).toHaveLength(1);
});

test('persists a lead owner and status across store reload', () => {
  const file = tempFile();
  const firstStore = createStore(file);
  const lead = firstStore.createLead({ accountId: 'acc-1', sourceNoteId: 'note-1', sourceCommentId: 'comment-1' });
  firstStore.updateLead(lead.id, { ownerId: 'member-2', status: 'following' });

  expect(createStore(file).listLeads()[0]).toMatchObject({ ownerId: 'member-2', status: 'following' });
});
