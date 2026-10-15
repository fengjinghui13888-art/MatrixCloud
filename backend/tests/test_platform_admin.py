from fastapi.testclient import TestClient
from app.api import create_app
from app.settings import Settings


def test_admin_self_password_requires_current_password_and_revokes_sessions(tmp_path):
    app=create_app(Settings(data_dir=tmp_path,public_origin='http://localhost',platform_admin_username='platform'))
    auth=app.state.services.auth
    auth.setup(dict(username='platform',password='platform-password'),ip='setup')
    h={'Origin':'http://localhost'}
    with TestClient(app,base_url='http://localhost') as c:
        url='/api/platform-admin/account/password'
        assert c.post(url,json={},headers=h).status_code==401
        assert c.post('/api/platform-admin/login',json=dict(username='platform',password='platform-password'),headers=h).status_code==200
        assert c.post(url,json=dict(currentPassword='wrong-password',newPassword='new-admin-password'),headers=h).status_code==400
        assert c.get('/api/platform-admin/session').status_code==200
        assert c.post(url,json=dict(currentPassword='platform-password',newPassword='new-admin-password',username='another'),headers=h).status_code==400
        assert c.post(url,json=dict(currentPassword='platform-password',newPassword='new-admin-password')).status_code==403
        assert c.post(url,json=dict(currentPassword='platform-password',newPassword='new-admin-password'),headers=h).status_code==200
        assert c.get('/api/platform-admin/session').status_code==401
        assert c.post('/api/platform-admin/login',json=dict(username='platform',password='platform-password'),headers=h).status_code==401
        assert c.post('/api/platform-admin/login',json=dict(username='platform',password='new-admin-password'),headers=h).status_code==200

def test_admin_has_separate_login_and_rejects_customer_and_csrf(tmp_path):
    app=create_app(Settings(data_dir=tmp_path,public_origin='http://localhost',platform_admin_username='platform',service_token='s'*64))
    auth=app.state.services.auth
    admin=auth.setup(dict(username='platform',password='platform-password'),ip='setup')
    customer=auth.register(dict(username='customer',password='customer-password'),ip='register')
    with TestClient(app,base_url='http://localhost') as c:
        c.cookies.set('zhixu_session',customer['token'],path='/api')
        assert c.get('/api/platform-admin/customers').status_code==401
        assert c.post('/api/platform-admin/login',json=dict(username='platform',password='platform-password')).status_code==403
        h={'Origin':'http://localhost'}
        assert c.post('/api/platform-admin/login',json=dict(username='customer',password='customer-password'),headers=h).status_code==401
        r=c.post('/api/platform-admin/login',json=dict(username='platform',password='platform-password'),headers=h)
        assert r.status_code==200 and 'HttpOnly' in r.headers['set-cookie'] and 'Path=/api/platform-admin' in r.headers['set-cookie']
        assert c.get('/api/auth/session').json()['username']=='customer'
        assert c.get('/api/platform-admin/session',headers={'Authorization':'Bearer '+'s'*64}).status_code==200
        rows=c.get('/api/platform-admin/customers').json()['items']
        target=next(t for t in rows if t['id']==customer['workspace'])
        assert target['members'][0]['username']=='customer'
        assert 'hash' not in str(target) and 'token' not in str(target)
        url='/api/platform-admin/customers/'+customer['workspace']+'/status'
        assert c.post(url,json={'enabled':False}).status_code==403
        assert c.post(url,json={'enabled':False},headers=h).status_code==200
        assert auth.identity('zhixu_session='+customer['token']) is None
        assert c.post(url,json={'enabled':True},headers=h).status_code==200
        assert auth.identity('zhixu_session='+customer['token']) is None
        code=c.post('/api/platform-admin/customers/'+customer['workspace']+'/recovery',json={'username':'customer'},headers=h)
        assert code.status_code==201 and code.json()['code']
        assert c.post('/api/platform-admin/customers/'+customer['workspace']+'/recovery',json={'username':'platform'},headers=h).status_code==404
        assert c.post('/api/platform-admin/logout',json={},headers=h).status_code==200
        assert c.get('/api/platform-admin/session').status_code==401
        assert c.get('/api/platform-admin/customers',headers={'Authorization':'Bearer '+'s'*64}).status_code==401
        c.cookies.set('matrix_platform_session',auth.issue('customer'),path='/api/platform-admin')
        assert c.get('/api/platform-admin/customers').status_code==403
