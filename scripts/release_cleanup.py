"""Hash-checked project cleanup. No arbitrary paths, credentials or browser data.
Media cleanup requires a fresh PostgreSQL reference snapshot and an offline service.
"""
import argparse,hashlib,json,pathlib,time,os

def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()

def allowed(root,name):
 parts=pathlib.PurePosixPath(name).parts
 if not parts or pathlib.PurePosixPath(name).is_absolute() or any(p in ('.','..') for p in parts):raise ValueError('Unsafe path')
 if not (parts[0] in ('dist','.vite','__pycache__') or parts[0]=='outputs' and pathlib.Path(name).suffix in ('.zip','.tar','.gz','.tmp') or parts[0]=='service-logs' and pathlib.Path(name).suffix=='.log'):raise ValueError('Path is protected')
 current=root
 for p in parts:
  current=current/p
  if current.is_symlink():raise ValueError('Symlink is protected')
 if root not in current.resolve().parents:raise ValueError('Outside project')
 return current

def preview(root,now=None):
 root=root.resolve();now=now or time.time();entries=[]
 for name in ('dist','.vite','__pycache__','outputs','service-logs'):
  folder=root/name
  if folder.is_symlink() or not folder.is_dir():continue
  for p in folder.rglob('*'):
   rel=p.relative_to(root).as_posix()
   try:p=allowed(root,rel)
   except ValueError:continue
   if not p.is_file():continue
   # Keep recent packaging artifacts until release verification. Logs retain 14 days.
   days=14 if name=='service-logs' else 7 if name=='outputs' else 0
   if now-p.stat().st_mtime<days*86400:continue
   entries.append({'path':rel,'bytes':p.stat().st_size,'sha256':digest(p)})
 return {'format':1,'root':str(root),'createdAt':now,'files':entries,'bytes':sum(e['bytes'] for e in entries)}

def execute(root,manifest):
 root=root.resolve()
 if manifest.get('format')!=1 or manifest.get('root')!=str(root) or time.time()-manifest.get('createdAt',0)>3600:raise ValueError('Manifest expired or wrong project')
 removed=[];skipped=[]
 for e in manifest['files']:
  try:
   p=allowed(root,e['path'])
   if not p.is_file() or p.stat().st_size!=e['bytes'] or digest(p)!=e['sha256']:raise ValueError('File changed')
   p.unlink();removed.append(e)
  except (ValueError,OSError):skipped.append(e['path'])
 return {'removed':removed,'skipped':skipped,'reclaimedBytes':sum(e['bytes'] for e in removed)}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('action',choices=['preview','execute']);p.add_argument('--root',required=True,type=pathlib.Path);p.add_argument('--manifest',type=pathlib.Path,required=True);p.add_argument('--verified-release',action='store_true');a=p.parse_args()
 if a.action=='preview':
  result=preview(a.root);a.manifest.write_text(json.dumps(result,ensure_ascii=False,indent=2));os.chmod(a.manifest,0o600)
 else:
  if not a.verified_release:p.error('Execute only after release verification')
  result=execute(a.root,json.loads(a.manifest.read_text()))
 print(json.dumps(result,ensure_ascii=False))
