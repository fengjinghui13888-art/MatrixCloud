"""Manifest-only cleanup of old generated cache; profiles/media are protected."""
import hashlib
import re
import time
import uuid
from pathlib import Path
from .files import atomic_json,read_json

class ConnectorCleanup:
    def __init__(self,root,jobs):self.root=Path(root); self.jobs=jobs; self.directory=self.root/'cleanup-manifests'
    def idle(self):
        if self.jobs.busy():raise ValueError('电脑仍有任务，暂不清理')
    def file(self,relative):
        if not re.fullmatch(r'generated-cache/draft-[\w-]+/(?:[1-9]|1[0-2])\.(png|jpg|webp)',relative):raise ValueError('文件受保护')
        path=self.root
        for part in relative.split('/'):
            path=path/part
            if path.is_symlink():raise ValueError('链接受保护')
        if not path.is_file():raise ValueError('文件受保护')
        return path
    def preview(self):
        self.idle(); files=[]; folder=self.root/'generated-cache'
        if folder.is_dir() and not folder.is_symlink():
            for dir in folder.iterdir():
                if not re.fullmatch(r'draft-[\w-]+',dir.name) or not dir.is_dir() or dir.is_symlink():continue
                for candidate in dir.iterdir():
                    try:
                        relative=candidate.relative_to(self.root).as_posix(); path=self.file(relative); stat=path.stat()
                        if time.time()-stat.st_mtime>86400:files.append(dict(path=relative,bytes=stat.st_size,sha256=hashlib.sha256(path.read_bytes()).hexdigest(),mtimeNs=stat.st_mtime_ns))
                    except ValueError:pass
        plan=dict(id=str(uuid.uuid4()),createdAt=time.time()*1000,files=files,bytes=sum(f['bytes'] for f in files)); atomic_json(self.directory/(plan['id']+'.json'),plan); return plan
    def apply(self,id):
        self.idle()
        if not re.fullmatch(r'[a-f0-9-]{36}',id):raise ValueError('清单无效')
        path=self.directory/(id+'.json'); plan=read_json(path)
        if not plan or plan.get('applied') or time.time()*1000-plan['createdAt']>3600000:raise ValueError('清单已使用或过期')
        reclaimed=0; skipped=[]
        for entry in plan['files']:
            try:
                file=self.file(entry['path']); stat=file.stat()
                if stat.st_size!=entry['bytes'] or entry.get('mtimeNs',stat.st_mtime_ns)!=stat.st_mtime_ns or hashlib.sha256(file.read_bytes()).hexdigest()!=entry['sha256']:raise ValueError('文件变化')
                file.unlink(); reclaimed+=entry['bytes']
            except (ValueError,OSError):skipped.append(entry['path'])
        atomic_json(path,{**plan,'applied':True,'reclaimedBytes':reclaimed,'skipped':skipped}); return dict(reclaimedBytes=reclaimed,skipped=skipped)
