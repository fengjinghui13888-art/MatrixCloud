from __future__ import annotations

import base64
import copy
import hashlib
import json
import secrets
from contextlib import contextmanager
from pathlib import Path
from .store import ServiceError, atomic_write, dumps, identifier, now, path_lock


class Billing:
    def __init__(self,path):self.path=Path(path);self.lock=path_lock(path)
    @contextmanager
    def state(self,write=False):
        with self.lock:
            data=dict(balanceCredits=3000,apiKeys=[],usage=[],orders=[])
            if self.path.exists():
                existing=json.loads(self.path.read_text(encoding='utf-8'))
                if not isinstance(existing,dict):raise ServiceError('现有费用数据格式无效，请恢复备份',500)
                data.update(existing)
            if not isinstance(data['balanceCredits'],(int,float)) or any(not isinstance(data[k],list) for k in ('apiKeys','usage','orders')):raise ServiceError('现有费用数据格式无效，请恢复备份',500)
            yield data
            if write:atomic_write(self.path,dumps(data).encode())

    def create_api_key(self,name):
        secret='zx_live_'+base64.urlsafe_b64encode(secrets.token_bytes(24)).decode().rstrip('=')
        row=dict(id=identifier(),name=name.strip() or '未命名密钥',prefix=secret[:14],hash=hashlib.sha256(secret.encode()).hexdigest(),createdAt=now())
        with self.state(True) as data:data['apiKeys'].insert(0,row)
        return dict(id=row['id'],prefix=row['prefix'],secret=secret)

    def verify_api_key(self,secret):
        hash=hashlib.sha256(secret.encode()).hexdigest()
        with self.state() as data:
            row=next((r for r in data['apiKeys'] if not r.get('revokedAt') and secrets.compare_digest(r['hash'],hash)),None)
            return {k:row[k] for k in ('id','name','prefix')} if row else None

    def revoke_api_key(self,id):
        with self.state(True) as data:
            row=next((r for r in data['apiKeys'] if r['id']==id),None)
            if not row:raise ServiceError('密钥不存在',404)
            row['revokedAt']=row.get('revokedAt') or now();return {'ok':True}

    def debit(self,input):
        units=input.get('units')
        if type(units) not in (int,float) or not 0<units<float('inf'):raise ServiceError('扣费额度必须大于 0')
        with self.state(True) as data:
            if data['balanceCredits']<units:raise ServiceError('平台额度不足，请充值后重试')
            entry={**input,'id':identifier(),'createdAt':now()};data['balanceCredits']-=units;data['usage'].insert(0,entry);return copy.deepcopy(entry)

    def create_topup_order(self,plan):
        row=dict(id='ord_'+identifier(),plan=plan,credits=5000 if plan=='pro' else 20000 if plan=='team' else 1000,status='pending',createdAt=now())
        with self.state(True) as data:data['orders'].insert(0,row)
        return row

    def complete_topup(self,order_id,payment_reference):
        with self.state(True) as data:
            order=next((r for r in data['orders'] if r['id']==order_id),None)
            if not order:raise ServiceError('充值订单不存在',404)
            if order['status']=='paid':return copy.deepcopy(order)
            order.update(status='paid',paymentReference=payment_reference);data['balanceCredits']+=order['credits']
            data['usage'].insert(0,dict(id=identifier(),action='topup',units=order['credits'],description='充值套餐 '+order['plan'],createdAt=now()));return copy.deepcopy(order)

    def summary(self):
        with self.state() as data:return dict(balanceCredits=data['balanceCredits'],apiKeys=[{k:r[k] for k in ('id','name','prefix','createdAt','revokedAt') if k in r} for r in data['apiKeys']],recentUsage=copy.deepcopy(data['usage'][:20]))


class Workbuddy:
    def __init__(self,path):self.path=Path(path);self.lock=path_lock(path)
    def list(self):
        with self.lock:
            rows=json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else []
            if not isinstance(rows,list):raise ServiceError('现有任务数据格式无效，请恢复备份',500)
            return rows
    def create(self,input):
        if input['delivery']=='publish' and not input.get('confirmPublish'):raise ServiceError('发布任务需要明确确认')
        if input['delivery'] not in ('draft','publish'):raise ServiceError('任务类型不匹配')
        with self.lock:
            rows=self.list();task={k:input[k] for k in ('accountId','title','body','delivery')};task.update(id=identifier(),status='awaiting_browser',createdAt=now());rows.insert(0,task);atomic_write(self.path,dumps(rows).encode());return task
