"""Only the configured super administrator can manage at most three delegates."""
import json
from .auth import credentials
from .store import ServiceError,now

PERMISSIONS={'customers.read':'查看客户','customers.status':'停用/恢复客户','customers.recovery':'协助找回客户密码','devices.read':'查看连接设备','audit.read':'查看操作日志'}

def record(auth,username):
    with auth.transaction() as c:return auth.query(c,'SELECT username,permissions FROM platform_admin_member WHERE username=?',(username,)).fetchone()

def principal(auth,user):
    if not user or user.get('workspace')!='owner':raise ServiceError('无权访问管理后台',403)
    if user['username']==auth.settings.platform_admin_username:
        auth._platform(user);return dict(username=user['username'],role='super_admin',isSuper=True,permissions=list(PERMISSIONS))
    row=record(auth,user['username'])
    if not row or user['role']!='lead_viewer':raise ServiceError('无权访问管理后台',403)
    permissions=row['permissions']
    if isinstance(permissions,str):permissions=json.loads(permissions)
    return dict(username=user['username'],role='sub_admin',isSuper=False,permissions=[p for p in permissions if p in PERMISSIONS])

def require(actor,permission):
    if permission not in actor['permissions']:raise ServiceError('该操作未获授权，请联系超级管理员',403)

def checked_permissions(value):
    if not isinstance(value,list) or len(value)>5 or any(not isinstance(p,str) or p not in PERMISSIONS for p in value) or len(set(value))!=len(value):raise ServiceError('管理员权限设置无效')
    if any(p in value for p in ('customers.status','customers.recovery')) and 'customers.read' not in value:raise ServiceError('客户操作需要同时开启查看客户权限')
    return value

def super_only(actor):
    if not actor['isSuper']:raise ServiceError('只有超级管理员可以管理子管理员',403)

def lock(auth,c):
    if auth.db:c.execute("SELECT pg_advisory_xact_lock(hashtextextended('matrix-platform-subadmins',0))")

def list_members(auth,actor):
    super_only(actor)
    with auth.transaction() as c:
        rows=auth.query(c,'SELECT username,permissions FROM platform_admin_member ORDER BY created_at').fetchall();users=auth._users(c)
    items=[]
    for row in rows:
        user=next((u for u in users if u['workspace']=='owner' and u['username']==row['username']),None)
        if user:items.append(dict(username=user['username'],displayName=user['displayName'],enabled=bool(user['enabled']),permissions=json.loads(row['permissions']) if isinstance(row['permissions'],str) else row['permissions']))
    return dict(items=items,limit=3,superAdmin=auth.settings.platform_admin_username,permissionOptions=PERMISSIONS)

def save_member(auth,actor,body,username=None):
    super_only(actor)
    allowed={'displayName','permissions','enabled','password'} if username else {'username','displayName','permissions','password'}
    if not isinstance(body,dict) or set(body)-allowed or not body:raise ServiceError('管理员设置无效')
    if not username and not {'username','displayName','permissions','password'}<=set(body):raise ServiceError('请填写管理员账号、姓名、密码和权限')
    if 'displayName' in body and (not isinstance(body['displayName'],str) or not 1<=len(body['displayName'].strip())<=40):raise ServiceError('姓名需为1–40个字符')
    if 'enabled' in body and type(body['enabled']) is not bool:raise ServiceError('账号状态无效')
    if 'permissions' in body:checked_permissions(body['permissions'])
    if 'password' in body:credentials(dict(username='valid',password=body['password']))
    if not username:username,_=credentials(body)
    with auth.transaction() as c:
        lock(auth,c)
        rows=auth.query(c,'SELECT username FROM platform_admin_member').fetchall();users=auth._users(c)
        old=next((u for u in users if u['username']==username and u['workspace']=='owner'),None)
        creating='username' in body
        if creating:
            if len(rows)>=3:raise ServiceError('最多创建3个子管理员，停用的账号仍占用名额',409)
            if any(u['username']==username for u in users):raise ServiceError('该账号名已存在，请更换',409)
            salt,hash=auth._password(body['password'])
            if auth.db:
                c.execute("SELECT pg_advisory_xact_lock(hashtextextended('matrix-registration',0))")
                if c.execute('SELECT 1 FROM app_user WHERE username=%s',(username,)).fetchone():raise ServiceError('该账号名已存在，请更换',409)
                c.execute("INSERT INTO app_user(tenant_id,username,password_salt,password_hash,display_name,role) VALUES('owner',%s,%s,%s,%s,'lead_viewer')",(username,salt,hash,body['displayName'].strip()))
                c.execute('INSERT INTO platform_admin_member(username,permissions) VALUES(%s,%s::jsonb)',(username,json.dumps(body['permissions'])))
            else:
                c.execute('INSERT INTO auth_members VALUES(?,?,?,?,?)',(username,salt,hash,'owner',body['displayName'].strip()))
                c.execute("INSERT INTO auth_user_metadata VALUES(?,'lead_viewer',1)",(username,))
                c.execute('INSERT INTO platform_admin_member VALUES(?,?,?,?)',(username,json.dumps(body['permissions']),now(),now()))
        else:
            if not old or not any(r['username']==username for r in rows) or username==auth.settings.platform_admin_username:raise ServiceError('子管理员不存在，不能修改超级管理员',404)
            salt,hash=auth._password(body['password']) if 'password' in body else (old['salt'],old['hash'])
            name=body.get('displayName',old['displayName']).strip();enabled=body.get('enabled',bool(old['enabled']))
            if auth.db:
                c.execute("UPDATE app_user SET display_name=%s,enabled=%s,password_salt=%s,password_hash=%s WHERE tenant_id='owner' AND username=%s",(name,enabled,salt,hash,username))
                c.execute("DELETE FROM login_session WHERE tenant_id='owner' AND username=%s",(username,))
            else:
                c.execute('UPDATE auth_members SET display_name=?,salt=?,hash=? WHERE username=?',(name,salt,hash,username))
                c.execute('UPDATE auth_user_metadata SET enabled=? WHERE username=?',(int(enabled),username))
                c.execute('DELETE FROM sessions WHERE hash IN (SELECT session_hash FROM session_users WHERE username=?)',(username,))
                c.execute('DELETE FROM session_users WHERE username=?',(username,))
            if 'permissions' in body:
                auth.query(c,'UPDATE platform_admin_member SET permissions=?,updated_at=? WHERE username=?',(json.dumps(body['permissions']),now(),username),'UPDATE platform_admin_member SET permissions=%s::jsonb,updated_at=%s WHERE username=%s')
    auth._audit(dict(username=actor['username'],workspace='owner'),'admin.create' if creating else 'admin.update',username,'success')
    return dict(ok=True)
