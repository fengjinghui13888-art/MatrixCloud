import asyncio
import base64
import hashlib
import io
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import bcrypt
import pytest
from PIL import Image

from app.auth import role_allows
from app.models import approved_url, call_model, generate_images, edit_images
from app.postgres import Postgres, PostgresStore
from app.services import Services
from app.settings import Settings
from app.store import ServiceError
from app.store import Store
from app.templates import decode_template_image


@pytest.fixture
def srv(tmp_path):return Services(Settings(data_dir=tmp_path,public_origin='https://workspace.example.com',platform_admin_username='platform'))


def image_data():
    buf=io.BytesIO();Image.new('RGB',(20,20),'red').save(buf,'PNG')
    return 'data:image/png;base64,'+base64.b64encode(buf.getvalue()).decode()


def snapshot():
    return dict(account=dict(id='a',name='客户',handle='customer',avatar='',profile='profile-a',state='connected',followers=0,lastSyncedAt='2026-01-01'),notes=[dict(id='n',accountId='a',title='标题',summary='完整正文',cover='https://example.com/a.png',url='https://xiaohongshu.com/n',publishedAt='2026-01-01',metrics=dict(likes=1,collects=2,comments=3,shares=4),mediaAssets=[dict(id='asset',kind='image',index=0,sourceUrl='https://example.com/a.png',path='a/x/y/n/a.png',bytes=100,sha256='x')],images=['https://example.com/a.png'])],comments=[dict(id='c',accountId='a',noteId='n',author='合成人物',avatar='',body='咨询',createdAt='2026-01-01',status='pending',tags=[])],messages=[dict(id='dm',accountId='a',conversationId='thread',author='客户',body='咨询',createdAt='2026-01-01',direction='incoming')])


def test_snapshot_merge_preserves_media_and_comment_workflow(srv):
    store=srv.for_workspace('owner').store
    value=snapshot();store.import_snapshot(value)
    lead=store.create_lead_from_comment('c',dict(level='high',ownerId='synthetic-owner'))
    store.add_follow_up(lead['id'],'回访','业务员')
    incoming=snapshot();incoming['notes'][0].pop('mediaAssets');incoming['notes'][0].pop('images');incoming['notes'][0]['metrics']['likes']=None
    incoming['comments'][0]['body']='新咨询';incoming['comments'][0]['status']='ignored'
    store.import_snapshot(incoming)
    note=store.list_notes()[0]
    assert note['mediaAssets']==value['notes'][0]['mediaAssets']
    assert note['metrics']['likes']==1
    assert store.get_comment('c')['status']=='lead_created'
    assert store.get_comment('c')['body']=='新咨询'
    assert store.create_lead_from_comment('c',dict(level='medium'))['id']==lead['id']
    deletion=store.delete_lead(lead['id'])
    assert deletion['followUps']==1 and store.get_comment('c')['status']=='pending'


def test_legacy_manual_lead_creation_deduplicates_without_a_loaded_comment(tmp_path):
    # Existing Node store.test.ts supported independent CRM creation in JSON stores.
    file=tmp_path/'legacy-store.json';store=Store(file)
    input=dict(accountId='a',sourceNoteId='n',sourceCommentId='c')
    first=store.create_lead(input);second=store.create_lead(input)
    assert first['id']==second['id']
    store.update_lead(first['id'],dict(ownerId='member-2',status='following'))
    assert Store(file).list_leads()[0]['ownerId']=='member-2'


def test_pg_note_updates_preserve_optional_media_and_metrics_in_atomic_transaction():
    # Exercise inherited business mutation against an isolated normalized-state fixture.
    store=object.__new__(PostgresStore);data=dict(accounts=[],notes=snapshot()['notes'],comments=[],messages=[],leads=[],followUps=[],members=[],syncRuns=[],templates=[])
    @contextmanager
    def state(write=False):yield data
    store.state=state
    incoming=dict(id='n',accountId='a',title='新标题',summary=None,cover=None,url=None,publishedAt='2026-01-02',metrics=dict(likes=None,collects=5,comments=3,shares=4))
    store.upsert_notes([incoming])
    assert data['notes'][0]['summary']=='完整正文' and data['notes'][0]['metrics']['likes']==1
    assert data['notes'][0]['images']==['https://example.com/a.png']


def test_account_delete_cascades_without_deleting_unrelated_scope(srv):
    store=srv.for_workspace('owner').store;store.import_snapshot(snapshot())
    lead=store.create_lead_from_comment('c',dict(level='high'));store.add_follow_up(lead['id'],'回访','业务员')
    scope=srv.for_workspace('22222222-2222-4222-8222-222222222222');scope.store.import_snapshot(snapshot())
    result=store.delete_account('a')
    assert {k:result[k] for k in ('notes','comments','messages','leads','followUps')}==dict(notes=1,comments=1,messages=1,leads=2,followUps=1)
    assert scope.store.list_accounts()[0]['id']=='a'
    assert store.list_accounts()==[]


def test_snapshot_rejects_record_cross_account_conflict_atomically(srv):
    store=srv.for_workspace('owner').store;store.import_snapshot(snapshot())
    bad=snapshot();bad['account']['id']='b';bad['account']['handle']='other'
    for key in ('notes','comments','messages'):
        for row in bad[key]:row['accountId']='b'
    with pytest.raises(ValueError,match='归属冲突'):store.import_snapshot(bad)
    assert len(store.list_accounts())==1


def test_legacy_queue_table_columns_and_receipts_survive_reload(tmp_path,srv):
    task=dict(id='legacy-id',requestId='legacy-req',topic='主题',sellingPoints='',audience='',style='',imageCount=1,status='running',createdAt='2026-01-01')
    with sqlite3.connect(tmp_path/'creation.sqlite') as db:
        db.execute('CREATE TABLE creation_tasks(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL)')
        db.execute('INSERT INTO creation_tasks VALUES(?,?,?,?)',(task['id'],task['requestId'],task['status'],json.dumps(task)))
    scope=srv.for_workspace('owner');assert scope.creation.get('legacy-id')==task
    result=scope.creation.complete(dict(taskId='legacy-id',status='completed',titles=['标题'],body='正文',images=['https://example.com/a.png'],imageProvider='原供应商',message='有证据'))
    assert result['imageProvider']=='原供应商'
    for file,table,columns in [('creation.sqlite','creation_tasks',['id','request_id','status','payload']),('publish.sqlite','publish_queue',['id','request_id','status','payload']),('studio.sqlite','studio_tasks',['id','request_id','revision','payload'])]:
        with sqlite3.connect(tmp_path/file) as db:assert [r[1] for r in db.execute('PRAGMA table_info('+table+')')]==columns


def test_studio_duplicate_revision_and_immutable_identity(srv):
    s=srv.for_workspace('owner').studio
    value=dict(accountId='a',topic='主题',persona='',style='',imageCount=12,size='1024x1536',requestId='studio-request',confirmCharge=True)
    created=s.create(value);task=created['task'];assert created['fresh'] is True
    assert s.create(value)==dict(task=task,fresh=False)
    with pytest.raises(ValueError,match='重复请求'):s.create({**value,'imageCount':1})
    updated=s.update(task['id'],1,dict(status='review',title='标题',body='正文',id='other',accountId='other'))
    assert updated['revision']==2 and updated['id']==task['id'] and updated['accountId']=='a'
    with pytest.raises(ValueError,match='更新'):s.update(task['id'],1,dict(status='approved'))
    assert s.delete(task['id'])['status']=='review'


def test_studio_bulk_delete_is_all_or_nothing_for_busy_tasks(srv):
    s=srv.for_workspace('owner').studio
    def create(req):return s.create(dict(accountId='a',topic='主题',persona='',style='',imageCount=1,size='1024x1024',requestId=req,confirmCharge=True))['task']
    ready=create('ready-request');busy=create('busy-request')
    s.update(ready['id'],1,dict(status='review'))
    with pytest.raises(ValueError,match='执行'):s.delete_many([ready['id'],busy['id']])
    assert len(s.list())==2


def test_templates_upload_duplicate_thumbnail_ownership_and_preserved_original(srv):
    library=srv.for_workspace('owner').templates
    uploaded=library.upload(dict(fileName='照片.png',data=image_data()))
    assert uploaded['duplicate'] is False
    assert library.upload(dict(fileName='另一个名字.png',data=image_data()))['duplicate'] is True
    key=uploaded['item']['images'][0].split('/')[-1]
    file=library.file(key);assert file and file.is_file()
    thumb=library.file(key,thumbnail=True)
    with Image.open(thumb) as image:assert image.format=='WEBP' and image.size==(20,20)
    assert library.references([uploaded['item']['id']])==[image_data()]
    other=srv.for_workspace('33333333-3333-4333-8333-333333333333')
    assert other.templates.file(key) is None
    assert library.file('../'+key) is None
    assert library.bulk_delete([uploaded['item']['id']])=={'deleted':1}
    assert library.file(key) is None and file.exists()


def test_original_personal_template_png_remains_readable(srv):
    original='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
    library=srv.for_workspace('owner').templates
    uploaded=library.upload(dict(fileName='旧图片.png',data=original))
    key=uploaded['item']['images'][0].split('/')[-1]
    assert library.file(key).read_bytes()==base64.b64decode(original.split(',')[1])
    with Image.open(library.file(key,thumbnail=True)) as image:assert image.size==(1,1)


def test_template_revision_authorization_and_old_fingerprint(srv):
    library=srv.for_workspace('owner').templates
    input=dict(name='方案',category='生活方式',title='Ａ B',body='文 案',images=['https://example.com/a.png'],sourceUrl='https://example.com/source',usage='licensed',rightsNote='')
    first=library.create(input)
    assert library.create({**input,'title':'AB','body':'文案'})['id']==first['id']
    with pytest.raises(ValueError,match='授权'):library.publish(first['id'],1)
    updated=library.update(first['id'],{**input,'rightsNote':'已获授权'},1)
    assert updated['revision']==2
    with pytest.raises(ValueError,match='更新'):library.unpublish(first['id'],1)
    assert library.publish(first['id'],2)['published']['revision']==2
    assert len(library.published())==1


def test_media_archive_path_and_account_note_binding(tmp_path,srv):
    assets=srv.for_workspace('owner').assets
    file=tmp_path/'media'/'a'/'x'/'y'/'n'/'a.png';file.parent.mkdir(parents=True);file.write_bytes(b'synthetic')
    assert assets.file('a/x/y/n/a.png','a','n')==file
    assert assets.file('a/x/y/n/a.png','other','n') is None
    assert assets.file('a/x/y/n/../../accounts.sqlite','a','n') is None
    assert assets.file('a\\x\\y\\n\\a.png','a','n') is None


def test_member_permissions_and_session_revocation(srv):
    admin=srv.auth.setup(dict(username='platform',password='synthetic-password'))
    identity=srv.auth.identity('zhixu_session='+admin['token'])
    assert srv.auth.create_member(identity,dict(username='operator',password='synthetic-password',displayName='操作员',role='operator'))=={'ok':True}
    login=srv.auth.authenticate(dict(username='operator',password='synthetic-password'),ip='separate')
    cookie='zhixu_session='+login['token']
    assert srv.auth.identity(cookie)['role']=='operator'
    assert srv.auth.update_member(identity,'operator',dict(enabled=False))=={'ok':True}
    assert srv.auth.identity(cookie) is None
    with pytest.raises(ServiceError,match='账号或密码'):srv.auth.authenticate(dict(username='operator',password='synthetic-password'),ip='separate')
    with pytest.raises(ServiceError,match='自己'):srv.auth.update_member(identity,'platform',dict(role='operator'))


def test_existing_bcrypt_hash_and_session_profile(srv):
    login=srv.auth.register(dict(username='bcrypt-user',password='synthetic-password'))
    encoded=bcrypt.hashpw(b'synthetic-password',bcrypt.gensalt(rounds=4)).decode()
    with srv.auth.transaction() as db:db.execute('UPDATE login_users SET hash=?,salt=? WHERE username=?',(encoded,'','bcrypt-user'))
    result=srv.auth.authenticate(dict(username='bcrypt-user',password='synthetic-password'),old_cookie='zhixu_session='+login['token'],ip='fresh')
    assert srv.auth.identity('zhixu_session='+login['token']) is None
    cookie='zhixu_session='+result['token'];profile=srv.auth.update_profile(cookie,{'displayName':'中文昵称'})
    assert profile['displayName']=='中文昵称' and srv.auth.profile(cookie)['sessionHours']==8


def test_login_limit_origin_role_canonicalization_and_reserved_name(srv):
    for _ in range(10):
        with pytest.raises(ServiceError) as e:srv.auth.authenticate(dict(username='missing',password='synthetic-password'),ip='rate')
        assert e.value.status==401
    with pytest.raises(ServiceError) as e:srv.auth.authenticate(dict(username='missing',password='synthetic-password'),ip='rate')
    assert e.value.status==429
    assert srv.auth.same_origin('https://workspace.example.com',sec_fetch_site='same-origin')
    assert not srv.auth.same_origin('https://workspace.example.com',sec_fetch_site='cross-site')
    assert not role_allows('operator','POST','/API/MODELS/CONFIG/')
    assert role_allows('lead_viewer','GET','/API/LEADS/')
    assert not role_allows('lead_viewer','GET','/api/models')
    with pytest.raises(ServiceError,match='保留'):srv.auth.register(dict(username='platform',password='synthetic-password'),ip='new')


def test_disable_tenant_immediately_invalidates_session_and_scope(srv):
    platform=srv.auth.setup(dict(username='platform',password='synthetic-password'))
    user=srv.auth.register(dict(username='customer',password='synthetic-password'),ip='new')
    admin=srv.auth.identity('zhixu_session='+platform['token'])
    assert srv.auth.update_tenant(admin,user['workspace'],{'enabled':False})=={'ok':True}
    assert srv.auth.identity('zhixu_session='+user['token']) is None
    with pytest.raises(ServiceError,match='停用'):srv.for_workspace(user['workspace'])


def test_model_transport_protocol_and_provider_settings_are_preserved():
    settings=dict(label='供应商',protocol='anthropic-messages',baseUrl='https://example.com/v1',model='existing-model',apiKey='synthetic-key',imageModel='gpt-image-1')
    calls=[]
    async def transport(url,headers,body):
        calls.append((url,headers,body));return {'content':[{'type':'text','text':'正常响应'}]}
    result=asyncio.run(call_model(settings,'提示词',transport,700))
    assert result==dict(text='正常响应',model='existing-model',provider='供应商')
    assert calls[0][0]=='https://example.com/v1/messages' and calls[0][1]['anthropic-version']=='2023-06-01' and calls[0][2]['max_tokens']==700
    async def images(url,headers,body):
        calls.append((url,headers,body));return {'data':[{'url':'https://example.com/1.png'}]}
    asyncio.run(generate_images(settings,'提示词',12,images,'1024x1536'))
    assert calls[-1][2]['n']==12 and calls[-1][2]['size']=='1024x1536'
    agnes={**settings,'imageBaseUrl':'https://api.agnes-ai.cn/v1','imageApiKey':'synthetic-image-key'}
    asyncio.run(generate_images(agnes,'提示词',12,images))
    assert 'n' not in calls[-1][2] and calls[-1][2]['extra_body']=={'response_format':'url'}


def test_reference_edit_sends_original_multipart_and_strength():
    settings=dict(label='供应商',protocol='chat-completions',baseUrl='https://example.com/v1',model='existing',apiKey='synthetic',imageModel='gpt-image-1')
    async def transport(url,headers,body):
        assert url.endswith('/images/edits') and headers['Content-Type'].startswith('multipart/form-data; boundary=matrix-')
        assert '变化意愿 0.6'.encode() in body and b'name="image"' in body and b'\x89PNG' in body
        return {'data':[{'b64_json':'YWJj'}]}
    assert asyncio.run(edit_images(settings,'提示词',image_data(),.6,'1024x1024',transport))=='data:image/png;base64,YWJj'


@pytest.mark.parametrize('url',['http://example.com','https://127.0.0.1','https://[::1]','https://u:p@example.com','https://localhost','https://example.com/path?api_key=bad','https://example.com/#fragment'])
def test_model_transport_rejects_ssrf_before_network(url):
    with pytest.raises(ServiceError):asyncio.run(approved_url(url))


def test_dns_private_address_fails_closed(monkeypatch):
    monkeypatch.setattr('app.models.socket.getaddrinfo',lambda *a:[(2,1,6,'',('10.0.0.1',443))])
    with pytest.raises(ServiceError,match='内网'):asyncio.run(approved_url('https://provider.example.com'))


def test_model_response_size_status_and_actual_deadline_without_provider_call(monkeypatch):
    from app.models import _request, ModelRequestError
    from urllib.parse import urlsplit
    class Socket:
        def settimeout(self,value):pass
    class Response:
        status=503
        def read(self,size):return b''
    class Connection:
        sock=Socket()
        def __init__(self,*args):self.args=args
        def request(self,*args,**kwargs):pass
        def getresponse(self):return Response()
        def close(self):pass
    monkeypatch.setattr('app.models._PinnedHTTPS',Connection)
    with pytest.raises(ModelRequestError) as error:_request(urlsplit('https://provider.example.com/chat/completions'),'8.8.8.8',{}, {})
    assert error.value.code=='HTTP' and error.value.status==503
    Response.status=200
    Response.read=lambda self,size:b'x'*(1024*1024+1)
    with pytest.raises(ModelRequestError) as error:_request(urlsplit('https://provider.example.com/chat/completions'),'8.8.8.8',{}, {})
    assert error.value.code=='SIZE_LIMIT'
    # A slow header plus body cannot reset the 120-second total deadline.
    Response.read=lambda self,size:b''
    ticks=iter([0,121,121,121])
    monkeypatch.setattr('app.models.time.monotonic',lambda:next(ticks))
    with pytest.raises(ModelRequestError) as error:_request(urlsplit('https://provider.example.com/chat/completions'),'8.8.8.8',{}, {})
    assert error.value.code=='TIMEOUT' and '120 秒' in str(error.value)


def test_corrupt_legacy_files_are_never_replaced(tmp_path,srv):
    original='{invalid json'
    (tmp_path/'billing.json').write_text(original)
    with pytest.raises(ValueError):srv.for_workspace('owner').billing.summary()
    assert (tmp_path/'billing.json').read_text()==original


def test_postgres_configured_failure_does_not_fallback_to_sqlite(tmp_path,monkeypatch):
    def connection(_):raise RuntimeError('synthetic DB unavailable')
    monkeypatch.setattr(Postgres,'_connection',connection)
    with pytest.raises(RuntimeError,match='DB unavailable'):Services(Settings(data_dir=tmp_path,database_url='postgresql://synthetic.invalid/synthetic'))
    assert not (tmp_path/'operations.sqlite').exists()


def test_postgres_transaction_sets_local_tenant_and_closes_connection(monkeypatch):
    calls=[]
    class Connection:
        def __enter__(self):return self
        def __exit__(self,*args):calls.append(('closed',args))
        @contextmanager
        def transaction(self):yield self
        def execute(self,sql,params):calls.append((sql,params))
    db=object.__new__(Postgres);db.url='synthetic';monkeypatch.setattr(db,'_connection',lambda:Connection())
    tenant='44444444-4444-4444-8444-444444444444'
    with db.transaction(tenant):pass
    assert calls[0]==("SELECT set_config('app.tenant_id',%s,true)",(tenant,))
    assert calls[-1][0]=='closed'
    with pytest.raises(ServiceError):
        with db.transaction('../owner'):pass
