from __future__ import annotations

import copy
from urllib.parse import urlsplit
from .store import PayloadTable, ServiceError, identifier, now


def object_input(raw, allowed, required=()):
    if not isinstance(raw,dict) or set(raw)-set(allowed) or set(required)-set(raw): raise ServiceError('输入参数不合法')
    return copy.deepcopy(raw)


def text(value,name,minimum=0,maximum=1000,trim=True):
    if not isinstance(value,str):raise ServiceError(name+'格式不合法')
    value=value.strip() if trim else value
    if not minimum<=len(value.encode('utf-16-le', errors='surrogatepass'))//2<=maximum:raise ServiceError(name+'长度不合法')
    return value


def integer(value,name,minimum,maximum):
    if type(value) is not int or not minimum<=value<=maximum:raise ServiceError(name+'必须在 '+str(minimum)+'–'+str(maximum)+' 之间')
    return value


def https_url(value):
    if not isinstance(value,str):raise ServiceError('图片地址不合法')
    parsed=urlsplit(value)
    if parsed.scheme!='https' or not parsed.hostname:raise ServiceError('图片地址必须使用 HTTPS')
    return value


def creation_input(raw):
    keys=['topic','sellingPoints','audience','style','imageCount','requestId']
    value=object_input(raw,keys,keys)
    for name,lo,hi in [('topic',1,500),('sellingPoints',0,2000),('audience',0,500),('style',0,500),('requestId',8,100)]:value[name]=text(value[name],name,lo,hi,trim=name!='requestId')
    integer(value['imageCount'],'图片数量',1,12)
    return value


def publish_input(raw):
    keys=['accountId','title','body','media','delivery','confirmPublish','requestId']
    value=object_input(raw,keys,['accountId','title','body','media','delivery','requestId'])
    for name,lo,hi in [('accountId',1,1000),('title',1,20),('body',1,1000),('requestId',8,100)]:value[name]=text(value[name],name,lo,hi,trim=name not in ('accountId','requestId'))
    if not isinstance(value['media'],list) or not 1<=len(value['media'])<=9:raise ServiceError('请选择 1–9 张图片')
    for url in value['media']:https_url(url)
    if value['delivery'] not in ('draft','publish'):raise ServiceError('任务类型不匹配')
    if 'confirmPublish' in value and type(value['confirmPublish']) is not bool:raise ServiceError('发布确认不合法')
    if value['delivery']=='publish' and not value.get('confirmPublish'):raise ServiceError('请明确确认发布')
    return value


class Queue:
    busy=()
    def __init__(self,path,kind,db=None,tenant='owner'):
        self.kind=kind
        self.repo=PayloadTable(path,'creation_tasks' if kind=='creation' else 'publish_queue',kind,db,tenant)

    def list(self):
        with self.repo.transaction() as c:return self.repo.rows(c)

    def _get(self,c,id):
        rows=self.repo.rows(c,id=id)
        if not rows:raise ServiceError('创作任务不存在' if self.kind=='creation' else '发布任务不存在',404)
        return rows[0]

    def get(self,id):
        with self.repo.transaction() as c:return self._get(c,id)

    def create(self,raw):
        value=creation_input(raw) if self.kind=='creation' else publish_input(raw)
        with self.repo.transaction() as c:
            rows=self.repo.rows(c,request_id=value['requestId'])
            if rows:
                old=rows[0]
                keys=list(value) if self.kind=='creation' else ['accountId','title','body','media','delivery']
                if any(old.get(k)!=value.get(k) for k in keys):raise ServiceError('重复请求内容不同，请重新提交' if self.kind=='creation' else '重复请求的内容不一致，请重新创建',409)
                return old
            task={**value,'id':identifier(),'status':'queued','createdAt':now()}
            self.repo.insert(c,task)
            return self.repo.rows(c,request_id=value['requestId'])[0]

    def claim(self,id):
        with self.repo.transaction() as c:
            rows=self.repo.rows(c,id=id)
            if not rows or rows[0]['status']!='queued':raise ServiceError('任务已领取或不存在' if self.kind=='creation' else '任务不存在或已被领取，请勿重复发布',409)
            task=rows[0];task['status']='running';self.repo.save(c,task);return task

    def delete_many(self,ids):
        with self.repo.transaction() as c:
            deleted=[];missing=[]
            for id in dict.fromkeys(ids):
                rows=self.repo.rows(c,id=id)
                if not rows:missing.append(id);continue
                task=rows[0]
                if task['status'] in self.busy:raise ServiceError('创作任务 '+id+' 正在执行，请先等待或停止' if self.kind=='creation' else '发布任务 '+id+' 正在执行，请先等待结果',409)
                deleted.append(task)
            self.repo.remove(c,[t['id'] for t in deleted]);return dict(deleted=deleted,missing=missing)

    def delete(self,id):
        result=self.delete_many([id])
        if not result['deleted']:raise ServiceError('创作任务不存在' if self.kind=='creation' else '发布任务不存在',404)
        return result['deleted'][0]


class CreationQueue(Queue):
    busy=('running','generating')
    def __init__(self,path,db=None,tenant='owner'):super().__init__(path,'creation',db,tenant)

    def complete(self,raw):
        value=object_input(raw,['taskId','status','titles','body','images','imageProvider','message'],['taskId','status','message'])
        if value['status'] not in ('completed','partial','failed'):raise ServiceError('创作回执状态不合法')
        text(value['taskId'],'taskId',0,1000);value['message']=text(value['message'],'message',1,2000)
        if 'titles' in value:
            if not isinstance(value['titles'],list) or not 1<=len(value['titles'])<=5:raise ServiceError('标题数量不合法')
            value['titles']=[text(t,'title',1,20) for t in value['titles']]
        if 'body' in value:value['body']=text(value['body'],'body',1,1000)
        if 'images' in value:
            if not isinstance(value['images'],list) or len(value['images'])>12:raise ServiceError('图片数量不合法')
            for url in value['images']:https_url(url)
        if 'imageProvider' in value:value['imageProvider']=text(value['imageProvider'],'imageProvider',1,200)
        with self.repo.transaction() as c:
            task=self._get(c,value['taskId'])
            if task['status']!='running':raise ServiceError('只能回传执行中的创作任务',409)
            if value['status']!='failed' and (not value.get('titles') or not value.get('body')):raise ServiceError('请回传标题和正文')
            if value.get('images') and not value.get('imageProvider'):raise ServiceError('请记录实际使用的生图服务')
            if value['status']=='completed' and len(value.get('images',[]))!=task['imageCount']:raise ServiceError('生成图片数量不足，请使用 partial 并说明原因')
            task.update(value);self.repo.save(c,task);return task


class PublishQueue(Queue):
    busy=('running',)
    def __init__(self,path,db=None,tenant='owner'):super().__init__(path,'publish',db,tenant)

    def cancel(self,id):
        with self.repo.transaction() as c:
            task=self._get(c,id)
            if task['status']!='queued':raise ServiceError('仅可取消尚未领取的任务',409)
            task['status']='cancelled';self.repo.save(c,task);return task

    def complete(self,raw):
        # Original completionInput strips unknown fields, unlike strict creation input.
        if not isinstance(raw,dict):raise ServiceError('任务回执不合法')
        value={k:v for k,v in raw.items() if k in ('taskId','status','message','url','evidence')}
        if not {'taskId','status','message'}<=value.keys():raise ServiceError('任务回执不合法')
        if value['status'] not in ('published','draft_saved','failed'):raise ServiceError('任务回执状态不合法')
        value['message']=text(value['message'],'message',1,2000)
        if 'evidence' in value:value['evidence']=text(value['evidence'],'evidence',1,4000)
        if 'url' in value:https_url(value['url'])
        with self.repo.transaction() as c:
            task=self._get(c,value['taskId'])
            if task['status']!='running':raise ServiceError('只有执行中的任务可以回传结果',409)
            if value['status']!='failed':
                if not value.get('evidence'):raise ServiceError('成功状态需要实际页面结果证据')
                if value['status']=='published':
                    import re
                    if task['delivery']!='publish' or not re.match(r'^https://(www\.)?xiaohongshu\.com/',value.get('url','')):raise ServiceError('发布结果需要真实小红书原文链接')
                if value['status']=='draft_saved' and task['delivery']!='draft':raise ServiceError('任务类型不匹配')
            task.update(value);self.repo.save(c,task);return task
