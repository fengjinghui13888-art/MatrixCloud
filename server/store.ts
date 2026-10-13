import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Comment, Database, DirectMessage, FollowUp, Lead, LeadLevel, LeadStatus, SyncRun } from './domain';
import { seedDatabase } from './seed';
import { runSqlite } from './sqlite-client';

export type AccountFilter = { accountId?: string };
export interface Store {
  addAccount(account: Database['accounts'][number]): Database['accounts'][number];
  deleteAccount(accountId: string): { account: Database['accounts'][number]; notes: number; comments: number; messages: number; leads: number; followUps: number };
  deleteNote(accountId: string, noteId: string): { note: Database['notes'][number]; comments: number; leads: number; followUps: number };
  deleteNotes(items: Array<{accountId:string;noteId:string}>): { deleted: number; missing: string[]; comments: number; leads: number; followUps: number };
  deleteLead(id: string): { lead: Lead; followUps: number };
  deleteLeads(ids: string[]): { deleted: number; missing: string[]; followUps: number };
  deleteFollowUp(id: string): FollowUp;
  deleteFollowUps(ids: string[]): { deleted: number; missing: string[] };
  clearContent(accountId?: string): { notes: number; comments: number; messages: number; leads: number; followUps: number };
  importSnapshot(input: {account: Database['accounts'][number]; notes: Database['notes']; comments: Database['comments']; messages?: DirectMessage[]}): void;
  listMessages(filter?: AccountFilter): DirectMessage[];
  listAccounts(): Database['accounts']; listNotes(filter?: AccountFilter): Database['notes']; listComments(filter?: AccountFilter): Database['comments'];
  listLeads(filter?: AccountFilter): Lead[]; listMembers(): Database['members']; listFollowUps(leadId: string): FollowUp[]; getComment(id: string): Comment | undefined;
  createLead(input: Pick<Lead, 'accountId' | 'sourceNoteId' | 'sourceCommentId'>): Lead;
  createLeadFromComment(commentId: string, input: { level: LeadLevel; ownerId?: string }): Lead;
  updateLead(id: string, patch: Partial<Pick<Lead, 'ownerId' | 'status' | 'level'>>): Lead;
  addFollowUp(leadId: string, body: string, author: string): FollowUp;
  updateComment(id: string, patch: Partial<Pick<Comment, 'status' | 'tags'>>): Comment;
  upsertNotes(notes: Database['notes']): void; recordSync(run: SyncRun): void; listSyncRuns(): SyncRun[];
}

function copySeed(): Database { return structuredClone(seedDatabase); }
function matchesAccount<T extends { accountId: string }>(items: T[], accountId?: string) { return !accountId || accountId === 'all' ? items : items.filter((item) => item.accountId === accountId); }

export function createStore(filePath: string): Store {
  mkdirSync(dirname(filePath), { recursive: true });
  const sqlite = filePath.endsWith('.sqlite');
  const sql = (query: string) => runSqlite(filePath, query);
  if(sqlite) sql('CREATE TABLE IF NOT EXISTS operations_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);');
  const saved = sqlite ? sql('SELECT payload FROM operations_state WHERE id=1;').trim() : existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  let data: Database = saved ? JSON.parse(saved) : sqlite ? {accounts:[],notes:[],comments:[],leads:[],followUps:[],members:[],syncRuns:[],templates:[]} : copySeed();
  const persist = () => { const payload=JSON.stringify(data); if(sqlite) sql(`INSERT INTO operations_state(id,payload) VALUES(1,'${payload.replaceAll("'", "''")}') ON CONFLICT(id) DO UPDATE SET payload=excluded.payload;`); else writeFileSync(filePath,payload); };
  const orphanedLeadComments=data.comments.filter(comment=>comment.status==='lead_created'&&!data.leads.some(lead=>lead.sourceCommentId===comment.id));
  if(orphanedLeadComments.length){for(const comment of orphanedLeadComments)comment.status='pending';persist();}
  const requireComment = (id: string) => { const comment = data.comments.find((item) => item.id === id); if (!comment) throw new Error('Comment not found'); return comment; };
  const requireLead = (id: string) => { const lead = data.leads.find((item) => item.id === id); if (!lead) throw new Error('Lead not found'); return lead; };
  return {
    addAccount: (account) => {
      const existing = data.accounts.find((item) => item.id === account.id || item.handle.toLowerCase() === account.handle.toLowerCase());
      if (existing) return existing;
      data.accounts.push(account); persist(); return account;
    },
    deleteAccount: (accountId) => {
      const account = data.accounts.find(item => item.id === accountId);
      if (!account) throw new Error('账号不存在');
      const noteIds = new Set(data.notes.filter(item => item.accountId === accountId).map(item => item.id));
      const commentIds = new Set(data.comments.filter(item => item.accountId === accountId).map(item => item.id));
      const leadIds = new Set(data.leads.filter(item => item.accountId === accountId).map(item => item.id));
      const counts = {
        account,
        notes: data.notes.filter(item => item.accountId === accountId).length,
        comments: data.comments.filter(item => item.accountId === accountId).length,
        messages: (data.messages ?? []).filter(item => item.accountId === accountId).length,
        leads: data.leads.filter(item => item.accountId === accountId).length,
        followUps: data.followUps.filter(item => leadIds.has(item.leadId)).length
      };
      data.accounts = data.accounts.filter(item => item.id !== accountId);
      data.notes = data.notes.filter(item => item.accountId !== accountId);
      data.comments = data.comments.filter(item => item.accountId !== accountId);
      data.messages = (data.messages ?? []).filter(item => item.accountId !== accountId);
      data.leads = data.leads.filter(item => item.accountId !== accountId);
      data.followUps = data.followUps.filter(item => !leadIds.has(item.leadId));
      persist();
      return counts;
    },
    deleteNote: (accountId, noteId) => {
      const note = data.notes.find(item => item.id === noteId && item.accountId === accountId);
      if (!note) throw new Error('内容不存在或不属于该账号');
      const commentIds = new Set(data.comments.filter(item => item.noteId === noteId && item.accountId === accountId).map(item => item.id));
      const leadIds = new Set(data.leads.filter(item => item.sourceNoteId === noteId && item.accountId === accountId).map(item => item.id));
      const result = {
        note,
        comments: commentIds.size,
        leads: leadIds.size,
        followUps: data.followUps.filter(item => leadIds.has(item.leadId)).length
      };
      data.notes = data.notes.filter(item => !(item.id === noteId && item.accountId === accountId));
      data.comments = data.comments.filter(item => !(item.noteId === noteId && item.accountId === accountId));
      data.leads = data.leads.filter(item => !leadIds.has(item.id));
      data.followUps = data.followUps.filter(item => !leadIds.has(item.leadId));
      persist();
      return result;
    },
    deleteNotes: (items) => {
      const unique=[...new Map(items.map(item=>[`${item.accountId}:${item.noteId}`,item])).values()];
      let comments=0,leads=0,followUps=0,deleted=0;const missing:string[]=[];
      for(const item of unique){const note=data.notes.find(n=>n.id===item.noteId&&n.accountId===item.accountId);if(!note){missing.push(item.noteId);continue;}const leadIds=new Set(data.leads.filter(l=>l.sourceNoteId===item.noteId&&l.accountId===item.accountId).map(l=>l.id));comments+=data.comments.filter(c=>c.noteId===item.noteId&&c.accountId===item.accountId).length;leads+=leadIds.size;followUps+=data.followUps.filter(f=>leadIds.has(f.leadId)).length;data.notes=data.notes.filter(n=>!(n.id===item.noteId&&n.accountId===item.accountId));data.comments=data.comments.filter(c=>!(c.noteId===item.noteId&&c.accountId===item.accountId));data.leads=data.leads.filter(l=>!leadIds.has(l.id));data.followUps=data.followUps.filter(f=>!leadIds.has(f.leadId));deleted++;}
      persist();
      return {deleted,missing,comments,leads,followUps};
    },
    deleteLead: (id) => {
      const lead=requireLead(id);
      const followUps=data.followUps.filter(item=>item.leadId===id).length;
      data.leads=data.leads.filter(item=>item.id!==id);
      data.followUps=data.followUps.filter(item=>item.leadId!==id);
      const source=data.comments.find(item=>item.id===lead.sourceCommentId);
      if(source?.status==='lead_created')source.status='pending';
      persist();
      return {lead,followUps};
    },
    deleteLeads: (ids) => {
      const unique=[...new Set(ids)],missing:string[]=[];let deleted=0,followUps=0;
      for(const id of unique){
        const lead=data.leads.find(l=>l.id===id);
        if(!lead){missing.push(id);continue;}
        followUps+=data.followUps.filter(f=>f.leadId===id).length;
        data.leads=data.leads.filter(l=>l.id!==id);
        data.followUps=data.followUps.filter(f=>f.leadId!==id);
        const source=data.comments.find(item=>item.id===lead.sourceCommentId);
        if(source?.status==='lead_created')source.status='pending';
        deleted++;
      }
      persist();return {deleted,missing,followUps};
    },
    deleteFollowUp: (id) => { const item=data.followUps.find(x=>x.id===id); if(!item)throw Error('跟进记录不存在'); data.followUps=data.followUps.filter(x=>x.id!==id); persist(); return item; },
    deleteFollowUps: (ids) => { const unique=[...new Set(ids)],missing:string[]=[];let deleted=0;for(const id of unique){if(!data.followUps.some(f=>f.id===id)){missing.push(id);continue;}data.followUps=data.followUps.filter(f=>f.id!==id);deleted++;}persist();return {deleted,missing}; },
    clearContent: (accountId) => {
      const noteMatches = (item: {accountId: string}) => !accountId || item.accountId === accountId;
      const leadIds = new Set(data.leads.filter(item => noteMatches(item)).map(item => item.id));
      const result = {
        notes: data.notes.filter(noteMatches).length,
        comments: data.comments.filter(noteMatches).length,
        messages: (data.messages ?? []).filter(noteMatches).length,
        leads: data.leads.filter(noteMatches).length,
        followUps: data.followUps.filter(item => leadIds.has(item.leadId)).length
      };
      data.notes = data.notes.filter(item => !noteMatches(item));
      data.comments = data.comments.filter(item => !noteMatches(item));
      data.messages = (data.messages ?? []).filter(item => !noteMatches(item));
      data.leads = data.leads.filter(item => !noteMatches(item));
      data.followUps = data.followUps.filter(item => !leadIds.has(item.leadId));
      persist();
      return result;
    },
    importSnapshot: ({account, notes, comments, messages=[]}) => {
      if(notes.some(n=>n.accountId!==account.id) || comments.some(c=>c.accountId!==account.id) || messages.some(m=>m.accountId!==account.id)) throw new Error('账号归属不一致');
      const upsert = <T extends {id:string}>(items:T[], incoming:T[]) => {for(const item of incoming){const index=items.findIndex(x=>x.id===item.id); if(index<0) items.push(item); else items[index]=item;}};
      if(notes.some(n=>data.notes.some(old=>old.id===n.id && old.accountId!==account.id)) || comments.some(c=>data.comments.some(old=>old.id===c.id && old.accountId!==account.id))) throw new Error('记录归属冲突');
      upsert(data.accounts,[account]);
      upsert(data.notes,notes.map(n=>{
        const old=data.notes.find(item=>item.id===n.id);
        if(!old)return n;
        return {...n,mediaAssets:n.mediaAssets??old.mediaAssets,mediaType:n.mediaType??old.mediaType,images:n.images??old.images,videoUrl:n.videoUrl??old.videoUrl,summary:n.summary??old.summary,cover:n.cover??old.cover,url:n.url??old.url,
          metrics:{likes:n.metrics.likes??old.metrics.likes,collects:n.metrics.collects??old.metrics.collects,comments:n.metrics.comments??old.metrics.comments,shares:n.metrics.shares??old.metrics.shares}};
      }));
      upsert(data.comments,comments.map(c=>{const old=data.comments.find(x=>x.id===c.id);return old?{...c,status:old.status,tags:old.tags}:c;}));
      data.messages??=[];
      for(const message of messages){const index=data.messages.findIndex(m=>m.id===message.id&&m.accountId===message.accountId);if(index<0)data.messages.push(message);else data.messages[index]=message;}
      persist();
    },
    listAccounts: () => data.accounts,
    listNotes: (filter = {}) => matchesAccount(data.notes, filter.accountId),
    listComments: (filter = {}) => matchesAccount(data.comments, filter.accountId),
    listMessages: (filter = {}) => matchesAccount(data.messages??[], filter.accountId),
    listLeads: (filter = {}) => matchesAccount(data.leads, filter.accountId),
    listMembers: () => data.members,
    listFollowUps: (leadId) => data.followUps.filter((item) => item.leadId === leadId),
    listSyncRuns: () => data.syncRuns,
    getComment: (id) => data.comments.find((item) => item.id === id),
    createLead: (input) => {
      const existing = data.leads.find((item) => item.sourceCommentId === input.sourceCommentId);
      if (existing) return existing;
      const lead: Lead = { id: randomUUID(), ...input, status: 'new', level: 'medium', createdAt: new Date().toISOString() };
      data.leads.push(lead); persist(); return lead;
    },
    createLeadFromComment: (commentId, input) => {
      const comment = requireComment(commentId);
      const lead = data.leads.find((item) => item.sourceCommentId === commentId) ?? { id: randomUUID(), accountId: comment.accountId, sourceNoteId: comment.noteId, sourceCommentId: comment.id, status: 'new' as LeadStatus, level: input.level, ownerId: input.ownerId, createdAt: new Date().toISOString() };
      if (!data.leads.some((item) => item.id === lead.id)) data.leads.push(lead);
      lead.level = input.level; lead.ownerId = input.ownerId;
      comment.status = 'lead_created'; persist(); return lead;
    },
    updateLead: (id, patch) => { const lead = requireLead(id); Object.assign(lead, patch); persist(); return lead; },
    addFollowUp: (leadId, body, author) => { requireLead(leadId); const item: FollowUp = { id: randomUUID(), leadId, body, author, createdAt: new Date().toISOString() }; data.followUps.push(item); persist(); return item; },
    updateComment: (id, patch) => { const comment = requireComment(id); Object.assign(comment, patch); persist(); return comment; },
    upsertNotes: (notes) => { notes.forEach((note) => { const index = data.notes.findIndex((item) => item.id === note.id); if (index >= 0) data.notes[index] = note; else data.notes.push(note); }); persist(); },
    recordSync: (run) => { data.syncRuns.unshift(run); persist(); }
  };
}
