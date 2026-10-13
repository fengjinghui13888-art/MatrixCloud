import copy
import pytest
from fastapi.testclient import TestClient
from app.api import create_app
from app.settings import Settings


def snapshot():
    return dict(account=dict(id='a',name='Synthetic',handle='10001',profile='local:fixture',avatar='',state='connected',followers=0,lastSyncedAt=''),notes=[dict(id='n',accountId='a',title='Synthetic',summary=None,cover=None,url=None,publishedAt='',metrics=dict(likes=1,collects=2,comments=3,shares=4))],comments=[],messages=[])


@pytest.mark.parametrize('fault',['account','metrics-list','metrics-string','negative-count','boolean-count','media-url','invalid-port','port-range','comment-shape'])
def test_invalid_snapshot_is_rejected_without_corrupting_saved_state(tmp_path,fault):
    app=create_app(Settings(data_dir=tmp_path,service_token='s'*64))
    headers={'Authorization':'Bearer '+'s'*64}
    with TestClient(app,raise_server_exceptions=False) as client:
        original=snapshot()
        assert client.post('/api/import',json=original,headers=headers).status_code==200
        broken=copy.deepcopy(original)
        if fault=='account':broken['account']={'id':'a'}
        elif fault=='metrics-list':broken['notes'][0]['metrics']=[]
        elif fault=='metrics-string':broken['notes'][0].update(id='new',metrics='invalid')
        elif fault=='negative-count':broken['notes'][0]['metrics']['likes']=-1
        elif fault=='boolean-count':broken['notes'][0]['metrics']['likes']=True
        elif fault=='media-url':broken['notes'][0]['images']=['file:///C:/private.png']
        elif fault=='invalid-port':broken['notes'][0]['images']=['https://example.com:invalid/a.png']
        elif fault=='port-range':broken['notes'][0]['images']=['https://example.com:99999/a.png']
        else:broken['comments']=[{'id':'c'}]
        assert client.post('/api/import',json=broken,headers=headers).status_code==400
        store=app.state.services.for_workspace('owner').store
        assert store.list_notes()==original['notes']
        assert store.list_accounts()==[original['account']]
        partial=copy.deepcopy(original)
        partial['notes'][0]['metrics']={k:None for k in original['notes'][0]['metrics']}
        assert client.post('/api/import',json=partial,headers=headers).status_code==200
        assert store.list_notes()[0]['metrics']==original['notes'][0]['metrics']
