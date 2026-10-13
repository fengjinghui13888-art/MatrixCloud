"""Portable offline backup/restore and conservative media garbage collection.
Python standard library only. Stop web service AND workers before mutations.
Backups contain private customer data and encryption keys; keep access restricted.
"""
import argparse, datetime, hashlib, json, os, pathlib, shutil, sqlite3, time, zipfile
from contextlib import closing

def sha(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
 return h.hexdigest()

def inside(root,relative):
 path=root/pathlib.Path(relative)
 if pathlib.Path(relative).is_absolute() or '..' in pathlib.Path(relative).parts or root.resolve() not in path.resolve().parents or path.is_symlink():
  raise ValueError('不安全的文件路径')
 return path

def db_check(path):
 with closing(sqlite3.connect(str(path))) as db:
  if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('数据库校验失败: '+str(path.name))

def backup(source,dest):
 source=source.resolve();dest=dest.resolve()
 if not source.is_dir() or dest.exists() or source==dest or source in dest.parents:raise ValueError('备份目标必须为数据目录外的新目录')
 dest.mkdir(mode=0o700,parents=True);folder=dest/'data';folder.mkdir(mode=0o700)
 entries=[]
 for src in sorted(source.rglob('*')):
  rel=src.relative_to(source);parts=rel.parts
  if src.is_symlink():raise ValueError('数据目录含符号链接，请先核查: '+str(rel))
  if not src.is_file():continue
  # Browser cookies are OS encrypted and cannot be reliably moved between machines.
  if 'local-connector' in parts and src.name!='connector-token':continue
  if any(p in ('studio-locks','sync-locks','quarantine','collector-venv','service-logs') for p in parts):continue
  if src.name.endswith(('-wal','-shm','-journal','.part','.tmp')):continue
  target=folder/rel;target.parent.mkdir(parents=True,exist_ok=True)
  if src.suffix=='.sqlite':
   with closing(sqlite3.connect(str(src))) as old,closing(sqlite3.connect(str(target))) as new:old.backup(new)
   db_check(target)
  else:shutil.copy2(src,target)
  os.chmod(target,0o600);entries.append({'path':rel.as_posix(),'bytes':target.stat().st_size,'sha256':sha(target)})
 manifest={'format':1,'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':entries,'browserLogin':'扫码重新授权；不迁移 Chrome 登录凭据'}
 (dest/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
 verify(dest);return manifest

def verify(folder):
 folder=folder.resolve();manifest=json.loads((folder/'manifest.json').read_text(encoding='utf8'))
 if manifest.get('format')!=1:raise ValueError('不支持的备份格式')
 expected=set()
 for entry in manifest['files']:
  if entry['path'] in expected:raise ValueError('备份清单重复')
  expected.add(entry['path']);p=inside(folder/'data',entry['path'])
  if not p.is_file() or p.stat().st_size!=entry['bytes'] or sha(p)!=entry['sha256']:raise ValueError('备份文件校验失败: '+entry['path'])
  if p.suffix=='.sqlite':db_check(p)
 actual={p.relative_to(folder/'data').as_posix() for p in (folder/'data').rglob('*') if p.is_file()}
 if actual!=expected:raise ValueError('备份包含未登记文件')
 return manifest

def restore(folder,dest):
 manifest=verify(folder)
 if dest.exists():raise ValueError('恢复目标必须为空的新目录，不覆盖现有用户数据')
 dest.mkdir(parents=True,mode=0o700)
 for entry in manifest['files']:
  target=inside(dest,entry['path']);target.parent.mkdir(parents=True,exist_ok=True)
  shutil.copy2(folder/'data'/entry['path'],target);os.chmod(target,0o600)
 return manifest

def audit_media(root,days=7):
 root=root.resolve();cutoff=time.time()-days*86400;report=[]
 if (root/'postgres-active').exists():raise ValueError('当前主数据库是 PostgreSQL，旧 SQLite 不能用于判断媒体引用；请使用新数据库的引用清单，不执行清理')
 # Fail closed: unreadable/missing indexes are never interpreted as empty.
 for dbpath in sorted(root.rglob('operations.sqlite')):
  if any(p in ('quarantine','local-connector') for p in dbpath.relative_to(root).parts):continue
  media=dbpath.parent/'media'
  if not media.exists():continue
  with closing(sqlite3.connect(str(dbpath))) as db:
   row=db.execute('SELECT payload FROM operations_state WHERE id=1').fetchone()
   if not row:raise ValueError('工作区没有索引，停止清理')
   data=json.loads(row[0])
  references={a['path'] for n in data['notes'] for a in n.get('mediaAssets',[])}
  references|={str(pathlib.PurePosixPath(p).with_suffix('.json')) for p in list(references)}
  for p in sorted(media.rglob('*')):
   if not p.is_file() or p.is_symlink() or p.stat().st_mtime>=cutoff:continue
   relative=p.relative_to(media).as_posix()
   if relative not in references:report.append({'path':p.relative_to(root).as_posix(),'bytes':p.stat().st_size,'sha256':sha(p)})
 return report

def quarantine(root,dest,days):
 if dest.exists() or root.resolve() in dest.resolve().parents:raise ValueError('隔离目录必须是数据目录外的新目录')
 candidates=audit_media(root,days)
 dest.mkdir(parents=True,mode=0o700)
 (dest/'manifest.json').write_text(json.dumps(candidates,ensure_ascii=False,indent=2),encoding='utf8')
 for entry in candidates:
  src=inside(root,entry['path']);target=inside(dest,entry['path']);target.parent.mkdir(parents=True,exist_ok=True)
  if sha(src)!=entry['sha256']:raise ValueError('文件发生变化，停止清理')
  shutil.move(str(src),str(target))
 return candidates

def package(source,dest):
 if dest.exists():raise ValueError('发行包已存在')
 allowed_dirs=('frontend','backend')
 forbidden_dirs={'node_modules','dist','.venv','__pycache__','.pytest_cache','data','outputs','.git'}
 with zipfile.ZipFile(dest,'x',zipfile.ZIP_DEFLATED) as z:
  for name in allowed_dirs:
   for p in sorted((source/name).rglob('*')):
    relative=p.relative_to(source)
    if any(part in forbidden_dirs for part in relative.parts):continue
    if p.is_file() and not p.is_symlink() and not p.name.endswith(('.local.json','.pyc','.enc','.sqlite','.sqlite-wal','.sqlite-shm','.log')) and (not p.name.startswith('.env') or p.name=='.env.example') and p.name not in ('access-token','connector-token','model-encryption-key'):z.write(p,relative)
 return {'archive':str(dest),'sha256':sha(dest),'dataIncluded':False}

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('action',choices=['backup','verify','restore','audit-media','quarantine','package'])
 parser.add_argument('source',type=pathlib.Path);parser.add_argument('destination',type=pathlib.Path,nargs='?')
 parser.add_argument('--offline',action='store_true',help='确认网站和执行器均已停止写入')
 parser.add_argument('--days',type=int,default=7)
 args=parser.parse_args()
 if args.action in ('backup','restore','quarantine') and not args.offline:parser.error('请先停止网站和执行器，再传 --offline')
 if args.action not in ('verify','audit-media') and args.destination is None:parser.error('缺少目标目录')
 if args.days<0:parser.error('days 不得为负数')
 if args.action=='backup':result=backup(args.source,args.destination)
 elif args.action=='restore':result=restore(args.source,args.destination)
 elif args.action=='verify':result=verify(args.source)
 elif args.action=='audit-media':result=audit_media(args.source,args.days)
 elif args.action=='quarantine':result=quarantine(args.source,args.destination,args.days)
 else:result=package(args.source,args.destination)
 print(json.dumps({'action':args.action,'files':len(result.get('files',[])) if isinstance(result,dict) else len(result),'result':result if args.action in ('audit-media','quarantine','package') else '校验通过'},ensure_ascii=False))
