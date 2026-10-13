import base64
import hashlib
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.settings import Settings
from app.services import Services


def services(tmp_path):
    return Services(Settings(data_dir=tmp_path, public_origin='http://localhost:4175'))


def test_queue_claim_is_atomic_and_duplicates_cannot_change_input(tmp_path):
    scope = services(tmp_path).for_workspace('owner')
    input = dict(topic='合成测试', sellingPoints='', audience='', style='', imageCount=12, requestId='test-request-01')
    task = scope.creation.create(input)
    assert scope.creation.create(input)['id'] == task['id']
    with pytest.raises(ValueError, match='重复请求'):
        scope.creation.create({**input, 'imageCount': 1})
    def claim():
        try:
            return scope.creation.claim(task['id'])
        except ValueError:
            return None
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(x is not None for x in pool.map(lambda _: claim(), range(8))) == 1
    with pytest.raises(ValueError, match='数量不足'):
        scope.creation.complete(dict(taskId=task['id'],status='completed',titles=['标题'],body='正文',images=[],message='完成'))
    assert scope.creation.get(task['id'])['status'] == 'running'
    result=scope.creation.complete(dict(taskId=task['id'],status='failed',message='合成失败'))
    assert result['status']=='failed'


def test_legacy_operations_payload_and_workspace_isolation(tmp_path):
    legacy=dict(accounts=[dict(id='acct',handle='abc')],notes=[],comments=[],leads=[],followUps=[],members=[],syncRuns=[],templates=[])
    with sqlite3.connect(tmp_path/'operations.sqlite') as db:
        db.execute('CREATE TABLE operations_state(id INTEGER PRIMARY KEY,payload TEXT NOT NULL)')
        db.execute('INSERT INTO operations_state VALUES(1,?)',(json.dumps(legacy),))
    srv=services(tmp_path)
    assert srv.for_workspace('owner').store.list_accounts()==legacy['accounts']
    other=srv.for_workspace('11111111-1111-4111-8111-111111111111')
    assert other.store.list_accounts()==[]
    with pytest.raises(ValueError):
        srv.for_workspace('../owner')
    with pytest.raises(ValueError, match='归属'):
        other.store.import_snapshot(dict(account=dict(id='x',handle='x'),notes=[dict(id='n',accountId='acct')],comments=[]))


def test_node_scrypt_hash_and_cookie_remain_readable(tmp_path):
    salt='000102030405060708090a0b0c0d0e0f'
    expected=hashlib.scrypt(b'password-1234',salt=salt.encode(),n=16384,r=8,p=1,dklen=64).hex()
    with sqlite3.connect(tmp_path/'accounts.sqlite') as db:
        db.executescript('CREATE TABLE administrator(id INTEGER PRIMARY KEY,username TEXT,salt TEXT,hash TEXT); CREATE TABLE sessions(hash TEXT PRIMARY KEY,expires INTEGER);')
        db.execute('INSERT INTO administrator VALUES(1,?,?,?)',('legacy',salt,expected))
    srv=services(tmp_path)
    login=srv.auth.authenticate(dict(username='Legacy',password='password-1234'))
    cookie='zhixu_session='+login['token']
    assert srv.auth.identity(cookie)['workspace']=='owner'
    srv.auth.logout(cookie)
    assert srv.auth.identity(cookie) is None


def test_node_cipher_format_and_missing_key_refuse_overwrite(tmp_path):
    key=b'k'*32
    iv=b'i'*12
    settings=dict(label='原供应商',protocol='chat-completions',baseUrl='https://example.com/v1',model='unchanged',apiKey='synthetic-secret',imageModel='gpt-image-1')
    encrypted=AESGCM(key).encrypt(iv,json.dumps(settings).encode(),None)
    original=base64.b64encode(iv+encrypted[-16:]+encrypted[:-16]).decode()
    (tmp_path/'model-encryption-key').write_bytes(key)
    (tmp_path/'model-settings.enc').write_text(original)
    models=services(tmp_path).for_workspace('owner').models
    assert models.read()==settings
    assert 'apiKey' not in models.summary()
    models.save({k:v for k,v in settings.items() if k!='apiKey'})
    assert models.read()['apiKey']=='synthetic-secret'
    (tmp_path/'model-encryption-key').unlink()
    with pytest.raises(ValueError, match='密钥缺失'):
        services(tmp_path).for_workspace('owner').models.read()
    assert not (tmp_path/'model-encryption-key').exists()


def test_publish_requires_evidence_and_unknown_results_never_requeue(tmp_path):
    q=services(tmp_path).for_workspace('owner').publish
    t=q.create(dict(accountId='a',title='标题',body='正文',media=['https://example.com/a.png'],delivery='draft',requestId='publish-request'))
    q.claim(t['id'])
    with pytest.raises(ValueError, match='证据'):
        q.complete(dict(taskId=t['id'],status='draft_saved',message='声称完成'))
    with pytest.raises(ValueError, match='取消'):
        q.cancel(t['id'])
    assert services(tmp_path).for_workspace('owner').publish.get(t['id'])['status']=='running'


def test_billing_topup_is_idempotent_and_keeps_original_prices(tmp_path):
    b=services(tmp_path).for_workspace('owner').billing
    order=b.create_topup_order('pro')
    assert order['credits']==5000
    b.complete_topup(order['id'],'synthetic-payment')
    b.complete_topup(order['id'],'synthetic-payment')
    assert b.summary()['balanceCredits']==8000
