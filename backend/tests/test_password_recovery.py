import pytest
from fastapi.testclient import TestClient
from app.api import create_app
from app.settings import Settings
from app.store import ServiceError
from app.recovery import issue_recovery,reset_password

def test_recovery_is_single_use_scoped_and_revokes_old_sessions(tmp_path):
    app=create_app(Settings(data_dir=tmp_path,public_origin='http://localhost',service_token='s'*64))
    auth=app.state.services.auth
    original=auth.register(dict(username='customer',password='original-password'),ip='setup')
    other=auth.register(dict(username='another',password='another-password'),ip='setup2')
    code=issue_recovery(auth,'customer')['code']
    with pytest.raises(ServiceError):reset_password(auth,dict(username='another',code=code,password='new-password-123'),ip='bad')
    with TestClient(app,base_url='http://localhost') as c:
        body=dict(username='customer',code=code,password='new-password-123')
        assert c.post('/api/auth/password-reset',json=body).status_code==403
        r=c.post('/api/auth/password-reset',json=body,headers={'Origin':'http://localhost'})
        assert r.status_code==200
        assert auth.identity('zhixu_session='+original['token']) is None
        assert auth.identity('zhixu_session='+other['token']) is not None
        assert auth.authenticate(dict(username='customer',password='new-password-123'),ip='new')['workspace']==original['workspace']
        assert c.post('/api/auth/password-reset',json=body,headers={'Origin':'http://localhost'}).status_code==400

def test_reissue_and_expiry_invalidate_old_codes(tmp_path):
    app=create_app(Settings(data_dir=tmp_path,public_origin='http://localhost',service_token='s'*64));auth=app.state.services.auth
    auth.register(dict(username='customer',password='original-password'),ip='setup')
    old=issue_recovery(auth,'customer',now_ms=1000)['code']
    new=issue_recovery(auth,'customer',now_ms=2000)['code']
    with pytest.raises(ServiceError):reset_password(auth,dict(username='customer',code=old,password='new-password-123'),ip='old',now_ms=2001)
    with pytest.raises(ServiceError):reset_password(auth,dict(username='customer',code=new,password='new-password-123'),ip='expired',now_ms=902001)
