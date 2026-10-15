"""Platform operations with a dedicated cookie and server checked owner identity."""
import re
from fastapi import Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from .auth import SESSION_SECONDS
from .store import ServiceError
from .recovery import issue_recovery

def respond(value,status=200):return JSONResponse(jsonable_encoder(value),status)

COOKIE='matrix_platform_session'
PREFIX='/api/platform-admin'

def cookie_header(request):return 'zhixu_session='+request.cookies.get(COOKIE,'')

def platform_customers(runtime,user):
    auth=runtime.services.auth;items=auth.tenants(user)['items']
    with auth.transaction() as c:members=auth._users(c)
    for tenant in items:
        tenant['members']=[{k:u[k] for k in ('username','displayName','role','enabled')} for u in members if u['workspace']==tenant['id']]
        if auth.db:
            with auth.transaction(tenant['id']) as c:
                tenant['counts']={label:c.execute('SELECT count(*) AS n FROM '+table+' WHERE tenant_id=%s',(tenant['id'],)).fetchone()['n'] for label,table in [('accounts','xiaohongshu_account'),('notes','note'),('leads','clue'),('tasks','generation')]}
        else:
            scope=runtime.services.for_workspace(tenant['id']) if tenant['enabled'] else None
            tenant['counts']=dict(accounts=len(scope.store.list_accounts()),notes=len(scope.store.list_notes()),leads=len(scope.store.list_leads()),tasks=len(scope.studio.list())) if scope else None
        tenant['devices']=runtime.pairing.devices(tenant['id'])
    return dict(items=items)

def install_admin_routes(app,runtime):
    auth=runtime.services.auth
    async def handle(request:Request):
        action=request.path_params.get('action','');method=request.method
        try:
            if not runtime.secure(request):raise ServiceError('请使用安全访问地址',426)
            if method=='POST' and not runtime.same_origin(request):raise ServiceError('请从管理员后台操作',403)
            body=await request.json() if method=='POST' else None
            if method=='POST' and not isinstance(body,dict):raise ServiceError('请求格式无效')
            if action=='login' and method=='POST':
                ip='platform-admin:'+runtime.client_ip(request);auth._limit(ip)
                if set(body)!={'username','password'} or not isinstance(body.get('username'),str) or body['username'].strip().lower()!=(runtime.settings.platform_admin_username or ''):
                    raise ServiceError('管理员账号或密码不正确',401)
                result=auth.authenticate(body,cookie_header(request),ip+'-password');auth._platform(result)
                response=respond({k:result[k] for k in ('username','role')})
                response.set_cookie(COOKIE,result['token'],max_age=SESSION_SECONDS,httponly=True,secure=runtime.settings.public_origin.startswith('https:') or request.url.scheme=='https',samesite='strict',path=PREFIX)
                return response
            user=auth.identity(cookie_header(request))
            if not user:raise ServiceError('请登录平台管理后台',401)
            auth._platform(user)
            if action=='session' and method=='GET':return respond({k:user[k] for k in ('username','role')})
            if action=='logout' and method=='POST':
                auth.logout(cookie_header(request));r=respond(dict(ok=True));r.delete_cookie(COOKIE,path=PREFIX);return r
            if action=='customers' and method=='GET':return respond(platform_customers(runtime,user))
            if action=='audit' and method=='GET':return respond(auth.audit(user))
            match=re.fullmatch(r'customers/(owner|[a-f0-9-]{36})/(status|recovery)',action)
            if match and method=='POST':
                tenant_id,operation=match.groups()
                if operation=='status':return respond(auth.update_tenant(user,tenant_id,body))
                if set(body)!={'username'} or not isinstance(body.get('username'),str):raise ServiceError('请选择客户成员')
                with auth.transaction() as c:target=next((u for u in auth._users(c) if u['workspace']==tenant_id and u['username']==body['username']),None)
                if not target:raise ServiceError('客户成员不存在',404)
                auth._limit('admin-recovery:'+user['username'])
                result=issue_recovery(auth,target['username'],actor=user['username'])
                auth._audit(user,'customer.recovery',target['username'],'issued')
                return respond(result,201)
            raise ServiceError('管理接口不存在',404)
        except (ValueError,TypeError) as error:
            return respond(dict(message=str(error) if isinstance(error,ServiceError) else '请求内容无效'),getattr(error,'status',400))
    app.add_api_route(PREFIX+'/{action:path}',handle,methods=['GET','POST'])
