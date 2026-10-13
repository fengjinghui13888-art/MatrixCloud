"""Cookie auth compatible with Node scrypt and the normalized PostgreSQL tables."""
from __future__ import annotations

import bcrypt
import hashlib
import hmac
import re
import secrets
import threading
import time
from contextlib import contextmanager
from .store import SQLite, ServiceError, identifier, now

COOKIE_NAME='zhixu_session'
SESSION_SECONDS=8*60*60
CREDENTIAL_ERROR='账号需为 3–40 位英文、数字或 ._-；密码至少 12 个字符，UTF-8 不超过 72 字节'


def digest(value):return hashlib.sha256(value.encode()).hexdigest()


def cookie_token(header):
    for item in (header or '').split(';'):
        key,_,value=item.strip().partition('=')
        if key==COOKIE_NAME:return value if re.fullmatch(r'[a-f0-9]{64}',value) else ''
    return ''


def credentials(value):
    if not isinstance(value,dict) or not {'username','password'}<=value.keys():raise ServiceError(CREDENTIAL_ERROR)
    username=value['username'];password=value['password']
    if not isinstance(username,str) or not isinstance(password,str):raise ServiceError(CREDENTIAL_ERROR)
    username=username.strip().lower()
    if not re.fullmatch(r'[a-z0-9_.-]{3,40}',username) or not 12<=len(password)<=72 or len(password.encode())>72:raise ServiceError(CREDENTIAL_ERROR)
    return username,password


def role_allows(role,method,path):
    path=path.rstrip('/').lower() or '/';method=method.upper()
    if role=='admin':return True
    if role=='lead_viewer':return method in ('GET','HEAD') and path in ('/api/operations','/api/leads')
    if role!='operator':return False
    if path.startswith('/api/costs') and method!='GET':return False
    if path.startswith('/api/admin') or path.startswith('/api/auth/team'):return False
    if path.startswith('/api/connector') and method!='GET':return method=='POST' and (path=='/api/connector/pairings' or bool(re.fullmatch(r'/api/connector/pairings/[^/]+/cancel',path)) or bool(re.fullmatch(r'/api/connector/devices/[^/]+/select',path)))
    if path.startswith('/api/models') and method!='GET':return path in ('/api/models/chat','/api/models/images')
    if re.fullmatch(r'/api/studio/[^/]+/(claim|progress|receipt)',path):return False
    return True


class Auth:
    role_allows=staticmethod(role_allows)
    def __init__(self,settings,db=None):
        self.settings,self.db=settings,db
        self.attempts={};self.attempt_lock=threading.RLock()
        if db:self.sql=None
        else:
            self.sql=SQLite(settings.data_dir/'accounts.sqlite','''
CREATE TABLE IF NOT EXISTS administrator(id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_users(username TEXT PRIMARY KEY,salt TEXT NOT NULL,hash TEXT NOT NULL,workspace TEXT UNIQUE NOT NULL,display_name TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS session_users(session_hash TEXT PRIMARY KEY,username TEXT NOT NULL);
INSERT OR IGNORE INTO login_users SELECT username,salt,hash,'owner',username FROM administrator;
INSERT OR IGNORE INTO session_users SELECT sessions.hash,administrator.username FROM sessions CROSS JOIN administrator;
CREATE TABLE IF NOT EXISTS auth_members(username TEXT PRIMARY KEY,salt TEXT NOT NULL,hash TEXT NOT NULL,workspace TEXT NOT NULL,display_name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_user_metadata(username TEXT PRIMARY KEY,role TEXT NOT NULL DEFAULT 'admin',enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS auth_tenants(id TEXT PRIMARY KEY,name TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,workspace TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
''')

    @contextmanager
    def transaction(self,workspace='owner'):
        with (self.db.transaction(workspace) if self.db else self.sql.transaction()) as c:yield c

    def query(self,c,sql,values=(),pg=None):
        return c.execute((pg or sql).replace('?','%s') if self.db else sql,values)

    def _users(self,c):
        if self.db:
            return [dict(r) for r in c.execute('SELECT u.username,u.password_salt AS salt,u.password_hash AS hash,u.tenant_id AS workspace,u.display_name AS "displayName",u.role,u.enabled,t.enabled AS tenant_enabled FROM app_user u JOIN tenant t ON t.tenant_id=u.tenant_id').fetchall()]
        rows=c.execute('''SELECT u.username,u.salt,u.hash,u.workspace,u.display_name AS displayName,coalesce(m.role,'admin') AS role,coalesce(m.enabled,1) AS enabled,coalesce(t.enabled,1) AS tenant_enabled FROM (SELECT * FROM login_users UNION ALL SELECT * FROM auth_members) u LEFT JOIN auth_user_metadata m ON m.username=u.username LEFT JOIN auth_tenants t ON t.id=u.workspace''').fetchall()
        return [dict(r) for r in rows]

    @staticmethod
    def _public(user):return {k:user[k] for k in ('username','workspace','displayName','role')}

    def configured(self):
        with self.transaction() as c:
            if self.db:return bool(c.execute("SELECT 1 FROM app_user WHERE tenant_id='owner' LIMIT 1").fetchone())
            return bool(c.execute('SELECT 1 FROM administrator').fetchone())

    def active(self,workspace):
        with self.transaction(workspace) as c:
            if self.db:
                r=c.execute('SELECT enabled FROM tenant WHERE tenant_id=%s',(workspace,)).fetchone();return bool(r and r['enabled'])
            r=c.execute('SELECT enabled FROM auth_tenants WHERE id=?',(workspace,)).fetchone();return bool(r['enabled']) if r else True

    def identity(self,cookie_header):
        token=cookie_token(cookie_header)
        if not token:return None
        with self.transaction() as c:
            stamp=int(time.time()*1000)
            if self.db:
                row=c.execute('SELECT u.username,u.tenant_id AS workspace,u.display_name AS "displayName",u.role FROM login_session s JOIN app_user u ON u.tenant_id=s.tenant_id AND u.username=s.username JOIN tenant t ON t.tenant_id=u.tenant_id WHERE s.hash=%s AND s.expires>%s AND u.enabled AND t.enabled',(digest(token),stamp)).fetchone()
                return dict(row) if row else None
            row=c.execute('SELECT u.username FROM session_users u JOIN sessions s ON s.hash=u.session_hash WHERE s.hash=? AND s.expires>?',(digest(token),stamp)).fetchone()
            if row is None:return None
            user=next((u for u in self._users(c) if u['username']==row['username'] and u['enabled'] and u['tenant_enabled']),None)
            return self._public(user) if user else None

    def session(self,cookie_header):
        user=self.identity(cookie_header)
        if not user:raise ServiceError('请登录工作台',401)
        return user

    def profile(self,cookie_header):return {**self.session(cookie_header),'sessionHours':8}

    def same_origin(self,origin,host='',scheme='http',sec_fetch_site=''):
        return bool(origin) and origin==(self.settings.public_origin or scheme+'://'+host) and sec_fetch_site!='cross-site'

    def _limit(self,ip):
        stamp=int(time.time()*1000)
        if self.db:
            with self.transaction() as c:
                count=c.execute('INSERT INTO login_limit VALUES(%s,%s,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN login_limit.bucket=excluded.bucket THEN login_limit.count+1 ELSE 1 END,bucket=excluded.bucket RETURNING count',(digest(ip),stamp//900000)).fetchone()['count']
                if count>10:raise ServiceError('尝试次数过多，请 15 分钟后重试',429)
        else:
            with self.attempt_lock:
                self.attempts={k:v for k,v in self.attempts.items() if v[1]>stamp}
                count,until=self.attempts.get(ip,(0,stamp+900000))
                if count>=10 or len(self.attempts)>=5000:raise ServiceError('尝试次数过多，请 15 分钟后重试',429)
                self.attempts[ip]=(count+1,until)

    def _reset_limit(self,ip):
        if self.db:
            with self.transaction() as c:c.execute('DELETE FROM login_limit WHERE key=%s',(digest(ip),))
        else:
            with self.attempt_lock:self.attempts.pop(ip,None)

    def _password(self,password):
        if self.db:return '',bcrypt.hashpw(password.encode(),bcrypt.gensalt(rounds=12)).decode()
        salt=secrets.token_hex(16)
        return salt,hashlib.scrypt(password.encode(),salt=salt.encode(),n=16384,r=8,p=1,dklen=64).hex()

    @staticmethod
    def _verify(password,user):
        saved=user.get('hash','') if user else ''
        if saved.startswith('$2'):
            if len(password.encode())>72:return False
            try:return bcrypt.checkpw(password.encode(),saved.encode())
            except ValueError:return False
        actual=hashlib.scrypt(password.encode(),salt=(user['salt'] if user else 'unknown-account-salt').encode(),n=16384,r=8,p=1,dklen=64)
        try:expected=bytes.fromhex(saved) if user else b'\0'*64
        except ValueError:return False
        return bool(user) and hmac.compare_digest(actual,expected)

    def issue(self,username,old_cookie=''):
        token=secrets.token_hex(32);stamp=int(time.time()*1000)
        with self.transaction() as c:
            user=next((u for u in self._users(c) if u['username']==username and u['enabled'] and u['tenant_enabled']),None)
            if not user:raise ServiceError('请登录工作台',401)
            old=digest(cookie_token(old_cookie))
            if self.db:
                c.execute('DELETE FROM login_session WHERE expires<=%s OR hash=%s',(stamp,old))
                c.execute('INSERT INTO login_session VALUES(%s,%s,%s,%s)',(digest(token),user['workspace'],username,stamp+SESSION_SECONDS*1000))
            else:
                c.execute('DELETE FROM sessions WHERE expires<=? OR hash=?',(stamp,old))
                c.execute('DELETE FROM session_users WHERE session_hash NOT IN (SELECT hash FROM sessions)')
                c.execute('INSERT INTO sessions VALUES(?,?)',(digest(token),stamp+SESSION_SECONDS*1000))
                c.execute('INSERT INTO session_users VALUES(?,?)',(digest(token),username))
        return token

    def authenticate(self,input,old_cookie='',ip='unknown'):
        self._limit(ip)
        if not isinstance(input,dict) or not isinstance(input.get('username'),str) or not isinstance(input.get('password'),str) or len(input['username'].strip())>40 or len(input['password'])>128:raise ServiceError('账号或密码不正确',401)
        username=input['username'].strip().lower();password=input['password']
        with self.transaction() as c:
            user=next((u for u in self._users(c) if u['username']==username),None)
            if not self._verify(password,user) or not user['enabled'] or not user['tenant_enabled']:raise ServiceError('账号或密码不正确，或账号已停用' if self.db else '账号或密码不正确',401)
            if self.db and not user['hash'].startswith('$2') and len(password.encode())<=72:
                c.execute("UPDATE app_user SET password_hash=%s,password_salt='' WHERE username=%s AND password_hash=%s",(bcrypt.hashpw(password.encode(),bcrypt.gensalt(rounds=12)).decode(),username,user['hash']))
            result=self._public(user)
        self._reset_limit(ip)
        result['token']=self.issue(username,old_cookie)
        self._audit(result,'login','session','success')
        return result

    def _create(self,input,setup,old_cookie,ip,local):
        if self.db or not setup:self._limit(ip)
        if setup and not local:raise ServiceError('首次初始化请在服务器本机完成',403)
        if not isinstance(input,dict) or set(input) != {'username','password'}:raise ServiceError(CREDENTIAL_ERROR)
        username,password=credentials(input)
        reserved=(self.settings.platform_admin_username or '').strip().lower()
        if not setup and username==reserved:raise ServiceError('此账号名由平台保留，请使用其他账号名',409)
        salt,hash=self._password(password);workspace='owner' if setup else identifier()
        with self.transaction() as c:
            if self.db:c.execute("SELECT pg_advisory_xact_lock(hashtextextended('matrix-registration',0))")
            users=self._users(c)
            if setup and any(u['workspace']=='owner' for u in users):raise ServiceError('管理员已创建，请直接登录',409)
            if any(u['username']==username for u in users):raise ServiceError('此账号已存在，请登录或使用其他账号名',409)
            if self.db:
                c.execute('INSERT INTO tenant(tenant_id,name) VALUES(%s,%s) ON CONFLICT DO NOTHING',(workspace,username))
                c.execute("INSERT INTO app_user(tenant_id,username,password_hash,password_salt,display_name,role) VALUES(%s,%s,%s,%s,%s,'admin')",(workspace,username,hash,salt,username))
            else:
                if setup:c.execute('INSERT INTO administrator VALUES(1,?,?,?)',(username,salt,hash))
                c.execute('INSERT INTO login_users VALUES(?,?,?,?,?)',(username,salt,hash,workspace,username))
                c.execute('INSERT INTO auth_tenants VALUES(?,?,1,?)',(workspace,username,now()))
        return dict(username=username,workspace=workspace,displayName=username,role='admin',token=self.issue(username,old_cookie))

    def setup(self,input,old_cookie='',ip='127.0.0.1',local=True):return self._create(input,True,old_cookie,ip,local)
    def register(self,input,old_cookie='',ip='unknown'):return self._create(input,False,old_cookie,ip,True)

    def logout(self,cookie_header):
        with self.transaction() as c:
            token=digest(cookie_token(cookie_header))
            if self.db:c.execute('DELETE FROM login_session WHERE hash=%s',(token,))
            else:
                c.execute('DELETE FROM sessions WHERE hash=?',(token,));c.execute('DELETE FROM session_users WHERE session_hash=?',(token,))
        return {'ok':True}

    def update_profile(self,cookie_header,input):
        user=self.session(cookie_header)
        value=input.get('displayName') if isinstance(input,dict) else None
        if not isinstance(value,str) or not 1<=len(value.strip())<=40 or re.search(r'[\r\n]',value) or set(input)!={'displayName'}:raise ServiceError('昵称需为 1–40 个字符')
        value=value.strip()
        with self.transaction(user['workspace']) as c:
            if self.db:c.execute('UPDATE app_user SET display_name=%s WHERE tenant_id=%s AND username=%s',(value,user['workspace'],user['username']))
            else:
                c.execute('UPDATE login_users SET display_name=? WHERE username=?',(value,user['username']));c.execute('UPDATE auth_members SET display_name=? WHERE username=?',(value,user['username']))
        return {**user,'displayName':value}

    @staticmethod
    def _admin(user):
        if not user or user.get('role')!='admin':raise ServiceError('仅客户管理员可管理成员',403)

    def team(self,user):
        self._admin(user)
        with self.transaction(user['workspace']) as c:
            return dict(items=[{k:u[k] if k!='enabled' else bool(u[k]) for k in ('username','displayName','role','enabled')} for u in self._users(c) if u['workspace']==user['workspace']],currentUsername=user['username'])

    def create_member(self,user,input):
        self._admin(user)
        try:username,password=credentials(input)
        except ValueError:raise ServiceError('请填写账号、角色和至少 12 个字符的初始密码（UTF-8 不超过 72 字节）')
        role=input.get('role');display=input.get('displayName')
        if role not in ('admin','operator','lead_viewer') or not isinstance(display,str) or not 1<=len(display.strip())<=40:raise ServiceError('请填写账号、角色和至少 12 个字符的初始密码（UTF-8 不超过 72 字节）')
        salt,hash=self._password(password)
        with self.transaction(user['workspace']) as c:
            if self.db:c.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('matrix-registration',))
            if any(u['username']==username for u in self._users(c)):raise ServiceError('该登录账号已存在，请更换账号名',409)
            if self.db:c.execute('INSERT INTO app_user(tenant_id,username,password_salt,password_hash,display_name,role) VALUES(%s,%s,%s,%s,%s,%s)',(user['workspace'],username,salt,hash,display.strip(),role))
            else:
                c.execute('INSERT INTO auth_members VALUES(?,?,?,?,?)',(username,salt,hash,user['workspace'],display.strip()))
                c.execute('INSERT INTO auth_user_metadata VALUES(?,?,1)',(username,role))
        self._audit(user,'member.create',username,'success');return {'ok':True}

    def update_member(self,user,username,input):
        self._admin(user)
        if not isinstance(input,dict) or set(input)-{'role','enabled','password'} or ('role' in input and input['role'] not in ('admin','operator','lead_viewer')) or ('enabled' in input and type(input['enabled']) is not bool):raise ServiceError('成员设置不合法')
        if 'password' in input:
            credentials(dict(username='valid',password=input['password']))
        if username==user['username'] and (input.get('enabled') is False or input.get('role','admin')!='admin'):raise ServiceError('不能停用自己或移除自己的管理员权限',409)
        with self.transaction(user['workspace']) as c:
            if self.db:c.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',(user['workspace']+':team',))
            members=[u for u in self._users(c) if u['workspace']==user['workspace']]
            old=next((u for u in members if u['username']==username),None)
            if not old:raise ServiceError('成员不存在',409)
            role=input.get('role',old['role']);enabled=input.get('enabled',bool(old['enabled']))
            if old['role']=='admin' and old['enabled'] and (not enabled or role!='admin') and sum(m['role']=='admin' and m['enabled'] for m in members)<=1:raise ServiceError('至少保留一位启用的管理员',409)
            salt,hash=self._password(input['password']) if input.get('password') else (old['salt'],old['hash'])
            if self.db:
                c.execute('UPDATE app_user SET role=%s,enabled=%s,password_salt=%s,password_hash=%s WHERE tenant_id=%s AND username=%s',(role,enabled,salt,hash,user['workspace'],username))
                c.execute('DELETE FROM login_session WHERE tenant_id=%s AND username=%s',(user['workspace'],username))
            else:
                c.execute('INSERT INTO auth_user_metadata VALUES(?,?,?) ON CONFLICT(username) DO UPDATE SET role=excluded.role,enabled=excluded.enabled',(username,role,int(enabled)))
                for table in ('login_users','auth_members'):c.execute(f'UPDATE {table} SET salt=?,hash=? WHERE username=?',(salt,hash,username))
                c.execute('DELETE FROM sessions WHERE hash IN (SELECT session_hash FROM session_users WHERE username=?)',(username,))
                c.execute('DELETE FROM session_users WHERE username=?',(username,))
        self._audit(user,'member.update',username,'success');return {'ok':True}

    def _audit(self,user,action,target,result):
        with self.transaction(user['workspace']) as c:
            if self.db:c.execute('INSERT INTO audit_log(tenant_id,actor,action,target,result) VALUES(%s,%s,%s,%s,%s)',(user['workspace'],user['username'],action,target,result))
            else:c.execute('INSERT INTO auth_audit(workspace,actor,action,target,result,created_at) VALUES(?,?,?,?,?,?)',(user['workspace'],user['username'],action,target,result,now()))

    def audit(self,user):
        self._admin(user)
        with self.transaction(user['workspace']) as c:
            rows=self.query(c,'SELECT actor,action,target,result,created_at AS "createdAt" FROM auth_audit WHERE workspace=? ORDER BY id DESC LIMIT 100',(user['workspace'],),'SELECT actor,action,target,result,created_at AS "createdAt" FROM audit_log WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100').fetchall()
            return dict(items=[dict(r) for r in rows])

    def _platform(self,user):
        if not user or user.get('workspace')!='owner' or user.get('role')!='admin' or user.get('username')!=(self.settings.platform_admin_username or '').strip().lower():raise ServiceError('无权管理客户',403)

    def tenants(self,user):
        self._platform(user)
        with self.transaction() as c:
            rows=self.query(c,'SELECT id,name,enabled,created_at AS "createdAt" FROM auth_tenants ORDER BY created_at',(), 'SELECT tenant_id AS id,name,enabled,created_at AS "createdAt" FROM tenant ORDER BY created_at').fetchall()
            return dict(items=[{**dict(r),'enabled':bool(r['enabled'])} for r in rows])

    def update_tenant(self,user,id,input):
        self._platform(user)
        if id=='owner' or not isinstance(input,dict) or set(input)!={'enabled'} or type(input['enabled']) is not bool:raise ServiceError('不能停用平台所属客户')
        with self.transaction() as c:
            result=self.query(c,'UPDATE auth_tenants SET enabled=? WHERE id=?',(input['enabled'] if self.db else int(input['enabled']),id),'UPDATE tenant SET enabled=? WHERE tenant_id=?')
            if result.rowcount!=1:raise ServiceError('客户不存在',404)
        self._audit(user,'tenant.status',id,'enabled' if input['enabled'] else 'disabled');return {'ok':True}
