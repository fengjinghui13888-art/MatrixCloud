"""Existing normalized PostgreSQL v2 adapter; no automatic DDL or migration."""
from __future__ import annotations

import copy
import json
import re
from contextlib import contextmanager
import psycopg
from psycopg.rows import dict_row
from .store import Store, ServiceError, dumps, EMPTY


class Postgres:
    def __init__(self,url):
        self.url=url
        self.validate_schema()

    def _connection(self):
        return psycopg.connect(self.url,connect_timeout=5,application_name='matrix-cloud-python',options='-c statement_timeout=10000',row_factory=dict_row)

    def validate_schema(self):
        with self._connection() as c:
            try:row=c.execute('SELECT version FROM schema_migration WHERE version=2').fetchone()
            except psycopg.errors.UndefinedTable as error:raise ServiceError('请先完成数据库迁移，再启动新版本',503) from error
            if not row:raise ServiceError('请先完成数据库迁移，再启动新版本',503)
            if not c.execute('SELECT version FROM schema_migration WHERE version=3').fetchone():raise ServiceError('请先执行线索数据库升级 003-interaction-leads.sql，再启动新版本',503)
            required=('tenant','app_user','login_session','login_limit','xiaohongshu_account','note','asset','message','clue','follow_up','team_member','sync_run','model_config','generation','template','job','job_attempt','device','device_pairing','device_binding','device_selection','device_run','connector_limit','audit_log','legacy_migration')
            missing=[name for name in required if not c.execute('SELECT to_regclass(%s) AS relation',(name,)).fetchone()['relation']]
            if missing:raise ServiceError('数据库迁移不完整，缺少表：'+', '.join(missing),503)
            return dict(version=2,tables=list(required))

    @contextmanager
    def transaction(self,tenant):
        if tenant!='owner' and not re.fullmatch(r'[a-f0-9-]{36}',tenant or ''):raise ServiceError('无效工作区',403)
        with self._connection() as c:
            with c.transaction():
                c.execute("SELECT set_config('app.tenant_id',%s,true)",(tenant,))
                yield c

    def rows(self,tenant,sql,params=()):
        with self.transaction(tenant) as c:
            result=c.execute(sql,params)
            return result.fetchall() if result.description else []

    def active(self,tenant):return bool(self.rows(tenant,'SELECT 1 FROM tenant WHERE tenant_id=%s AND enabled',(tenant,)))
    def audit(self,tenant,actor,action,target,result):self.rows(tenant,'INSERT INTO audit_log(tenant_id,actor,action,target,result) VALUES(%s,%s,%s,%s,%s)',(tenant,actor,action,target,result))
    def close(self):return None  # Every transaction owns and closes its connection.


_ACCOUNT='id,name,handle,avatar,profile,state,followers,last_synced_at AS "lastSyncedAt"'
_NOTE='id,account_id AS "accountId",title,summary,cover,url,published_at AS "publishedAt",metrics,media_type AS "mediaType",images,video_url AS "videoUrl",has_video_url,has_media_assets'
_COMMENT='id,account_id AS "accountId",note_id AS "noteId",author,avatar,body,created_at AS "createdAt",status,tags,direction,lead_dismissed AS "leadDismissed"'
_LEAD='id,account_id AS "accountId",source_note_id AS "sourceNoteId",source_comment_id AS "sourceCommentId",source_kind AS "sourceKind",status,level,owner_id AS "ownerId",created_at AS "createdAt"'
_FOLLOW='id,lead_id AS "leadId",body,author,created_at AS "createdAt"'


def compact(row):return {k:v for k,v in row.items() if v is not None or k not in ('mediaType','images','videoUrl','ownerId','count')}


class PostgresStore(Store):
    """Port business operations through normalized rows with atomic delta writes.

    Mutations serialize per tenant, preserve independent rows and update only changed
    entities. There is no workspace JSON blob and no tenant-free business query.
    """
    enforce_snapshot_account = True
    require_lead_source = True
    preserve_note_fields = True
    def lead_notifications(self):
        rows=self.db.rows(self.tenant,'SELECT id FROM clue WHERE tenant_id=%s ORDER BY created_at DESC,id LIMIT 1000',(self.tenant,))
        waiting=self.db.rows(self.tenant,"SELECT count(*) AS total FROM clue WHERE tenant_id=%s AND status='new'",(self.tenant,))[0]['total']
        return dict(ids=[r['id'] for r in rows],waiting=waiting)
    def __init__(self,db,tenant):self.db,self.tenant=db,tenant

    def _load(self,c):
        tenant=self.tenant
        def rows(table,cols,order='',extra=''):
            return [dict(r) for r in c.execute(f'SELECT {cols} FROM {table} WHERE tenant_id=%s {extra} '+order,(tenant,)).fetchall()]
        data=copy.deepcopy(EMPTY)
        data['accounts']=rows('xiaohongshu_account',_ACCOUNT,'ORDER BY id')
        notes=rows('note',_NOTE,'ORDER BY published_at DESC,id')
        assets=rows('asset','id,account_id,note_id,kind,position AS index,source_url AS "sourceUrl",path,bytes,sha256','ORDER BY ordinal,id')
        for note in notes:
            owned=[{k:v for k,v in a.items() if k not in ('account_id','note_id')} for a in assets if a['account_id']==note['accountId'] and a['note_id']==note['id']]
            has_video=note.pop('has_video_url');has_assets=note.pop('has_media_assets');value=compact(note)
            if has_video:value['videoUrl']=note['videoUrl']
            if has_assets or owned:value['mediaAssets']=owned
            data['notes'].append(value)
        data['comments']=[{k:v for k,v in row.items() if (k!='direction' or v is not None) and (k!='leadDismissed' or v)} for row in rows('message',_COMMENT,'ORDER BY created_at DESC,id',"AND kind='comment'")]
        data['messages']=[{k:v for k,v in row.items() if k!='leadDismissed' or v} for row in rows('message','id,account_id AS "accountId",conversation_id AS "conversationId",author,body,created_at AS "createdAt",direction,lead_dismissed AS "leadDismissed"','ORDER BY created_at,id',"AND kind='direct'")]
        data['leads']=[compact(r) for r in rows('clue',_LEAD,'ORDER BY created_at DESC,id')]
        data['followUps']=rows('follow_up',_FOLLOW,'ORDER BY created_at,id')
        data['members']=rows('team_member','id,name,role,avatar')
        data['syncRuns']=[compact(r) for r in rows('sync_run','id,account_id AS "accountId",status,message,created_at AS "createdAt",count','ORDER BY created_at DESC')]
        return data

    @contextmanager
    def state(self,write=False):
        with self.db.transaction(self.tenant) as c:
            if write:c.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',(self.tenant+':operations',))
            data=self._load(c);before=copy.deepcopy(data)
            yield data
            if write:self._persist(c,before,data)

    @staticmethod
    def _identity(key,row):return (row['accountId'],row['id']) if key=='messages' else row['id']

    def _persist(self,c,before,data,*,validate_owners=True):
        tenant=self.tenant
        tables={'accounts':'xiaohongshu_account','notes':'note','comments':'message','messages':'message','leads':'clue','followUps':'follow_up','members':'team_member','syncRuns':'sync_run'}
        # Delete children before parents. FK cascades remain a second line of defense.
        for key in ('followUps','leads','comments','messages','notes','accounts','members','syncRuns'):
            new_ids={self._identity(key,r) for r in data[key]}
            for row in before[key]:
                if self._identity(key,row) in new_ids:continue
                sql=f'DELETE FROM {tables[key]} WHERE tenant_id=%s AND id=%s';params=[tenant,row['id']]
                if key in ('comments','messages'):
                    sql+=' AND kind=%s AND account_id=%s';params.extend(['comment' if key=='comments' else 'direct',row['accountId']])
                c.execute(sql,params)
        for key in ('accounts','notes','comments','messages','members','leads','followUps','syncRuns'):
            previous={self._identity(key,r):r for r in before[key]}
            for row in data[key]:
                if previous.get(self._identity(key,row))==row:continue
                self._upsert(c,key,row,validate_owners=validate_owners)

    def _upsert(self,c,key,r,*,validate_owners=True):
        tenant=self.tenant
        if key=='accounts':
            c.execute('INSERT INTO xiaohongshu_account(tenant_id,id,name,handle,avatar,profile,state,followers,last_synced_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(tenant_id,id) DO UPDATE SET name=excluded.name,handle=excluded.handle,avatar=excluded.avatar,profile=excluded.profile,state=excluded.state,followers=excluded.followers,last_synced_at=excluded.last_synced_at',(tenant,r['id'],r['name'],r['handle'],r['avatar'],r['profile'],r['state'],r['followers'],r['lastSyncedAt']))
        elif key=='notes':
            c.execute('INSERT INTO note(tenant_id,id,account_id,title,summary,cover,url,published_at,metrics,media_type,images,video_url,has_video_url,has_media_assets) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s::jsonb,%s,%s,%s) ON CONFLICT(tenant_id,id) DO UPDATE SET title=excluded.title,summary=excluded.summary,cover=excluded.cover,url=excluded.url,published_at=excluded.published_at,metrics=excluded.metrics,media_type=excluded.media_type,images=excluded.images,video_url=excluded.video_url,has_video_url=note.has_video_url OR excluded.has_video_url,has_media_assets=note.has_media_assets OR excluded.has_media_assets',(tenant,r['id'],r['accountId'],r['title'],r.get('summary'),r.get('cover'),r.get('url'),r['publishedAt'],dumps(r['metrics']),r.get('mediaType'),dumps(r['images']) if 'images' in r else None,r.get('videoUrl'),'videoUrl' in r,'mediaAssets' in r))
            if 'mediaAssets' in r:
                c.execute('DELETE FROM asset WHERE tenant_id=%s AND account_id=%s AND note_id=%s',(tenant,r['accountId'],r['id']))
                for ordinal,a in enumerate(r['mediaAssets']):c.execute('INSERT INTO asset(tenant_id,account_id,note_id,id,kind,position,source_url,path,bytes,sha256,ordinal) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',(tenant,r['accountId'],r['id'],a['id'],a['kind'],a['index'],a['sourceUrl'],a['path'],a['bytes'],a['sha256'],ordinal))
        elif key=='comments':
            c.execute("INSERT INTO message(tenant_id,id,account_id,kind,note_id,author,avatar,body,created_at,status,tags,direction,lead_dismissed) VALUES(%s,%s,%s,'comment',%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s) ON CONFLICT(tenant_id,account_id,kind,id) DO UPDATE SET note_id=excluded.note_id,author=excluded.author,avatar=excluded.avatar,body=excluded.body,created_at=excluded.created_at,status=excluded.status,tags=excluded.tags,direction=excluded.direction,lead_dismissed=excluded.lead_dismissed",(tenant,r['id'],r['accountId'],r['noteId'],r['author'],r.get('avatar'),r['body'],r['createdAt'],r['status'],dumps(r['tags']),r.get('direction'),r.get('leadDismissed',False)))
        elif key=='messages':
            c.execute("INSERT INTO message(tenant_id,id,account_id,kind,conversation_id,author,body,created_at,direction,lead_dismissed) VALUES(%s,%s,%s,'direct',%s,%s,%s,%s,%s,%s) ON CONFLICT(tenant_id,account_id,kind,id) DO UPDATE SET conversation_id=excluded.conversation_id,author=excluded.author,body=excluded.body,created_at=excluded.created_at,direction=excluded.direction,lead_dismissed=excluded.lead_dismissed",(tenant,r['id'],r['accountId'],r['conversationId'],r['author'],r['body'],r['createdAt'],r['direction'],r.get('leadDismissed',False)))
        elif key=='leads':
            if validate_owners and r.get('ownerId') and not c.execute('SELECT 1 FROM app_user WHERE tenant_id=%s AND username=%s AND enabled',(tenant,r['ownerId'])).fetchone():raise ServiceError('跟进人不属于当前客户')
            c.execute('INSERT INTO clue(tenant_id,id,account_id,source_note_id,source_comment_id,source_kind,status,level,owner_id,created_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(tenant_id,id) DO UPDATE SET status=excluded.status,level=excluded.level,owner_id=excluded.owner_id',(tenant,r['id'],r['accountId'],r['sourceNoteId'],r['sourceCommentId'],r.get('sourceKind','comment'),r['status'],r['level'],r.get('ownerId'),r['createdAt']))
        elif key=='members':c.execute('INSERT INTO team_member(tenant_id,id,name,role,avatar) VALUES(%s,%s,%s,%s,%s) ON CONFLICT(tenant_id,id) DO UPDATE SET name=excluded.name,role=excluded.role,avatar=excluded.avatar',(tenant,r['id'],r['name'],r['role'],r['avatar']))
        elif key=='followUps':c.execute('INSERT INTO follow_up(tenant_id,id,lead_id,body,author,created_at) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT(tenant_id,id) DO UPDATE SET body=excluded.body,author=excluded.author,created_at=excluded.created_at',(tenant,r['id'],r['leadId'],r['body'],r['author'],r['createdAt']))
        elif key=='syncRuns':c.execute('INSERT INTO sync_run(tenant_id,id,account_id,status,message,created_at,count) VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(tenant_id,id) DO NOTHING',(tenant,r['id'],r['accountId'],r['status'],r['message'],r['createdAt'],r.get('count')))

    def delete_account(self,account_id):
        # Account/task guard and removal share the same DB transaction and row locks.
        with self.db.transaction(self.tenant) as c:
            c.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',(self.tenant+':operations',))
            if not c.execute('SELECT id FROM xiaohongshu_account WHERE tenant_id=%s AND id=%s FOR UPDATE',(self.tenant,account_id)).fetchone():raise ServiceError('账号不存在',404)
            rows=c.execute('SELECT status FROM generation WHERE tenant_id=%s AND account_id=%s FOR UPDATE',(self.tenant,account_id)).fetchall()
            if any(t['status'] in ('generating','running','filling','approved','pending_confirmation') for t in rows):raise ServiceError('该账号仍有正在执行或等待确认的任务，请先处理任务',409)
            if c.execute("SELECT 1 FROM job WHERE tenant_id=%s AND account_id=%s AND status='running'",(self.tenant,account_id)).fetchone():raise ServiceError('该账号仍有同步任务',409)
            data=self._load(c);before=copy.deepcopy(data)
            account=self.require(data,'accounts',account_id,'账号不存在')
            result={'account':copy.deepcopy(account),**self._remove_content(data,account_id)};data['accounts'].remove(account)
            c.execute('DELETE FROM generation WHERE tenant_id=%s AND account_id=%s',(self.tenant,account_id))
            self._persist(c,before,data);return result
