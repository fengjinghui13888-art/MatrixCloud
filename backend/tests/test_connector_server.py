import asyncio
import json
from pathlib import Path
import httpx
from fastapi.testclient import TestClient
from connector.server import create_connector_app
from connector.sync import SyncCollector,NetworkCapture
from connector.cleanup import ConnectorCleanup

def test_loopback_api_auth_and_passive_state_without_browser_launch(tmp_path):
    app=create_connector_app(tmp_path)
    with TestClient(app,base_url='http://127.0.0.1') as client:
        assert client.get('/health').json()['version']==4
        assert client.get('/verify').status_code==401
        assert client.get('/health',headers={'Host':'evil.example'}).status_code==403
        token=(tmp_path/'connector-token').read_text(); auth={'Authorization':'Bearer '+token}
        assert client.get('/verify',headers=auth).json()['ok']
        state=client.get('/accounts/a/state',headers=auth)
        assert state.status_code==200 and not state.json()['connected']
        assert app.state.connector.browser.playwright is None
        assert client.post('/accounts/a/resume',headers=auth,json={}).status_code==400

def test_sync_result_media_is_scoped_to_task_and_rejects_symlink_escape(tmp_path):
    app=create_connector_app(tmp_path); runtime=app.state.connector; auth={'Authorization':'Bearer '+runtime.token}
    id='c9014397-9dd5-4daa-8f84-4918408414fd'; directory=tmp_path/'sync-jobs'/id; directory.mkdir(parents=True)
    (directory/'result.json').write_text(json.dumps(dict(notes=[dict(mediaAssets=[dict(id='a'*32,path='../connector-token')])])) )
    (tmp_path/'sync-media').mkdir()
    with TestClient(app,base_url='http://127.0.0.1') as client:
        assert client.get('/sync/'+id+'/media/'+'b'*32,headers=auth).status_code==404
        assert client.get('/sync/'+id+'/media/'+'a'*32,headers=auth).status_code==404

def test_unknown_payload_does_not_claim_a_job_or_call_browser(tmp_path):
    app=create_connector_app(tmp_path); auth={'Authorization':'Bearer '+app.state.connector.token}
    with TestClient(app,base_url='http://127.0.0.1') as client:
        response=client.post('/studio',headers=auth,json=dict(runId='bad'))
        assert response.status_code==400
        assert app.state.connector.browser.playwright is None

def test_sync_collector_accepts_only_authenticated_owned_notes_and_comments():
    c=SyncCollector(dict(id='a',handle='42',name='Account'),[dict(id='old',accountId='a')],['known'],[],mode='incremental')
    def record(path,body):c.record(dict(url='https://www.xiaohongshu.com'+path,path=path,body=dict(data=body)))
    record('/api/galaxy/user/info',dict(redId='42',userId='u'))
    record('/api/galaxy/creator/note/user/posted',dict(notes=[dict(id='own',title='Owned',type='normal',image_list=[])]))
    record('/api/sns/web/v1/user/selfinfo',dict(user_id='u',red_id='42'))
    record('/api/sns/web/v2/comment/page?note_id=own',dict(comments=[]))
    c.merge(dict(notes=[dict(id='public',accountId='a',title='Public',images=[])],comments=[],messages=[]))
    assert 'public' not in c.notes
    c.consume()
    c.merge(dict(notes=[],comments=[dict(id='known',noteId='own'),dict(id='fresh',noteId='old'),dict(id='foreign',noteId='other')],messages=[]))
    assert set(c.comments)=={'fresh'}

def test_cleanup_preserves_profiles_original_media_and_changed_cache(tmp_path):
    import os,time
    class Jobs:
        def busy(self):return False
    cache=tmp_path/'generated-cache'/'draft-abc';cache.mkdir(parents=True)
    image=cache/'12.png'; image.write_bytes(b'old'); os.utime(image,(time.time()-100000,time.time()-100000))
    profile=tmp_path/'a'/'chrome-profile'; profile.mkdir(parents=True); (profile/'Cookies').write_bytes(b'login')
    cleanup=ConnectorCleanup(tmp_path,Jobs()); manifest=cleanup.preview(); assert manifest['bytes']==3
    image.write_bytes(b'new'); result=cleanup.apply(manifest['id'])
    assert result['reclaimedBytes']==0 and image.exists() and (profile/'Cookies').read_bytes()==b'login'
