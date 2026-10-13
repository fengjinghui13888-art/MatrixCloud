"""Real PostgreSQL tests against explicit TEST_DATABASE_URL only.

The target must be an independent loopback test cluster/database named matrix_test_*.
Each fixture creates a new randomly named database and a nonprivileged app role.
No application DATABASE_URL, environment file, user data or production URL is read.
"""
from __future__ import annotations

import base64
import importlib.util
import io
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import secrets
import uuid

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row
from PIL import Image
import pytest

from app.services import Services
from app.settings import Settings
from app.store import ServiceError

BACKEND=Path(__file__).resolve().parents[1]


@pytest.fixture(scope='module')
def control():
    explicit=os.environ.get('TEST_DATABASE_URL')
    if not explicit:pytest.skip('TEST_DATABASE_URL is required for independent real PostgreSQL validation')
    params=conninfo_to_dict(explicit)
    if params.get('host') not in ('127.0.0.1','localhost') or not params.get('port') or not params.get('dbname','').startswith('matrix_test_'):
        pytest.fail('Refusing PostgreSQL target outside the explicit independent loopback test database')
    with psycopg.connect(explicit,autocommit=True,row_factory=dict_row) as connection:
        yield explicit,params,connection


@pytest.fixture
def database(control):
    explicit,params,connection=control
    suffix=uuid.uuid4().hex
    name='matrix_test_'+suffix
    role='matrix_test_role_'+suffix
    connection.execute(sql.SQL('CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS').format(sql.Identifier(role)))
    connection.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0 ENCODING UTF8').format(sql.Identifier(name)))
    admin=make_conninfo(**{**params,'dbname':name})
    app=make_conninfo(**{**params,'dbname':name,'user':role})
    try:
        with psycopg.connect(admin,autocommit=True) as db:
            db.execute((BACKEND/'sql'/'postgres-schema.sql').read_text(encoding='utf-8'))
            for statement in ('GRANT USAGE ON SCHEMA public TO {}','GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO {}','GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO {}','REVOKE UPDATE,DELETE ON audit_log FROM {}','REVOKE INSERT,UPDATE,DELETE ON schema_migration,legacy_migration FROM {}'):
                db.execute(sql.SQL(statement).format(sql.Identifier(role)))
            db.execute('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
        yield dict(admin=admin,app=app,role=role,name=name)
    finally:
        # Targets are generated here and never derived from the application env.
        connection.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
        connection.execute(sql.SQL('DROP ROLE {}').format(sql.Identifier(role)))


@pytest.fixture
def live(database,tmp_path):
    srv=Services(Settings(data_dir=tmp_path/'pg-data',database_url=database['app'],public_origin='https://test.example',platform_admin_username='platform'))
    owner=srv.auth.setup(dict(username='platform',password='synthetic-password'),ip='owner-test')
    identity=srv.auth.identity('zhixu_session='+owner['token'])
    try:yield srv,identity,database
    finally:srv.close()


def account(id='a'):
    return dict(id=id,name='合成测试账号',handle=id,avatar='',profile='local:'+id,state='connected',followers=2,lastSyncedAt='2026-10-13T00:00:00Z')


def snapshot(id='a',note_id='n',comment_id='c'):
    return dict(account=account(id),notes=[dict(id=note_id,accountId=id,title='合成笔记',summary='正文',cover='https://example.com/image.png',url=None,publishedAt='2026-10-13',metrics=dict(likes=1,collects=2,comments=3,shares=4),mediaType='image',images=['https://example.com/image.png'],videoUrl=None,mediaAssets=[dict(id='asset-z',kind='image',index=1,sourceUrl='https://example.com/b.png',path=id+'/x/y/'+note_id+'/b.png',bytes=20,sha256='b'*64),dict(id='asset-a',kind='cover',index=0,sourceUrl='https://example.com/a.png',path=id+'/x/y/'+note_id+'/a.png',bytes=10,sha256='a'*64)])],comments=[dict(id=comment_id,accountId=id,noteId=note_id,author='合成客户',avatar='',body='咨询',status='pending',tags=[],createdAt='2026-10-13')],messages=[dict(id='message',accountId=id,conversationId='thread',author='合成客户',body='私信',createdAt='2026-10-13',direction='incoming')])


def template():
    return dict(name='合成模板',category='生活方式',title='模板标题',body='模板正文',images=['https://example.com/image.png'],sourceUrl='https://example.com/source',usage='licensed',rightsNote='仅测试合成数据')


def model(label='合成服务',base='https://example.com/v1'):
    return dict(label=label,protocol='chat-completions',baseUrl=base,model='preserved-model',apiKey='synthetic-not-real-key',imageModel='gpt-image-1',imageBaseUrl='https://images.example.com/v1',imageApiKey='synthetic-not-real-image-key')


def creation(request='synthetic-request'):
    return dict(topic='主题',sellingPoints='',audience='',style='',imageCount=12,requestId=request)


def brief(request='synthetic-studio-request'):
    return dict(accountId='a',topic='主题',persona='',style='',imageCount=12,size='1024x1536',requestId=request,confirmCharge=True)


def test_real_canonical_schema_rls_and_least_privilege(live):
    srv,owner,db=live
    registered=srv.auth.register(dict(username='other',password='synthetic-password'),ip='other')
    a=srv.for_workspace('owner');b=srv.for_workspace(registered['workspace'])
    a.store.add_account(account());b.store.add_account(account())
    a.store.import_snapshot(snapshot());b.store.import_snapshot(snapshot())
    assert srv.db.validate_schema()['version']==2
    visible=srv.db.rows('owner','SELECT DISTINCT tenant_id FROM note')
    assert visible==[{'tenant_id':'owner'}]
    assert srv.db.rows('owner','UPDATE note SET title=%s WHERE tenant_id=%s RETURNING id',('attack',registered['workspace']))==[]
    assert b.store.list_notes()[0]['title']=='合成笔记'
    with psycopg.connect(db['app'],autocommit=True,row_factory=dict_row) as connection:
        assert connection.execute('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user').fetchone()==dict(rolsuper=False,rolcreatedb=False,rolcreaterole=False,rolbypassrls=False)
        with pytest.raises(psycopg.errors.InsufficientPrivilege):connection.execute('CREATE TABLE forbidden(id int)')


def test_real_auth_roles_sessions_and_disabled_tenants(live):
    srv,owner,db=live
    srv.auth.create_member(owner,dict(username='operator',password='synthetic-password',displayName='操作员',role='operator'))
    login=srv.auth.authenticate(dict(username='operator',password='synthetic-password'),ip='operator')
    cookie='zhixu_session='+login['token'];assert srv.auth.identity(cookie)['role']=='operator'
    with pytest.raises(ServiceError):srv.auth.team(srv.auth.identity(cookie))
    srv.auth.update_member(owner,'operator',dict(password='new-synthetic-password'))
    assert srv.auth.identity(cookie) is None
    with pytest.raises(ServiceError):srv.auth.authenticate(dict(username='operator',password='synthetic-password'),ip='operator')
    assert srv.auth.authenticate(dict(username='operator',password='new-synthetic-password'),ip='operator')['workspace']=='owner'
    registered=srv.auth.register(dict(username='customer',password='synthetic-password'),ip='customer')
    assert registered['workspace']!='owner'
    srv.auth.update_tenant(owner,registered['workspace'],dict(enabled=False))
    assert srv.auth.identity('zhixu_session='+registered['token']) is None
    with pytest.raises(ServiceError):srv.for_workspace(registered['workspace'])
    assert any(row['action']=='member.update' for row in srv.auth.audit(owner)['items'])


def test_real_store_members_media_order_cascade_and_late_snapshot(live):
    srv,owner,db=live;store=srv.for_workspace('owner').store
    store.add_account(account());value=snapshot();store.import_snapshot(value)
    assert store.list_notes()[0]['mediaAssets']==value['notes'][0]['mediaAssets']
    with store.state(True) as state:state['members'].append(dict(id='member-legacy',name='历史成员',role='operator',avatar=''))
    assert store.list_members()==[dict(id='member-legacy',name='历史成员',role='operator',avatar='')]
    lead=store.create_lead_from_comment('c',dict(level='high',ownerId='platform'))
    store.add_follow_up(lead['id'],'合成跟进','platform')
    assert store.delete_lead(lead['id'])['followUps']==1 and store.get_comment('c')['status']=='pending'
    lead=store.create_lead_from_comment('c',dict(level='medium'));store.add_follow_up(lead['id'],'再跟进','platform')
    result=store.delete_account('a')
    assert {k:result[k] for k in ('notes','comments','messages','leads','followUps')}==dict(notes=1,comments=1,messages=1,leads=1,followUps=1)
    with pytest.raises(ServiceError,match='账号已删除'):store.import_snapshot(value)
    assert srv.db.rows('owner','SELECT id FROM asset WHERE tenant_id=%s',('owner',))==[]


def test_real_pg_queue_claims_optimistic_revision_and_evidence(live):
    srv,owner,db=live;scope=srv.for_workspace('owner');scope.store.add_account(account())
    task=scope.creation.create(creation())
    def claim(_):
        try:return scope.creation.claim(task['id'])
        except ServiceError:return None
    with ThreadPoolExecutor(max_workers=8) as pool:assert sum(x is not None for x in pool.map(claim,range(8)))==1
    with pytest.raises(ServiceError):scope.creation.complete(dict(taskId=task['id'],status='completed',titles=['标题'],body='正文',images=[],message='数量不足'))
    scope.creation.complete(dict(taskId=task['id'],status='partial',titles=['标题'],body='正文',images=['https://example.com/a.png'],imageProvider='合成供应商',message='仅合成一张'))
    with ThreadPoolExecutor(max_workers=6) as pool:results=list(pool.map(lambda _:scope.studio.create(brief()),range(6)))
    assert sum(r['fresh'] for r in results)==1
    task=results[0]['task']
    def edit(title):
        try:return scope.studio.update(task['id'],1,dict(title=title,status='review'))
        except ServiceError:return None
    with ThreadPoolExecutor(max_workers=2) as pool:assert sum(r is not None for r in pool.map(edit,['A','B']))==1
    pub=scope.publish.create(dict(accountId='a',title='标题',body='正文',media=['https://example.com/a.png'],delivery='draft',requestId='synthetic-publish'))
    scope.publish.claim(pub['id'])
    with pytest.raises(ServiceError,match='证据'):scope.publish.complete(dict(taskId=pub['id'],status='draft_saved',message='无证据'))
    assert scope.publish.complete(dict(taskId=pub['id'],status='draft_saved',message='合成证据',evidence='synthetic-test-page'))['status']=='draft_saved'


def test_real_encrypted_profiles_and_template_revision_snapshots(live,tmp_path):
    srv,owner,db=live;scope=srv.for_workspace('owner')
    scope.models.save(model());first=scope.models.profiles()['activeId']
    scope.models.save(model('第二组','https://second.example.com/v1'),as_new=True)
    scope.models.activate(first);assert scope.models.read()==model()
    assert 'synthetic-not-real' not in json.dumps(scope.models.profiles())
    ciphertext=srv.db.rows('owner','SELECT ciphertext FROM model_config WHERE tenant_id=%s',('owner',))
    assert 'synthetic-not-real' not in json.dumps(ciphertext)
    key=scope.models.key_path.read_bytes();scope.models.key_path.unlink()
    with pytest.raises(ServiceError,match='密钥缺失'):scope.models.read()
    assert not scope.models.key_path.exists();scope.models.key_path.write_bytes(key)
    row=scope.templates.create(template());scope.templates.publish(row['id'],1)
    scope.templates.update(row['id'],{**template(),'title':'新标题'},1)
    assert scope.templates.published()[0]['title']=='模板标题'
    with pytest.raises(ServiceError,match='更新'):scope.templates.publish(row['id'],1)
    assert scope.templates.publish(row['id'],2)['published']['title']=='新标题'


def test_real_sync_leases_claim_once_and_terminal_callbacks_remain_immutable(live):
    from app.sync import SyncJobs
    srv,owner,db=live;scope=srv.for_workspace('owner');scope.store.add_account(account())
    registered=srv.auth.register(dict(username='other',password='synthetic-password'),ip='sync-other')
    jobs=SyncJobs(srv.db,'owner')
    initial=dict(accountId='a',profile='local:a',status='running',stage='starting',message='合成同步',counts=dict(notes=0,comments=0,messages=0),startedAt='2026-10-13T00:00:00Z')
    with ThreadPoolExecutor(max_workers=6) as pool:
        results=list(pool.map(lambda _:jobs.create({**initial,'id':str(uuid.uuid4())}),range(6)))
    assert sum(row['fresh'] for row in results)==1
    task=results[0]['state'];identifier=task['id']
    jobs.update(identifier,dict(stage='queued',queuePosition=1))
    remaining=srv.db.rows('owner','SELECT EXTRACT(EPOCH FROM lease_until-now()) AS remaining FROM job WHERE tenant_id=%s AND id=%s',('owner',identifier))[0]['remaining']
    assert 18*60<float(remaining)<=19*60
    assert SyncJobs(srv.db,registered['workspace']).read(identifier) is None
    blocked=jobs.update(identifier,dict(status='blocked',stage='blocked',message='合成停止',stopConfirmed=False,error='合成中断',finishedAt='2026-10-13T00:01:00Z'))
    assert jobs.update(identifier,dict(status='complete',stopConfirmed='true',counts=dict(notes=99)))==blocked
    attempt=srv.db.rows('owner','SELECT finished_at,result FROM job_attempt WHERE tenant_id=%s AND job_id=%s',('owner',identifier))
    confirmed=jobs.update(identifier,dict(status='running',stage='notes',stopConfirmed=True,message='停止确认',counts=dict(notes=99),error='旧回调'))
    assert confirmed=={**blocked,'stopConfirmed':True,'message':'停止确认'}
    assert jobs.update(identifier,dict(status='partial',stopConfirmed=True,message='重复确认'))==confirmed
    assert srv.db.rows('owner','SELECT finished_at,result FROM job_attempt WHERE tenant_id=%s AND job_id=%s',('owner',identifier))==attempt
    expired=jobs.create({**initial,'id':str(uuid.uuid4())})['state']['id']
    with psycopg.connect(db['admin'],autocommit=True) as connection:
        connection.execute("UPDATE job SET lease_until=now()-interval '1 second' WHERE tenant_id=%s AND id=%s",('owner',expired))
    assert jobs.read(expired)['status']=='blocked'
    assert srv.db.rows('owner','SELECT result FROM job_attempt WHERE tenant_id=%s AND job_id=%s',('owner',expired))==[{'result':'blocked'}]


def test_real_connector_pairing_bindings_device_runs_and_revocation(live):
    from app.gateway import PostgresPairing, ConnectorError
    srv,owner,db=live
    registered=srv.auth.register(dict(username='other',password='synthetic-password'),ip='pair-other')
    pairing=PostgresPairing(srv.db)
    issued=pairing.create('owner')
    device=pairing.register(issued['code'],'合成电脑','win32','4.0.0')
    assert pairing.authenticate(device['deviceToken'])['workspace']=='owner'
    with pytest.raises(ConnectorError):pairing.register(issued['code'],'重复电脑','win32','4.0.0')
    assert pairing.device_by_id(device['deviceId'],registered['workspace']) is None
    pairing.storage_bind('owner','local:a',device['deviceId'])
    pairing.storage_select('owner',device['deviceId'])
    run=str(uuid.uuid4());pairing.storage_run('owner',run,device['deviceId'],'local:a','sync')
    reopened=PostgresPairing(srv.db)
    assert reopened.storage_binding('owner','local:a')==device['deviceId']
    assert reopened.storage_selected('owner')==device['deviceId']
    assert reopened.storage_run('owner',run)==dict(device_id=device['deviceId'],profile='local:a',kind='sync')
    assert reopened.storage_run(registered['workspace'],run) is None
    assert reopened.heartbeat(device['deviceToken'])['ok'] is True
    reopened.revoke(device['deviceId'],'owner')
    with pytest.raises(ConnectorError):reopened.authenticate(device['deviceToken'])


def _migration_module():
    spec=importlib.util.spec_from_file_location('matrix_test_migrate_postgres',BACKEND/'tools'/'migrate_postgres.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def test_real_database_connection_failure_reports_503_without_sqlite(live):
    from fastapi.testclient import TestClient
    from app.api import create_app
    srv, _, database = live
    app = create_app(settings=srv.settings, services=srv)
    with TestClient(app, base_url='https://test.example') as client:
        assert client.get('/api/health').json()['storage'] == 'postgresql'
        original = srv.db.url
        try:
            # Only this isolated test client's connection changes. The real
            # PostgreSQL server rejects the nonexistent role; no service stops.
            srv.db.url = make_conninfo(original, user='matrix_nonexistent_test_role')
            response = client.get('/api/health')
            assert response.status_code == 503
            assert not list(srv.root.rglob('*.sqlite'))
        finally:
            srv.db.url = original
        assert client.get('/api/health').status_code == 200


def test_real_offline_migration_preserves_auth_tasks_media_templates_and_cipher(database,tmp_path):
    source=tmp_path/'synthetic-legacy';source.mkdir()
    local=Services(Settings(data_dir=source,platform_admin_username='platform'))
    login=local.auth.setup(dict(username='platform',password='synthetic-password'))
    owner=local.auth.identity('zhixu_session='+login['token'])
    local.auth.create_member(owner,dict(username='operator',password='synthetic-password',role='operator',displayName='操作员'))
    local.auth.update_member(owner,'operator',dict(enabled=False))
    registered=local.auth.register(dict(username='customer',password='synthetic-password'),ip='customer')
    local.auth.update_tenant(owner,registered['workspace'],dict(enabled=False))
    scope=local.for_workspace('owner');scope.store.import_snapshot(snapshot())
    with scope.store.state(True) as state:state['members'].append(dict(id='member-legacy',name='历史成员',role='operator',avatar=''))
    lead=scope.store.create_lead_from_comment('c',dict(level='high',ownerId='member-legacy'))
    scope.store.add_follow_up(lead['id'],'迁移合成跟进','platform')
    scope.creation.create(creation('migration-create'))
    studio=scope.studio.create(brief('migration-studio'))['task'];scope.studio.update(studio['id'],1,dict(status='review',title='合成标题',body='合成正文'))
    scope.templates.create(template());scope.models.save(model())
    sync_id=str(uuid.uuid4())
    (source/'xhs-sync').mkdir()
    sync_record=dict(id=sync_id,accountId='a',profile='local:a',status='completed',startedAt='2026-10-13T00:00:00Z',finishedAt='2026-10-13T00:01:00Z',counts={'notes':1})
    (source/'xhs-sync'/f'{sync_id}.json').write_text(json.dumps(sync_record),encoding='utf-8')
    original=(source/'operations.sqlite').read_bytes();encrypted=(source/'model-settings.enc').read_bytes()
    migration=_migration_module()
    report=migration.migrate(source,database['admin'],app_role=database['role'])
    assert report['verified'] and len(report['tenants'])==2
    assert (source/'operations.sqlite').read_bytes()==original and (source/'model-settings.enc').read_bytes()==encrypted
    migrated=Services(Settings(data_dir=source,database_url=database['app'],platform_admin_username='platform'))
    assert migrated.auth.identity('zhixu_session='+login['token'])['workspace']=='owner'
    assert migrated.auth.identity('zhixu_session='+registered['token']) is None
    migrated_scope=migrated.for_workspace('owner')
    assert migrated_scope.store.list_leads()[0]['ownerId']=='member-legacy'
    assert migrated_scope.store.list_notes()[0]['mediaAssets']==snapshot()['notes'][0]['mediaAssets']
    assert migrated_scope.models.read()==model()
    assert migrated.db.rows('owner','SELECT payload FROM job WHERE tenant_id=%s AND id=%s',('owner',sync_id))==[{'payload':sync_record}]
    assert migrated_scope.templates.list()[0]['draft']==template()
    assert migrated_scope.studio.get(studio['id'])['status']=='review'
    assert next(row for row in migrated.auth.team(owner)['items'] if row['username']=='operator')['enabled'] is False
    assert all(row.get('alreadyMigrated') for row in migration.migrate(source,database['admin'],app_role=database['role'])['tenants'])
    migrated.close();local.close()
