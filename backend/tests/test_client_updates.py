import io
import json
import hashlib
import zipfile
import time
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
from client.updates import UpdateStore, canonical, verify_manifest, RUNTIME_ABI


def release(key, version=1, files=None):
    files = files or {'connector/__init__.py': b'', 'connector/__main__.py': b'VALUE=1', 'app/__init__.py': b'', 'app/protocols.py': b'PROTOCOL_VERSION=4'}
    out = io.BytesIO()
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
        for name, blob in files.items(): z.writestr(name,blob)
    blob=out.getvalue()
    manifest=dict(format=1,revision=version,protocol=4,abi=RUNTIME_ABI,expires=int(time.time())+86400,package=f'/api/connector/client/packages/{version}.zip',bytes=len(blob),sha256=hashlib.sha256(blob).hexdigest(),files={n:hashlib.sha256(b).hexdigest() for n,b in files.items()})
    envelope={'manifest':manifest,'signature':key.sign(canonical(manifest)).hex()}
    return envelope,blob


@pytest.fixture
def key():return Ed25519PrivateKey.generate()

def public(key):return key.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw).hex()


def test_signed_update_is_installed_without_touching_account_data(tmp_path,key):
    data=tmp_path/'accounts';data.mkdir();(data/'connector-token').write_text('private')
    store=UpdateStore(tmp_path/'client',public(key));envelope,blob=release(key)
    path=store.stage(envelope,blob)
    assert (path/'connector/__main__.py').read_bytes()==b'VALUE=1'
    store.activate(1);assert store.state()['current']==1
    assert (data/'connector-token').read_text()=='private'


def test_failed_health_rolls_back_and_blocks_repeated_bad_release(tmp_path,key):
    store=UpdateStore(tmp_path,public(key))
    for version in (1,2):
        envelope,blob=release(key,version);store.stage(envelope,blob)
    store.activate(1);store.confirm(1);store.activate(2);store.rollback(2)
    assert store.state()['current']==1 and 2 in store.state()['rejected']
    with pytest.raises(ValueError):store.stage(*release(key,2))


@pytest.mark.parametrize('field,value',[('revision',0),('protocol',5),('abi','other-runtime'),('expires',0),('package','https://evil.example/package.zip')])
def test_even_signed_incompatible_or_expired_manifests_are_rejected(key,field,value):
    envelope,_=release(key);envelope['manifest'][field]=value;envelope['signature']=key.sign(canonical(envelope['manifest'])).hex()
    with pytest.raises(ValueError):verify_manifest(envelope,public(key))


def test_tampered_manifest_and_archive_are_rejected(tmp_path,key):
    store=UpdateStore(tmp_path,public(key));envelope,blob=release(key)
    envelope['manifest']['revision']=2
    with pytest.raises(ValueError):store.stage(envelope,blob)
    envelope,blob=release(key)
    with pytest.raises(ValueError):store.stage(envelope,blob+b'tamper')


@pytest.mark.parametrize('name',['../private','connector/../../private','connector/token.json','app/api.py','connector\\evil.py'])
def test_signed_archive_cannot_escape_or_replace_non_connector_code(tmp_path,key,name):
    envelope,blob=release(key,files={'connector/__init__.py':b'', 'connector/__main__.py':b'', 'app/__init__.py':b'', 'app/protocols.py':b'', name:b'bad'})
    with pytest.raises(ValueError):UpdateStore(tmp_path,public(key)).stage(envelope,blob)


def test_old_release_cannot_downgrade_current_version(tmp_path,key):
    store=UpdateStore(tmp_path,public(key));store.stage(*release(key,2));store.activate(2);store.confirm(2)
    with pytest.raises(ValueError):store.stage(*release(key,1))


def test_busy_worker_is_not_stopped_for_update(tmp_path,key):
    from client.launcher import switch_when_idle
    calls=[]
    assert not switch_when_idle(True,lambda:calls.append('stop'),lambda:calls.append('start'))
    assert calls==[]
    assert switch_when_idle(False,lambda:calls.append('stop'),lambda:calls.append('start'))
    assert calls==['stop','start']


def test_supervisor_recovers_unconfirmed_version_after_process_restart(tmp_path,key,monkeypatch):
    from client.launcher import Supervisor
    store=UpdateStore(tmp_path,public(key))
    for version in (1,2):store.stage(*release(key,version))
    store.activate(1);store.confirm(1);store.activate(2)
    supervisor=Supervisor(dict(installRoot=str(tmp_path),publicKey=public(key),openOnStart=False),tmp_path/'config.json');calls=[]
    class Child:
        def poll(self):return None
    def launch(version):
        calls.append(version)
        if version==2:raise RuntimeError('unhealthy candidate')
        supervisor.child=Child();supervisor.store.confirm(version)
    monkeypatch.setattr(supervisor,'launch',launch);monkeypatch.setattr(supervisor,'check',lambda:None);monkeypatch.setattr(supervisor,'stop_worker',lambda:None)
    supervisor.run(once=True)
    assert calls==[2,1] and supervisor.store.state()['current']==1


def test_busy_race_defers_update_without_killing_supervisor(tmp_path,key,monkeypatch):
    import httpx
    import client.launcher as launcher
    store=UpdateStore(tmp_path,public(key));store.stage(*release(key,1));store.activate(1);store.confirm(1);store.stage(*release(key,2))
    supervisor=launcher.Supervisor(dict(installRoot=str(tmp_path),publicKey=public(key),cloudUrl='https://cloud.example'),tmp_path/'config.json')
    monkeypatch.setattr(launcher,'fetch_update',lambda *_:None)
    monkeypatch.setattr(supervisor,'api',lambda *_:{'busy':False})
    def busy():raise httpx.HTTPStatusError('new browser task',request=httpx.Request('POST','http://127.0.0.1/client-stop'),response=httpx.Response(409))
    monkeypatch.setattr(supervisor,'stop_worker',busy)
    try:
        supervisor.check()
        assert supervisor.pending==2 and supervisor.store.state()['current']==1
    finally:supervisor.client.close()


def test_exit_waits_until_stop_is_confirmed_after_busy_race(tmp_path,key,monkeypatch):
    import httpx
    from client.launcher import Supervisor
    store=UpdateStore(tmp_path,public(key));store.stage(*release(key));store.activate(1);store.confirm(1)
    supervisor=Supervisor(dict(installRoot=str(tmp_path),publicKey=public(key),openOnStart=False),tmp_path/'config.json');supervisor.stopping=True;calls=[]
    class Child:
        stopped=False
        def poll(self):return 0 if self.stopped else None
    child=Child();monkeypatch.setattr(supervisor,'launch',lambda *_:setattr(supervisor,'child',child));monkeypatch.setattr(supervisor,'api',lambda *_:{'busy':False});monkeypatch.setattr('client.launcher.time.sleep',lambda *_:None)
    def stop():
        calls.append('stop')
        if len(calls)==1:raise httpx.HTTPStatusError('busy race',request=httpx.Request('POST','http://127.0.0.1/client-stop'),response=httpx.Response(409))
        child.stopped=True
    monkeypatch.setattr(supervisor,'stop_worker',stop)
    supervisor.run()
    assert calls==['stop','stop'] and child.stopped
