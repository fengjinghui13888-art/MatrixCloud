from unittest.mock import AsyncMock
from fastapi.testclient import TestClient
from app.api import create_app
from app.settings import Settings
from app.admin_permissions import save_member,principal


def test_stored_content_is_super_only_scoped_and_never_calls_connector(tmp_path):
    app=create_app(Settings(data_dir=tmp_path,public_origin='http://localhost',platform_admin_username='platform'))
    runtime=app.state.runtime;auth=runtime.services.auth
    owner=auth.setup(dict(username='platform',password='platform-password'),ip='setup')
    first=auth.register(dict(username='customer',password='customer-password'),ip='first')
    second=auth.register(dict(username='another',password='another-password'),ip='second')
    scope,execution,_=runtime.workspace(first['workspace'])
    scope.store.add_account(dict(id='a',name='合成账号',handle='123',avatar='',profile='local:fixture',state='connected',followers=0,lastSyncedAt=''))
    runtime.workspace(second['workspace'])[0].store.add_account(dict(id='b',name='其他客户账号',handle='456',avatar='',profile='local:other',state='connected',followers=0,lastSyncedAt=''))
    save_member(auth,principal(auth,auth.identity('zhixu_session='+owner['token'])),dict(username='delegate',password='delegate-password',displayName='客服',permissions=['customers.read']))
    h={'Origin':'http://localhost'};base='/api/platform-admin/customers/'+first['workspace']+'/accounts'
    with TestClient(app,base_url='http://localhost') as c:
        assert c.get(base).status_code==401
        c.post('/api/platform-admin/login',json=dict(username='delegate',password='delegate-password'),headers=h)
        assert c.get(base).status_code==403
        c.post('/api/platform-admin/login',json=dict(username='platform',password='platform-password'),headers=h)
        r=c.get(base);assert r.status_code==200 and r.headers['cache-control']=='no-store'
        assert [a['id'] for a in r.json()['items']]==['a'] and 'profile' not in r.text
        assert c.get(base+'/b/notes').status_code==404
        assert c.get(base+'/a/notes?page=bad').status_code==400
        assert c.get(base+'/a/messages').json()['items']==[]
        assert c.get(base+'/a/media/foreign/foreign').status_code==404
        runtime.channel.json=AsyncMock(side_effect=AssertionError('Historical reads must not call the connector'))
        assert c.get(base+'/a/messages').status_code==200
        assert c.get(base).status_code==200
        assert c.post(base+'/a/sync',json={},headers=h).status_code==404
        runtime.channel.json.assert_not_awaited()
        auth._update_tenant_status(auth.identity('zhixu_session='+owner['token']),first['workspace'],{'enabled':False})
        assert c.get(base).status_code==200
