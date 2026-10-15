from fastapi.testclient import TestClient
from app.api import create_app
from app.settings import Settings

def test_subadmins_have_individual_logins_limits_and_backend_permissions(tmp_path):
    app=create_app(Settings(data_dir=tmp_path,public_origin='http://localhost',platform_admin_username='platform',service_token='s'*64))
    auth=app.state.services.auth;auth.setup(dict(username='platform',password='platform-password'))
    customer=auth.register(dict(username='customer',password='customer-password'),ip='customer')
    h={'Origin':'http://localhost'}
    with TestClient(app,base_url='http://localhost') as root:
        sub=TestClient(app,base_url='http://localhost')
        root.post('/api/platform-admin/login',json=dict(username='platform',password='platform-password'),headers=h)
        body=dict(username='assistant1',displayName='客户查看',password='assistant-password',permissions=['customers.read'])
        r=root.post('/api/platform-admin/admins',json=body,headers=h)
        assert r.status_code==201
        assert root.post('/api/platform-admin/admins',json={**body,'username':'assistant2'},headers=h).status_code==201
        assert root.post('/api/platform-admin/admins',json={**body,'username':'assistant3'},headers=h).status_code==201
        assert root.post('/api/platform-admin/admins',json={**body,'username':'assistant4'},headers=h).status_code==409
        login=sub.post('/api/platform-admin/login',json=dict(username='assistant1',password='assistant-password'),headers=h)
        assert login.status_code==200 and login.json()['isSuper'] is False
        assert sub.get('/api/platform-admin/customers').status_code==200
        assert all(not c['devices'] for c in sub.get('/api/platform-admin/customers').json()['items'])
        assert sub.get('/api/platform-admin/audit').status_code==403
        assert sub.get('/api/platform-admin/devices').status_code==403
        assert sub.get('/api/platform-admin/admins').status_code==403
        assert sub.post('/api/platform-admin/admins/assistant1',json={'permissions':['audit.read']},headers=h).status_code==403
        assert sub.post('/api/platform-admin/customers/'+customer['workspace']+'/status',json={'enabled':False},headers=h).status_code==403
        assert sub.post('/api/platform-admin/customers/'+customer['workspace']+'/recovery',json={'username':'customer'},headers=h).status_code==403
        assert sub.post('/api/auth/login',json=dict(username='assistant1',password='assistant-password'),headers=h).status_code==403
        token=auth.authenticate(dict(username='assistant1',password='assistant-password'),ip='check')['token']
        assert auth.identity('zhixu_session='+token) is None
        assert auth.identity('zhixu_session='+token,allow_platform=True)['username']=='assistant1'
        assert root.post('/api/platform-admin/admins/assistant1',json={'permissions':['admins.manage']},headers=h).status_code==400
        assert root.post('/api/platform-admin/admins/assistant1',json={'role':'super_admin'},headers=h).status_code==400
        assert root.post('/api/platform-admin/admins/platform',json={'enabled':False},headers=h).status_code==404
        assert root.post('/api/platform-admin/admins/assistant1',json={'permissions':['customers.read','audit.read']},headers=h).status_code==200
        assert sub.get('/api/platform-admin/session').status_code==401
        sub.post('/api/platform-admin/login',json=dict(username='assistant1',password='assistant-password'),headers=h)
        assert sub.get('/api/platform-admin/audit').status_code==200
        assert root.post('/api/platform-admin/admins/assistant1',json={'enabled':False},headers=h).status_code==200
        assert sub.get('/api/platform-admin/session').status_code==401
        assert sub.post('/api/platform-admin/login',json=dict(username='assistant1',password='assistant-password'),headers=h).status_code==401
