"""Legacy-compatible business store and transactional persistence primitives."""
from __future__ import annotations

import copy
import json
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


class ServiceError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def identifier():
    return str(uuid.uuid4())


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


_locks = {}
_locks_guard = threading.Lock()


def path_lock(path):
    with _locks_guard:
        return _locks.setdefault(str(Path(path).resolve()), threading.RLock())


def atomic_write(path: Path, value: bytes):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex)
    try:
        with temporary.open('xb') as file:
            os.chmod(temporary, 0o600)
            file.write(value)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class SQLite:
    def __init__(self, path, schema):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = path_lock(self.path)
        with self.transaction() as db:
            db.executescript(schema)
        os.chmod(self.path, 0o600)

    @contextmanager
    def transaction(self):
        with self.lock:
            db = sqlite3.connect(self.path, timeout=30, isolation_level=None)
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA busy_timeout=30000')
            db.execute('PRAGMA foreign_keys=ON')
            try:
                db.execute('BEGIN IMMEDIATE')
                yield db
                if db.in_transaction:
                    db.commit()
            except BaseException:
                if db.in_transaction:
                    db.rollback()
                raise
            finally:
                db.close()


EMPTY = dict(accounts=[], notes=[], comments=[], messages=[], leads=[], followUps=[], members=[], syncRuns=[], templates=[])


class Store:
    enforce_snapshot_account = False
    require_lead_source = False
    preserve_note_fields = False
    def __init__(self, path):
        self.path = Path(path)
        self.sql = SQLite(self.path, 'CREATE TABLE IF NOT EXISTS operations_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);') if self.path.suffix == '.sqlite' else None
        self.lock = path_lock(self.path)
        # Repair only the historic orphan-comment condition, never replace unreadable data.
        with self.state(True) as data:
            lead_comments = {lead['sourceCommentId'] for lead in data['leads']}
            for comment in data['comments']:
                if comment.get('status') == 'lead_created' and comment['id'] not in lead_comments:
                    comment['status'] = 'pending'

    @contextmanager
    def state(self, write=False):
        with self.lock:
            if self.sql:
                with self.sql.transaction() as db:
                    row = db.execute('SELECT payload FROM operations_state WHERE id=1').fetchone()
                    data = json.loads(row['payload']) if row else copy.deepcopy(EMPTY)
                    self._validate(data)
                    yield data
                    if write:
                        db.execute('INSERT INTO operations_state(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', (dumps(data),))
            else:
                data = json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else copy.deepcopy(EMPTY)
                self._validate(data)
                yield data
                if write:
                    atomic_write(self.path, dumps(data).encode())

    @staticmethod
    def _validate(data):
        if not isinstance(data, dict) or any(not isinstance(data.get(k), list) for k in ('accounts', 'notes', 'comments', 'leads', 'followUps', 'members', 'syncRuns')):
            raise ServiceError('现有业务数据格式无效，请恢复备份', 500)
        data.setdefault('messages', [])
        data.setdefault('templates', [])

    @staticmethod
    def require(data, key, id, message):
        item = next((item for item in data[key] if item['id'] == id), None)
        if item is None:
            raise ServiceError(message, 404)
        return item

    def _list(self, key, filter=None):
        account = (filter or {}).get('accountId') if isinstance(filter, dict) else filter
        with self.state() as data:
            return copy.deepcopy([row for row in data[key] if not account or account == 'all' or row.get('accountId') == account])

    def list_accounts(self): return self._list('accounts')
    def list_notes(self, filter=None): return self._list('notes', filter)
    def list_comments(self, filter=None): return self._list('comments', filter)
    def list_messages(self, filter=None): return self._list('messages', filter)
    def list_leads(self, filter=None): return self._list('leads', filter)

    def lead_notifications(self):
        leads=self.list_leads()
        return dict(ids=[l['id'] for l in sorted(leads,key=lambda l:l.get('createdAt',''),reverse=True)[:1000]],waiting=sum(l['status']=='new' for l in leads))
    def list_members(self): return self._list('members')
    def list_sync_runs(self): return self._list('syncRuns')

    def list_follow_ups(self, lead_id):
        return [row for row in self._list('followUps') if row['leadId'] == lead_id]

    def get_comment(self, id):
        return next((row for row in self.list_comments() if row['id'] == id), None)

    def add_account(self, account):
        with self.state(True) as data:
            old = next((x for x in data['accounts'] if x['id'] == account['id'] or x['handle'].lower() == account['handle'].lower()), None)
            if old: return copy.deepcopy(old)
            data['accounts'].append(copy.deepcopy(account))
            return copy.deepcopy(account)

    @staticmethod
    def _remove_content(data, account_id=None, note_id=None):
        def matches(row):
            return (account_id is None or row.get('accountId') == account_id) and (note_id is None or row.get('id') == note_id)
        notes = [n for n in data['notes'] if matches(n)]
        def content_matches(row):
            return (account_id is None or row.get('accountId') == account_id) and (note_id is None or row.get('noteId', row.get('sourceNoteId')) == note_id)
        comments = [c for c in data['comments'] if content_matches(c)]
        leads = [l for l in data['leads'] if content_matches(l)]
        ids = {l['id'] for l in leads}
        followups = [f for f in data['followUps'] if f['leadId'] in ids]
        messages = [m for m in data['messages'] if note_id is None and (account_id is None or m['accountId'] == account_id)]
        for key, rows in [('notes', notes), ('comments', comments), ('leads', leads), ('followUps', followups), ('messages', messages)]:
            data[key] = [x for x in data[key] if x not in rows]
        return dict(notes=len(notes), comments=len(comments), leads=len(leads), followUps=len(followups), messages=len(messages))

    def delete_account(self, account_id):
        with self.state(True) as data:
            account = self.require(data, 'accounts', account_id, '账号不存在')
            result = {'account': copy.deepcopy(account), **self._remove_content(data, account_id)}
            data['accounts'].remove(account)
            return result

    def delete_note(self, account_id, note_id):
        with self.state(True) as data:
            note = next((n for n in data['notes'] if n['id'] == note_id and n['accountId'] == account_id), None)
            if note is None: raise ServiceError('内容不存在或不属于该账号', 404)
            counts = self._remove_content(data, account_id, note_id)
            return dict(note=note, comments=counts['comments'], leads=counts['leads'], followUps=counts['followUps'])

    def delete_notes(self, items):
        with self.state(True) as data:
            result = dict(deleted=0, missing=[], comments=0, leads=0, followUps=0)
            unique = {(x['accountId'], x['noteId']): x for x in items}
            for (account, note), item in unique.items():
                if not any(n['id'] == note and n['accountId'] == account for n in data['notes']):
                    result['missing'].append(note); continue
                count = self._remove_content(data, account, note)
                for key in ('comments', 'leads', 'followUps'): result[key] += count[key]
                result['deleted'] += 1
            return result

    def clear_content(self, account_id=None):
        with self.state(True) as data: return self._remove_content(data, account_id)

    @staticmethod
    def _delete_lead(data, lead):
        count = sum(f['leadId'] == lead['id'] for f in data['followUps'])
        data['followUps'] = [f for f in data['followUps'] if f['leadId'] != lead['id']]
        data['leads'].remove(lead)
        key='messages' if lead.get('sourceKind')=='direct' else 'comments'
        for row in data[key]:
            if row['id']==lead['sourceCommentId'] and row['accountId']==lead['accountId']:row['leadDismissed']=True
        for comment in data['comments']:
            if lead.get('sourceKind','comment')=='comment' and comment['id'] == lead['sourceCommentId'] and comment.get('status') == 'lead_created': comment['status'] = 'pending'
        return count

    def delete_lead(self, id):
        with self.state(True) as data:
            lead = self.require(data, 'leads', id, 'Lead not found')
            return dict(lead=copy.deepcopy(lead), followUps=self._delete_lead(data, lead))

    def delete_leads(self, ids):
        with self.state(True) as data:
            result = dict(deleted=0, missing=[], followUps=0)
            for id in dict.fromkeys(ids):
                lead = next((x for x in data['leads'] if x['id'] == id), None)
                if lead is None: result['missing'].append(id); continue
                result['followUps'] += self._delete_lead(data, lead)
                result['deleted'] += 1
            return result

    def delete_follow_up(self, id):
        with self.state(True) as data:
            item = self.require(data, 'followUps', id, '跟进记录不存在')
            data['followUps'].remove(item)
            return item

    def delete_follow_ups(self, ids):
        with self.state(True) as data:
            unique = list(dict.fromkeys(ids)); present = {x['id'] for x in data['followUps']}
            data['followUps'] = [x for x in data['followUps'] if x['id'] not in unique]
            return dict(deleted=sum(i in present for i in unique), missing=[i for i in unique if i not in present])

    def import_snapshot(self, input):
        account, notes, comments, messages = input['account'], input.get('notes', []), input.get('comments', []), input.get('messages', [])
        if any(x['accountId'] != account['id'] for x in notes + comments + messages): raise ServiceError('账号归属不一致')
        with self.state(True) as data:
            if self.enforce_snapshot_account and not any(a['id'] == account['id'] for a in data['accounts']):
                raise ServiceError('账号已删除或尚未连接，拒绝导入迟到的同步结果',409)
            for key, incoming in [('notes', notes), ('comments', comments)]:
                if any(x['id'] == n['id'] and x['accountId'] != account['id'] for n in incoming for x in data[key]): raise ServiceError('记录归属冲突')
            def upsert(key, row, merge=None):
                old = next((x for x in data[key] if x['id'] == row['id'] and (key != 'messages' or x['accountId'] == row['accountId'])), None)
                value = copy.deepcopy(row)
                if old is not None:
                    if merge: value = merge(value, old)
                    data[key][data[key].index(old)] = value
                else: data[key].append(value)
            upsert('accounts', account)
            def merge_note(n, old):
                for key in ('mediaAssets','mediaType','images','videoUrl','summary','cover','url'):
                    if n.get(key) is None and key in old: n[key] = old[key]
                n['metrics'] = {k: n.get('metrics', {}).get(k) if n.get('metrics', {}).get(k) is not None else old.get('metrics', {}).get(k) for k in ('likes','collects','comments','shares')}
                return n
            for n in notes: upsert('notes', n, merge_note)
            for c in comments: upsert('comments', c, lambda n, old: {**n, 'status':old['status'], 'tags':old['tags'],**({'leadDismissed':True} if old.get('leadDismissed') else {})})
            for m in messages: upsert('messages', m,lambda n,old:{**n,**({'leadDismissed':True} if old.get('leadDismissed') else {})})
            self._collect_leads(data)

    @staticmethod
    def _collect_leads(data):
        sources={(l['accountId'],l.get('sourceKind','comment'),l['sourceCommentId']) for l in data['leads']}
        accounts={a['id']:a for a in data['accounts']}
        count=0
        for kind,key in [('comment','comments'),('direct','messages')]:
            for row in data[key]:
                account=accounts.get(row['accountId'],{})
                if row.get('leadDismissed'):continue
                if row.get('direction')=='outgoing':continue
                if kind=='direct' and row.get('direction')!='incoming':continue
                if kind=='comment' and not row.get('direction') and row.get('author') in (account.get('name'),account.get('handle')):continue
                source=(row['accountId'],kind,row['id'])
                if source not in sources:
                    data['leads'].append(dict(id=identifier(),accountId=row['accountId'],sourceKind=kind,sourceNoteId=row.get('noteId') if kind=='comment' else None,sourceCommentId=row['id'],status='new',level='medium',createdAt=now()))
                    sources.add(source);count+=1
                if kind=='comment':row['status']='lead_created'
        return count

    def collect_leads(self):
        """Backfill existing synchronized interactions in one tenant transaction."""
        with self.state(True) as data:return self._collect_leads(data)

    def upsert_notes(self, notes):
        with self.state(True) as data:
            for note in notes:
                old = next((n for n in data['notes'] if n['id'] == note['id']), None)
                if old and old['accountId'] != note['accountId']: raise ServiceError('记录归属冲突')
                if old is not None:
                    value=copy.deepcopy(note)
                    if self.preserve_note_fields:
                        for key in ('summary','cover','url','mediaType','images','videoUrl','mediaAssets'):
                            if value.get(key) is None and key in old:value[key]=copy.deepcopy(old[key])
                        value['metrics']={k:v if v is not None else old.get('metrics',{}).get(k) for k,v in value.get('metrics',{}).items()}
                    data['notes'][data['notes'].index(old)] = value
                else: data['notes'].append(copy.deepcopy(note))

    def create_lead(self, input):
        with self.state(True) as data:
            old = next((l for l in data['leads'] if l['sourceCommentId'] == input['sourceCommentId']), None)
            if old: return copy.deepcopy(old)
            if self.require_lead_source:
                comment = self.require(data, 'comments', input['sourceCommentId'], 'Comment not found')
                if input['accountId'] != comment['accountId'] or input['sourceNoteId'] != comment['noteId']: raise ServiceError('线索来源不一致')
            lead = dict(id=identifier(), **input, status='new', level='medium', createdAt=now())
            data['leads'].append(lead)
            return copy.deepcopy(lead)

    def create_lead_from_comment(self, comment_id, input):
        with self.state(True) as data:
            comment = self.require(data, 'comments', comment_id, 'Comment not found')
            comment.pop('leadDismissed',None)
            lead = next((l for l in data['leads'] if l['accountId']==comment['accountId'] and l.get('sourceKind','comment')=='comment' and l['sourceCommentId'] == comment_id), None)
            if lead is None:
                lead = dict(id=identifier(), accountId=comment['accountId'], sourceNoteId=comment['noteId'], sourceCommentId=comment_id, status='new', createdAt=now())
                data['leads'].append(lead)
            lead['level'] = input['level']
            if input.get('ownerId') is not None: lead['ownerId'] = input['ownerId']
            else: lead.pop('ownerId', None)
            comment['status'] = 'lead_created'
            return copy.deepcopy(lead)

    def update_lead(self, id, patch):
        if any(k not in ('ownerId','status','level') for k in patch): raise ServiceError('线索设置不合法')
        with self.state(True) as data:
            lead = self.require(data,'leads',id,'Lead not found'); lead.update(patch); return copy.deepcopy(lead)

    def add_follow_up(self, lead_id, body, author):
        with self.state(True) as data:
            lead=self.require(data,'leads',lead_id,'Lead not found')
            if lead['status']=='new':lead['status']='following'
            item=dict(id=identifier(),leadId=lead_id,body=body,author=author,createdAt=now())
            data['followUps'].append(item); return copy.deepcopy(item)

    def update_comment(self,id,patch):
        if any(k not in ('status','tags') for k in patch): raise ServiceError('评论设置不合法')
        with self.state(True) as data:
            item=self.require(data,'comments',id,'Comment not found'); item.update(patch); return copy.deepcopy(item)

    def record_sync(self,run):
        with self.state(True) as data: data['syncRuns'].insert(0,copy.deepcopy(run))


class PayloadTable:
    """One-row-per-object persistence shared by SQLite and the normalized PG schema."""
    def __init__(self,path,table,kind=None,db=None,tenant='owner'):
        self.table,self.kind,self.db,self.tenant=table,kind,db,tenant
        schema = f'CREATE TABLE IF NOT EXISTS {table}(id TEXT PRIMARY KEY, request_id TEXT UNIQUE, revision INTEGER NOT NULL, payload TEXT NOT NULL);' if table == 'studio_tasks' else f'CREATE TABLE IF NOT EXISTS {table}(id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);'
        self.sql = None if db else SQLite(path, schema)

    @contextmanager
    def transaction(self):
        if self.db:
            with self.db.transaction(self.tenant) as c:
                c.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',(self.tenant+':'+self.kind,))
                yield c
        else:
            with self.sql.transaction() as c: yield c

    def rows(self,c,id=None,request_id=None):
        if self.db:
            text='SELECT payload FROM generation WHERE tenant_id=%s AND kind=%s'; values=[self.tenant,self.kind]
            if id is not None: text+=' AND id=%s'; values.append(id)
            if request_id is not None: text+=' AND request_id=%s'; values.append(request_id)
            text+=' ORDER BY created_at DESC,id'
        else:
            text=f'SELECT payload FROM {self.table} WHERE 1=1'; values=[]
            if id is not None: text+=' AND id=?'; values.append(id)
            if request_id is not None: text+=' AND request_id=?'; values.append(request_id)
            text+=' ORDER BY rowid DESC'
        return [copy.deepcopy(r['payload']) if isinstance(r['payload'],dict) else json.loads(r['payload']) for r in c.execute(text,values).fetchall()]

    def insert(self,c,task):
        if self.db:
            c.execute('INSERT INTO generation(tenant_id,id,request_id,account_id,kind,revision,status,payload,created_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s) ON CONFLICT(tenant_id,kind,request_id) DO NOTHING',(self.tenant,task['id'],task['requestId'],task.get('accountId'),self.kind,task.get('revision',1),task['status'],dumps(task),task['createdAt']))
        elif self.table=='studio_tasks':
            c.execute(f'INSERT OR IGNORE INTO {self.table}(id,request_id,revision,payload) VALUES(?,?,?,?)',(task['id'],task['requestId'],task.get('revision',1),dumps(task)))
        else:
            c.execute(f'INSERT OR IGNORE INTO {self.table}(id,request_id,status,payload) VALUES(?,?,?,?)',(task['id'],task['requestId'],task['status'],dumps(task)))

    def save(self,c,task):
        if self.db:
            c.execute('UPDATE generation SET revision=%s,status=%s,payload=%s::jsonb WHERE tenant_id=%s AND kind=%s AND id=%s',(task.get('revision',1),task['status'],dumps(task),self.tenant,self.kind,task['id']))
        elif self.table=='studio_tasks':
            c.execute(f'UPDATE {self.table} SET revision=?,payload=? WHERE id=?',(task.get('revision',1),dumps(task),task['id']))
        else:
            c.execute(f'UPDATE {self.table} SET status=?,payload=? WHERE id=?',(task['status'],dumps(task),task['id']))

    def remove(self,c,ids):
        if not ids:return
        if self.db:c.execute('DELETE FROM generation WHERE tenant_id=%s AND kind=%s AND id=ANY(%s::text[])',(self.tenant,self.kind,ids))
        else:c.execute(f'DELETE FROM {self.table} WHERE id IN ({",".join("?" for _ in ids)})',ids)
