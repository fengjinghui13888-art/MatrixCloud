"""Super-admin content access always resolves the exact customer scope first."""
import re
from types import SimpleNamespace
from .assets import Assets
from .postgres import PostgresStore
from .store import Store
from urllib.parse import quote
from fastapi.responses import FileResponse
from .admin_permissions import super_only
from .store import ServiceError


def scope_for(runtime,tenant):
    customer=next((t for t in runtime.services.auth._tenant_records()['items'] if t['id']==tenant and tenant!='owner'),None)
    if not customer:raise ServiceError('客户不存在',404)
    root=runtime.services.root/'workspaces'/tenant
    if not root.resolve().is_relative_to(runtime.services.root.resolve()):raise ServiceError('无效工作区',403)
    store=PostgresStore(runtime.services.db,tenant) if runtime.services.db else Store(root/'operations.sqlite')
    return SimpleNamespace(store=store,assets=Assets(root))


def account_for(scope,account):
    row=next((a for a in scope.store.list_accounts() if a['id']==account),None)
    if not row:raise ServiceError('该客户下没有此小红书账号',404)
    return row


async def handle_content(runtime,actor,user,action,method,body,query):
    match=re.fullmatch(r'customers/([a-f0-9-]{36})/accounts(?:/([^/]+)/(notes|comments|messages|media/([^/]+)/([^/]+)))?',action)
    if not match:return None
    super_only(actor)
    tenant,account,resource,note_id,asset_id=match.groups()
    scope=scope_for(runtime,tenant)
    auth=runtime.services.auth
    if not account and method=='GET':
        accounts=scope.store.list_accounts()
        auth._audit(user,'customer.content.read',tenant,'success')
        return {'items':[{k:a[k] for k in ('id','name','handle','avatar','state','followers','lastSyncedAt') if k in a} for a in accounts]}
    account_for(scope,account)
    if resource and resource.startswith('media/') and method=='GET':
        note=next((n for n in scope.store.list_notes({'accountId':account}) if n['id']==note_id),None)
        asset=next((a for a in (note or {}).get('mediaAssets',[]) if a['id']==asset_id),None)
        file=scope.assets.file(asset['path'],account,note_id) if asset else None
        if not file:raise ServiceError('素材不存在或尚未同步',404)
        return FileResponse(file,headers={'Cache-Control':'no-store'})
    if resource in ('notes','comments','messages') and method=='GET':
        try:page=max(1,int(query.get('page',1)));size=min(50,max(1,int(query.get('pageSize',12))))
        except (ValueError,TypeError):raise ServiceError('分页参数无效')
        rows=getattr(scope.store,'list_'+resource)({'accountId':account});start=(page-1)*size
        note_titles={n['id']:n['title'] for n in scope.store.list_notes({'accountId':account})} if resource=='comments' else {}
        fields={'notes':('id','accountId','title','summary','publishedAt','metrics','mediaType'), 'comments':('id','accountId','noteId','author','body','createdAt','status','direction'), 'messages':('id','accountId','conversationId','author','body','createdAt','direction')}[resource]
        items=[]
        for original in rows[start:start+size]:
            item={k:original[k] for k in fields if k in original}
            if resource=='comments':item['noteTitle']=note_titles.get(original.get('noteId'),'原笔记未保存在当前记录中')
            if resource=='notes':
                item['media']=[{'id':a['id'],'kind':a['kind'],'url':'/api/platform-admin/customers/'+tenant+'/accounts/'+quote(account,safe='')+'/media/'+quote(original['id'],safe='')+'/'+quote(a['id'],safe='')} for a in original.get('mediaAssets',[])]
            items.append(item)
        auth._audit(user,'customer.content.read',tenant+':'+account+':'+resource,'success')
        return dict(items=items,page=page,pageSize=size,total=len(rows),hasNext=start+size<len(rows))
    raise ServiceError('内容接口不存在',404)
