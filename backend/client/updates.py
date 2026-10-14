"""Pinned-key, bounded, atomic connector-code updates. Never installs dependencies."""
from pathlib import Path, PurePosixPath
import hashlib
import io
import json
import os
import re
import stat
import time
import uuid
import zipfile
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

RUNTIME_ABI='python313-connector4-v1'
MAX_PACKAGE=32*1024*1024


def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8')


def allowed_file(name):
    path=PurePosixPath(name)
    return isinstance(name,str) and '\\' not in name and name==path.as_posix() and not path.is_absolute() and '..' not in path.parts and (
        re.fullmatch(r'connector/[a-z_]+\.py',name) is not None or name in ('app/__init__.py','app/protocols.py'))


def verify_manifest(envelope,public_key,*,embedded=False):
    try:
        if not isinstance(envelope,dict) or set(envelope)!={'manifest','signature'}:raise ValueError()
        m=envelope['manifest']
        if len(canonical(m))>65536:raise ValueError()
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key)).verify(bytes.fromhex(envelope['signature']),canonical(m))
        if set(m)!={'format','revision','protocol','abi','expires','package','bytes','sha256','files'}:raise ValueError()
        if m['format']!=1 or type(m['revision']) is not int or m['revision']<1 or m['protocol']!=4 or m['abi']!=RUNTIME_ABI:raise ValueError()
        if type(m['expires']) is not int or m['expires']<=0 or not embedded and m['expires']<=int(time.time()):raise ValueError()
        if type(m['bytes']) is not int or not 0<m['bytes']<=MAX_PACKAGE or not re.fullmatch('[a-f0-9]{64}',m['sha256']):raise ValueError()
        if m['package']!=f'/api/connector/client/packages/{m["revision"]}.zip':raise ValueError()
        files=m['files']
        if not isinstance(files,dict) or not 4<=len(files)<=100 or not {'connector/__init__.py','connector/__main__.py','app/__init__.py','app/protocols.py'}<=set(files):raise ValueError()
        if any(not allowed_file(n) or not re.fullmatch('[a-f0-9]{64}',h) for n,h in files.items()):raise ValueError()
        return m
    except Exception as exc:raise ValueError('更新签名、格式、协议或有效期不符合要求') from exc


def atomic_json(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.part')
    with temporary.open('x',encoding='utf-8') as stream:
        os.chmod(temporary,0o600);json.dump(value,stream,ensure_ascii=False);stream.flush();os.fsync(stream.fileno())
    temporary.replace(path)


class UpdateStore:
    def __init__(self,root,public_key):self.root=Path(root).resolve();self.public_key=public_key
    def state(self):
        path=self.root/'state.json'
        return json.loads(path.read_text(encoding='utf-8')) if path.is_file() else dict(current=None,lastGood=None,highWater=0,rejected=[],pending=None)
    def path(self,revision):
        if type(revision) is not int or revision<1:raise ValueError('版本号无效')
        return self.root/'versions'/str(revision)
    def stage(self,envelope,blob,*,embedded=False):
        state=self.state()
        if embedded and state['highWater']!=0:raise ValueError('内嵌初始版本只能用于首次安装')
        m=verify_manifest(envelope,self.public_key,embedded=embedded);revision=m['revision']
        if revision<=state['highWater'] or revision in state['rejected']:raise ValueError('更新版本已安装、已拒绝或发生降级')
        if len(blob)!=m['bytes'] or hashlib.sha256(blob).hexdigest()!=m['sha256']:raise ValueError('更新文件校验失败')
        destination=self.path(revision)
        if destination.exists():raise ValueError('版本目录已存在，请核对安装状态')
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            names=archive.namelist()
            if len(names)!=len(set(names)) or set(names)!=set(m['files']):raise ValueError('更新文件列表不匹配')
            if sum(i.file_size for i in archive.infolist())>MAX_PACKAGE:raise ValueError('更新解压大小超限')
            verified={}
            for info in archive.infolist():
                if not allowed_file(info.filename) or stat.S_ISLNK(info.external_attr>>16):raise ValueError('更新包含不安全路径')
                value=archive.read(info)
                if hashlib.sha256(value).hexdigest()!=m['files'][info.filename]:raise ValueError('更新文件哈希不匹配')
                if len(value)>2*1024*1024:raise ValueError('代码文件过大')
                compile(value,info.filename,'exec');verified[info.filename]=value
        temporary=self.root/'versions'/('.stage-'+uuid.uuid4().hex)
        temporary.mkdir(parents=True,mode=0o700)
        for name,value in verified.items():
            file=temporary/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(value)
        atomic_json(temporary/'release.json',envelope)
        temporary.replace(destination);state['highWater']=revision;state['pending']=revision;atomic_json(self.root/'state.json',state)
        return destination
    def validate_installed(self,revision):
        # An installed signed release remains runnable after its download expiry.
        path=self.path(revision);envelope=json.loads((path/'release.json').read_text())
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(self.public_key)).verify(bytes.fromhex(envelope['signature']),canonical(envelope['manifest']))
        m=envelope['manifest']
        if m['revision']!=revision or m['abi']!=RUNTIME_ABI:raise ValueError('本机版本校验失败')
        for name,digest in m['files'].items():
            if not allowed_file(name) or hashlib.sha256((path/name).read_bytes()).hexdigest()!=digest:raise ValueError('本机代码已变更')
        return path
    def activate(self,revision):
        self.validate_installed(revision);state=self.state();state['current']=revision;state['pending']=None;atomic_json(self.root/'state.json',state)
    def confirm(self,revision):
        state=self.state()
        if state['current']!=revision:raise ValueError('运行版本不一致')
        state['lastGood']=revision;atomic_json(self.root/'state.json',state)
    def rollback(self,revision):
        state=self.state();state['rejected']=sorted(set(state['rejected']+[revision]));state['current']=state['lastGood'];atomic_json(self.root/'state.json',state)


def fetch_update(store,origin,client):
    from urllib.parse import urlsplit
    origin=origin.rstrip('/');url=urlsplit(origin)
    if url.scheme!='https' and not (url.scheme=='http' and url.hostname in ('127.0.0.1','localhost','::1')):raise ValueError('更新必须通过 HTTPS')
    if url.username or url.password or url.query or url.fragment or url.path:raise ValueError('更新地址无效')
    with client.stream('GET',origin+'/api/connector/client/manifest',follow_redirects=False,timeout=15) as response:
        response.raise_for_status();raw=b''
        for part in response.iter_bytes():
            raw+=part
            if len(raw)>65536:raise ValueError('更新清单过大')
    envelope=json.loads(raw);m=verify_manifest(envelope,store.public_key)
    if m['revision']<=store.state()['highWater']:return None
    with client.stream('GET',origin+m['package'],follow_redirects=False,timeout=30) as response:
        response.raise_for_status();blob=b''
        for part in response.iter_bytes():
            blob+=part
            if len(blob)>m['bytes']:raise ValueError('更新包过大')
    store.stage(envelope,blob);return m['revision']
