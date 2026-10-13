from __future__ import annotations

import copy
import re
import uuid
from .store import PayloadTable, ServiceError, identifier, now
from .queues import object_input, text, integer


def brief_input(raw):
    keys=['accountId','topic','persona','style','imageCount','size','requestId','confirmCharge','imageMode','templateIds','strength']
    value=object_input(raw,keys,keys[:8])
    for k,lo,hi,trim in [('accountId',1,1000,False),('topic',1,500,True),('persona',0,1000,False),('style',0,500,False),('requestId',8,100,False)]:value[k]=text(value[k],k,lo,hi,trim)
    integer(value['imageCount'],'图片数量',1,12)
    if value['size'] not in ('1024x1024','1024x1536','1536x1024'):raise ServiceError('图片尺寸不合法')
    if value['confirmCharge'] is not True:raise ServiceError('请确认本次模型费用')
    if 'imageMode' in value and value['imageMode'] not in ('direct','reference'):raise ServiceError('图片模式不合法')
    if 'strength' in value and (type(value['strength']) not in (int,float) or not .5<=value['strength']<=.7):raise ServiceError('二创强度必须在 0.5–0.7 之间')
    if 'templateIds' in value:
        if not isinstance(value['templateIds'],list) or len(value['templateIds'])>9:raise ServiceError('参考图数量不合法')
        try:
            for id in value['templateIds']:uuid.UUID(id)
        except (ValueError,TypeError,AttributeError):raise ServiceError('参考图格式无效')
    return value


def copy_input(raw):
    if not isinstance(raw,dict):raise ServiceError('文案格式不合法')
    value={k:v for k,v in raw.items() if k in ('title','body','tags')}
    value['title']=text(value.get('title'),'title',1,20)
    value['body']=text(value.get('body'),'body',1,900)
    if not isinstance(value.get('tags'),list) or len(value['tags'])>5:raise ServiceError('标签数量不合法')
    value['tags']=[text(t,'tag',1,20) for t in value['tags']]
    if any(re.search(r'[#\s,，]',t) for t in value['tags']):raise ServiceError('标签格式不合法')
    return value


class Studio:
    busy=('generating','filling','approved','pending_confirmation')
    def __init__(self,path,db=None,tenant='owner'):
        self.repo=PayloadTable(path,'studio_tasks','studio',db,tenant)

    def list(self):
        with self.repo.transaction() as c:return self.repo.rows(c)

    def _get(self,c,id):
        rows=self.repo.rows(c,id=id)
        if not rows:raise ServiceError('任务不存在',404)
        return rows[0]

    def get(self,id):
        with self.repo.transaction() as c:return self._get(c,id)

    def create(self,raw):
        value=brief_input(raw)
        with self.repo.transaction() as c:
            rows=self.repo.rows(c,request_id=value['requestId'])
            if rows:
                old=rows[0]
                if any(old.get(k)!=value.get(k) for k in ('accountId','topic','persona','style','size','imageCount','imageMode','templateIds','strength')):raise ServiceError('重复请求内容不一致',409)
                return dict(task=old,fresh=False)
            timestamp=now()
            task={**value,'id':identifier(),'revision':1,'createdAt':timestamp,'updatedAt':timestamp,'status':'generating','title':'','body':'','tags':[],'images':[],'message':'正在生成文案','history':[]}
            self.repo.insert(c,task)
            return dict(task=task,fresh=True)

    def update(self,id,revision,patch):
        with self.repo.transaction() as c:
            old=self._get(c,id)
            if old['revision']!=revision:raise ServiceError('内容已更新，请刷新后重试',409)
            timestamp=now()
            task={**old,**copy.deepcopy(patch),'id':old['id'],'accountId':old['accountId'],'requestId':old['requestId'],'revision':revision+1,'updatedAt':timestamp,'history':old.get('history',[])+[dict(at=timestamp,status=patch.get('status',old['status']),message=patch.get('message',''))]}
            self.repo.save(c,task);return task

    def delete_many(self,ids):
        with self.repo.transaction() as c:
            deleted=[];missing=[]
            for id in dict.fromkeys(ids):
                rows=self.repo.rows(c,id=id)
                if not rows:missing.append(id);continue
                if rows[0]['status'] in self.busy:raise ServiceError('创作任务 '+id+' 正在执行，请先停止或等待结果',409)
                deleted.append(rows[0])
            self.repo.remove(c,[t['id'] for t in deleted]);return dict(deleted=deleted,missing=missing)

    def delete(self,id):
        result=self.delete_many([id])
        if not result['deleted']:raise ServiceError('任务不存在',404)
        return result['deleted'][0]

    def delete_by_account(self,account_id):
        with self.repo.transaction() as c:
            tasks=[t for t in self.repo.rows(c) if t['accountId']==account_id]
            if any(t['status'] in self.busy for t in tasks):raise ServiceError('该账号有正在执行的创作任务，请先停止或等待结果',409)
            self.repo.remove(c,[t['id'] for t in tasks]);return tasks
