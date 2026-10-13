"""Offline media GC: referenced files are protected; isolate for three days first."""
import pathlib,json,time,os
from release_cleanup import digest

def references(snapshot):
 if snapshot.get('source')!='postgres' or not snapshot.get('offline') or time.time()*1000-snapshot.get('createdAt',0)>300000:raise ValueError('A fresh offline PostgreSQL snapshot is required')
 refs=set(snapshot['files']);return refs|{str(pathlib.PurePosixPath(p).with_suffix('.json')) for p in refs}

def safe(root,rel):
 p=root/pathlib.PurePosixPath(rel)
 if pathlib.PurePosixPath(rel).is_absolute() or '..' in pathlib.PurePosixPath(rel).parts or root not in p.resolve().parents:raise ValueError('Invalid media path')
 for parent in [p,*p.parents]:
  if parent==root:break
  if parent.is_symlink():raise ValueError('Symlink is protected')
 return p

def quarantine(root,snapshot):
 root=root.resolve();refs=references(snapshot);folder=root/'quarantine-media';folder.mkdir(exist_ok=True,mode=0o700);entries=[]
 for base in [root/'media',root/'template-uploads',*root.glob('workspaces/*/media')]:
  if not base.exists():continue
  for p in base.rglob('*'):
   if not p.is_file() or p.is_symlink():continue
   rel=p.relative_to(root).as_posix();p=safe(root,rel)
   if p.suffix.lower() not in ('.jpg','.jpeg','.png','.webp','.gif','.mp4','.mov','.json') or rel in refs or '/thumbnails/' in rel or p.suffix in ('.part','.tmp') or time.time()-p.stat().st_mtime<3*86400:continue
   key=digest(p);dest=folder/(key+'-'+str(time.time_ns()));entry={'path':rel,'isolated':dest.name,'sha256':key,'bytes':p.stat().st_size,'at':time.time()};entries.append(entry)
   # Journal before the move; a crash cannot create an untracked orphan.
   old=json.loads((folder/'manifest.json').read_text()) if (folder/'manifest.json').exists() else []
   journal=folder/'manifest.tmp';journal.write_text(json.dumps(old+[entry]));journal.chmod(0o600);journal.replace(folder/'manifest.json');p.rename(dest)
 # Append, never overwrite earlier isolation history.
 old=json.loads((folder/'manifest.json').read_text()) if (folder/'manifest.json').exists() else []
 return entries

def purge(root,snapshot):
 root=root.resolve();refs=references(snapshot);folder=root/'quarantine-media';manifest=folder/'manifest.json';entries=json.loads(manifest.read_text());kept=[];removed=[]
 for e in entries:
  p=safe(root,'quarantine-media/'+e['isolated']);original=safe(root,e['path'])
  if not p.is_file() or digest(p)!=e['sha256']:kept.append(e);continue
  if e['path'] in refs:
   if not original.exists():original.parent.mkdir(parents=True,exist_ok=True);p.rename(original)
   else:kept.append(e)
  elif time.time()-e['at']>=3*86400:p.unlink();removed.append(e)
  else:kept.append(e)
 manifest.write_text(json.dumps(kept));return removed

if __name__=='__main__':
 import argparse
 p=argparse.ArgumentParser();p.add_argument('action',choices=['quarantine','purge']);p.add_argument('--root',required=True,type=pathlib.Path);p.add_argument('--references',required=True,type=pathlib.Path);p.add_argument('--offline',action='store_true');a=p.parse_args()
 if not a.offline:p.error('Stop the service and all workers before media cleanup')
 result=(quarantine if a.action=='quarantine' else purge)(a.root,json.loads(a.references.read_text()));print(json.dumps({'files':result,'bytes':sum(e['bytes'] for e in result)}))
