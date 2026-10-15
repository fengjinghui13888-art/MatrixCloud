"""Self-service administrator password changes require the current password."""
from .auth import credentials
from .store import ServiceError


def change_password(auth,user,body):
    if not isinstance(body,dict) or set(body)!={'currentPassword','newPassword'} or not isinstance(body['currentPassword'],str) or len(body['currentPassword'])>128:
        raise ServiceError('请填写当前密码和新密码')
    _,password=credentials(dict(username=user['username'],password=body['newPassword']))
    auth._limit('admin-password:'+user['username'])
    with auth.transaction('owner') as c:
        if auth.db:
            c.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('password-recovery:'+user['username'],))
            c.execute("SELECT username FROM app_user WHERE tenant_id='owner' AND username=%s FOR UPDATE",(user['username'],))
        current=next((u for u in auth._users(c) if u['username']==user['username'] and u['workspace']=='owner' and u['enabled'] and u['tenant_enabled']),None)
        if not current or not auth._verify(body['currentPassword'],current):raise ServiceError('当前密码不正确',400)
        if password==body['currentPassword']:raise ServiceError('新密码不能与当前密码相同')
        salt,hash=auth._password(password)
        if auth.db:
            c.execute("UPDATE app_user SET password_salt=%s,password_hash=%s WHERE tenant_id='owner' AND username=%s",(salt,hash,user['username']))
            c.execute("DELETE FROM login_session WHERE tenant_id='owner' AND username=%s",(user['username'],))
            c.execute("UPDATE job SET status='revoked' WHERE tenant_id='owner' AND kind='password_recovery' AND payload->>'username'=%s AND status='pending'",(user['username'],))
        else:
            for table in ('login_users','auth_members'):c.execute(f'UPDATE {table} SET salt=?,hash=? WHERE username=?',(salt,hash,user['username']))
            c.execute('DELETE FROM sessions WHERE hash IN (SELECT session_hash FROM session_users WHERE username=?)',(user['username'],))
            c.execute('DELETE FROM session_users WHERE username=?',(user['username'],))
            c.execute("UPDATE auth_recovery SET status='revoked' WHERE workspace='owner' AND json_extract(payload,'$.username')=? AND status='pending'",(user['username'],))
    auth._audit(user,'admin.password.change',user['username'],'success')
    return dict(ok=True)
