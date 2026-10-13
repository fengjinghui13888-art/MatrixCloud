from __future__ import annotations

import base64
import copy
import hashlib
import io
import json
import re
import struct
import unicodedata
from pathlib import Path
from PIL import Image, ImageOps
from .store import SQLite, ServiceError, dumps, now, identifier, atomic_write, path_lock
from .queues import object_input, text, https_url

CATEGORIES=('美食','穿搭','美妆','家居','旅行','数码','宠物','运动','职场','生活方式')
KEY=re.compile(r'^[a-f0-9]{64}\.(png|jpg|webp)$')
MAX_BYTES=8*1024*1024


def template_input(raw):
    keys=('name','category','title','body','images','sourceUrl','usage','rightsNote')
    value=object_input(raw,keys,keys)
    for k,lo,hi in [('name',1,100),('title',1,20),('body',0,1000),('rightsNote',0,1000)]:value[k]=text(value[k],k,lo,hi)
    if value['category'] not in CATEGORIES or value['usage'] not in ('reference','owned','licensed'):raise ServiceError('模板分类或使用方式无效')
    if not isinstance(value['images'],list) or not 1<=len(value['images'])<=9:raise ServiceError('模板需要 1–9 张图片')
    for url in value['images']:
        if not isinstance(url,str) or not re.fullmatch(r'/api/templates/media/[a-f0-9]{64}\.(png|jpg|webp)',url):https_url(url)
    if value['sourceUrl']!='':https_url(value['sourceUrl'])
    return value


def fingerprint(value):
    normalize=lambda t:re.sub(r'[\s\ufeff]','',unicodedata.normalize('NFKC',t))
    return hashlib.sha256(dumps([normalize(value['title']),normalize(value['body']),value['images']]).encode()).hexdigest()


def decode_template_image(data):
    if not isinstance(data,str):raise ServiceError('仅支持 PNG、JPG、WebP 图片')
    match=re.fullmatch(r'data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})',data)
    if not match:raise ServiceError('仅支持 PNG、JPG、WebP 图片')
    try:blob=base64.b64decode(match[2],validate=True)
    except ValueError:raise ServiceError('图片编码不完整，请重新选择文件')
    if len(blob)>MAX_BYTES:raise ServiceError('单张图片不能超过 8 MB',413)
    if base64.b64encode(blob).decode()!=match[2]:raise ServiceError('图片编码不完整，请重新选择文件')
    png=len(blob)>45 and blob[:8]==b'\x89PNG\r\n\x1a\n' and blob[12:16]==b'IHDR' and int.from_bytes(blob[16:20],'big')>0 and int.from_bytes(blob[20:24],'big')>0 and blob[-8:-4]==b'IEND'
    jpg=len(blob)>32 and blob[:3]==b'\xff\xd8\xff' and blob[-2:]==b'\xff\xd9'
    webp=len(blob)>20 and blob[:4]==b'RIFF' and blob[8:12]==b'WEBP' and int.from_bytes(blob[4:8],'little')+8==len(blob)
    ext='png' if match[1]=='png' and png else 'jpg' if match[1]=='jpeg' and jpg else 'webp' if match[1]=='webp' and webp else None
    if not ext:raise ServiceError('文件内容与图片格式不匹配或已损坏')
    try:
        with Image.open(io.BytesIO(blob)) as image:
            if image.width*image.height>80_000_000:raise ServiceError('图片尺寸超过解码限制')
            # Legacy uploads accepted structurally valid, decodable PNG files even
            # when an IDAT checksum differs. Preserve those originals unchanged.
            image.load()
    except (OSError,ValueError,SyntaxError,Image.DecompressionBombError) as error:raise ServiceError('文件内容与图片格式不匹配或已损坏') from error
    return blob,hashlib.sha256(blob).hexdigest()+'.'+ext


class Templates:
    def __init__(self,path,uploads_root,workspace='owner',db=None):
        self.db,self.workspace=db,workspace
        self.sql=None if db else SQLite(path,'CREATE TABLE IF NOT EXISTS template_library(id TEXT PRIMARY KEY,fingerprint TEXT UNIQUE NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL);')
        self.folder=Path(uploads_root)/'template-uploads'/workspace
        self.lock=path_lock(self.folder)

    def transaction(self):return self.db.transaction(self.workspace) if self.db else self.sql.transaction()

    def _rows(self,c,id=None,fp=None):
        if self.db:
            query='SELECT payload FROM template WHERE tenant_id=%s';params=[self.workspace]
            if id is not None:query+=' AND id=%s';params.append(id)
            if fp is not None:query+=' AND fingerprint=%s';params.append(fp)
            query+=' ORDER BY id'
        else:
            query='SELECT payload FROM template_library WHERE 1=1';params=[]
            if id is not None:query+=' AND id=?';params.append(id)
            if fp is not None:query+=' AND fingerprint=?';params.append(fp)
            query+=' ORDER BY rowid DESC'
        return [copy.deepcopy(r['payload']) if isinstance(r['payload'],dict) else json.loads(r['payload']) for r in c.execute(query,params).fetchall()]

    def list(self):
        with self.transaction() as c:return self._rows(c)
    def _get(self,c,id):
        rows=self._rows(c,id=id)
        if not rows:raise ServiceError('模板不存在',404)
        return rows[0]
    def get(self,id):
        with self.transaction() as c:return self._get(c,id)
    def published(self):return [row['published'] for row in self.list() if row.get('published')]
    def mine(self):return {'items':[self._personal(row) for row in self.list() if row['draft']['sourceUrl']=='']}
    @staticmethod
    def _personal(row):return {**row['draft'],**{k:row[k] for k in ('id','revision','updatedAt')}}

    def create(self,raw):
        draft=template_input(raw);row=dict(id=identifier(),revision=1,draft=draft,published=None,updatedAt=now());fp=fingerprint(draft)
        with self.transaction() as c:
            if self.db:
                c.execute('INSERT INTO template(tenant_id,id,fingerprint,revision,payload) VALUES(%s,%s,%s,%s,%s::jsonb) ON CONFLICT(tenant_id,fingerprint) DO NOTHING',(self.workspace,row['id'],fp,1,dumps(row)))
            else:c.execute('INSERT OR IGNORE INTO template_library VALUES(?,?,?,?)',(row['id'],fp,1,dumps(row)))
            return self._rows(c,fp=fp)[0]

    def _save(self,c,row,expected):
        if self.db:
            result=c.execute('UPDATE template SET fingerprint=%s,revision=%s,payload=%s::jsonb WHERE tenant_id=%s AND id=%s AND revision=%s',(fingerprint(row['draft']),row['revision'],dumps(row),self.workspace,row['id'],expected))
        else:result=c.execute('UPDATE template_library SET fingerprint=?,revision=?,payload=? WHERE id=? AND revision=?',(fingerprint(row['draft']),row['revision'],dumps(row),row['id'],expected))
        if result.rowcount!=1:raise ServiceError('模板已更新，请刷新后重试',409)
        return row

    def update(self,id,raw,expected):
        draft=template_input(raw)
        with self.transaction() as c:
            row=self._get(c,id)
            if row['revision']!=expected:raise ServiceError('模板已更新，请刷新后重试',409)
            row.update(draft=draft,revision=expected+1,updatedAt=now());return self._save(c,row,expected)

    def publish(self,id,expected):
        with self.transaction() as c:
            row=self._get(c,id)
            if row['revision']!=expected:raise ServiceError('模板已更新，请刷新后重试',409)
            if row['draft']['usage']!='reference' and not row['draft']['rightsNote']:raise ServiceError('请填写来源授权说明')
            row['published']={**row['draft'],'id':id,'revision':row['revision'],'updatedAt':now()};return self._save(c,row,expected)
    def unpublish(self,id,expected):
        with self.transaction() as c:
            row=self._get(c,id)
            if row['revision']!=expected:raise ServiceError('模板已更新，请刷新后重试',409)
            row['published']=None;return self._save(c,row,expected)
    def delete_many(self,ids):
        if not ids:return
        with self.transaction() as c:
            if self.db:c.execute('DELETE FROM template WHERE tenant_id=%s AND id=ANY(%s::text[])',(self.workspace,list(dict.fromkeys(ids))))
            else:c.execute('DELETE FROM template_library WHERE id IN ('+','.join('?' for _ in ids)+')',ids)

    def upload(self,input):
        value=object_input(input,('fileName','data','category'),('fileName','data'))
        name=text(value['fileName'],'fileName',1,240);category=value.get('category','生活方式')
        if category not in CATEGORIES:raise ServiceError('请提供图片文件、文件名和有效分类')
        blob,key=decode_template_image(value['data']);url='/api/templates/media/'+key
        with self.lock:
            personal=[row for row in self.list() if row['draft']['sourceUrl']=='']
            existing=next((r for r in personal if url in r['draft']['images']),None)
            if existing:return dict(item=self._personal(existing),duplicate=True)
            self.folder.mkdir(parents=True,exist_ok=True,mode=0o700)
            used=sum(file.stat().st_size for file in self.folder.iterdir() if KEY.fullmatch(file.name) and file.is_file())
            file=self.folder/key
            if used+(0 if file.exists() else len(blob))>512*1024*1024:raise ServiceError('素材空间已达 512 MB，请联系管理员扩容',413)
            atomic_write(file,blob)
            name=re.sub(r'\.[^.]+$','',name)[:100] or '未命名素材'
            row=self.create(dict(name=name,category=category,title=name[:20],body='',images=[url],sourceUrl='',usage='owned',rightsNote='客户本地上传'))
            return dict(item=self._personal(row),duplicate=False)

    def bulk_delete(self,ids):
        with self.lock:
            personal={r['id'] for r in self.list() if r['draft']['sourceUrl']==''}
            if any(id not in personal for id in ids):raise ServiceError('素材不存在，请刷新列表',404)
            self.delete_many(ids)
            # Historical behavior removes metadata only. Original media stays protected.
            return dict(deleted=len(ids))

    def file(self,key,thumbnail=False):
        if not isinstance(key,str) or not KEY.fullmatch(key):return None
        url='/api/templates/media/'+key
        if not any(row['draft']['sourceUrl']=='' and url in row['draft']['images'] for row in self.list()):return None
        root=self.folder.resolve();file=(root/key).resolve()
        if not file.is_relative_to(root) or not file.is_file():return None
        if not thumbnail:return file
        destination=(root/'thumbnails'/(key+'.webp')).resolve()
        if not destination.is_relative_to(root):return None
        with self.lock:
            if not destination.exists():
                with Image.open(file) as image:
                    if image.width*image.height>80_000_000:raise ServiceError('图片尺寸超过解码限制')
                    image=ImageOps.exif_transpose(image);image.thumbnail((480,480));output=io.BytesIO();image.save(output,'WEBP',quality=75);atomic_write(destination,output.getvalue())
        return destination

    def references(self,ids):
        all={r['id']:r for r in self.list() if r['draft']['sourceUrl']==''};result=[]
        for id in ids:
            row=all.get(id)
            if not row:raise ServiceError('所选图片已删除或不可访问，请重新选择')
            key=row['draft']['images'][0].split('/')[-1];file=self.file(key)
            if not file:raise ServiceError('参考图格式无效')
            mime='jpeg' if key.endswith('.jpg') else key.rsplit('.',1)[1]
            result.append('data:image/'+mime+';base64,'+base64.b64encode(file.read_bytes()).decode())
        return result

    def save(self,data,name):
        blob,key=decode_template_image(data)
        with self.lock:
            self.folder.mkdir(parents=True,exist_ok=True,mode=0o700);atomic_write(self.folder/key,blob)
            url='/api/templates/media/'+key
            self.create(dict(name=name[:100],category='生活方式',title=name[:20],body='',images=[url],sourceUrl='',usage='owned',rightsNote='模型二次创作'))
            return url
