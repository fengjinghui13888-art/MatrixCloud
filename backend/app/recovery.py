"""Operator-issued, expiring password recovery; no public account enumeration."""
import hmac
import json
import re
import secrets
import time
from .auth import credentials,digest
from .store import ServiceError,identifier

ERROR='恢复码无效或已过期，请联系管理员重新获取'

def issue_recovery(auth,username,*,now_ms=None,actor='server-administrator'):
    """Only call from trusted server administration or an authenticated admin."""
    username=username.strip().lower()
    with auth.transaction() as c:user=next((u for u in auth._users(c) if u['username']==username and u['enabled'] and u['tenant_enabled']),None)
    if not user:raise ServiceError('账号不存在或已停用',400)
    token=secrets.token_hex(32);id=identifier();expires=(int(time.time()*1000) if now_ms is None else now_ms)+900000
    payload=dict(username=username,tokenHash=digest(token),expires=expires)
    with auth.transaction(user['workspace']) as c:
        if auth.db:
            c.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('password-recovery:'+username,))
            c.execute("UPDATE job SET status='revoked' WHERE tenant_id=%s AND kind='password_recovery' AND payload->>'username'=%s AND status='pending'",(user['workspace'],username))
            c.execute("INSERT INTO job(tenant_id,id,kind,status,payload) VALUES(%s,%s,'password_recovery','pending',%s::jsonb)",(user['workspace'],id,json.dumps(payload)))
        else:
            c.execute("UPDATE auth_recovery SET status='revoked' WHERE workspace=? AND json_extract(payload,'$.username')=? AND status='pending'",(user['workspace'],username))
            c.execute('INSERT INTO auth_recovery VALUES(?,?,?,?)',(id,user['workspace'],json.dumps(payload),'pending'))
    auth._audit({**user,'username':actor},'password.recovery.issue',username,'success')
    return dict(code=id+'.'+token,expiresAt=expires,username=username)

def reset_password(auth,body,*,ip,now_ms=None):
    auth._limit('password-recovery:'+ip)
    if not isinstance(body,dict) or set(body)!={'username','password','code'}:raise ServiceError(ERROR)
    username,password=credentials(body);code=body['code']
    if not isinstance(code,str) or not re.fullmatch(r'[a-f0-9-]{36}\.[a-f0-9]{64}',code):raise ServiceError(ERROR)
    id,token=code.split('.')
    with auth.transaction() as c:user=next((u for u in auth._users(c) if u['username']==username and u['enabled'] and u['tenant_enabled']),None)
    if not user:raise ServiceError(ERROR)
    stamp=int(time.time()*1000) if now_ms is None else now_ms
    with auth.transaction(user['workspace']) as c:
        if auth.db:
            c.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('password-recovery:'+username,))
            row=c.execute("SELECT payload,status FROM job WHERE tenant_id=%s AND id=%s AND kind='password_recovery' FOR UPDATE",(user['workspace'],id)).fetchone()
        else:row=c.execute('SELECT payload,status FROM auth_recovery WHERE workspace=? AND id=?',(user['workspace'],id)).fetchone()
        payload=row['payload'] if row else {}
        if isinstance(payload,str):payload=json.loads(payload)
        if not row or row['status']!='pending' or payload.get('username')!=username or payload.get('expires',0)<=stamp or not hmac.compare_digest(payload.get('tokenHash',''),digest(token)):raise ServiceError(ERROR)
        # Recheck current enabled state inside the consuming transaction.
        current=next((u for u in auth._users(c) if u['username']==username and u['enabled'] and u['tenant_enabled']),None)
        if not current:raise ServiceError(ERROR)
        salt,hash=auth._password(password)
        if auth.db:
            c.execute('UPDATE app_user SET password_salt=%s,password_hash=%s WHERE tenant_id=%s AND username=%s',(salt,hash,user['workspace'],username))
            c.execute('DELETE FROM login_session WHERE tenant_id=%s AND username=%s',(user['workspace'],username))
            c.execute("UPDATE job SET status='used',payload=payload-'tokenHash' WHERE tenant_id=%s AND id=%s",(user['workspace'],id))
        else:
            for table in ('login_users','auth_members'):c.execute(f'UPDATE {table} SET salt=?,hash=? WHERE username=?',(salt,hash,username))
            c.execute('DELETE FROM sessions WHERE hash IN (SELECT session_hash FROM session_users WHERE username=?)',(username,))
            c.execute('DELETE FROM session_users WHERE username=?',(username,))
            c.execute("UPDATE auth_recovery SET status='used',payload=json_remove(payload,'$.tokenHash') WHERE id=?",(id,))
    auth._audit(user,'password.recovery.reset',username,'success')
    return dict(ok=True,message='密码已重设，请使用新密码登录；原账号内容和配置保留。')
