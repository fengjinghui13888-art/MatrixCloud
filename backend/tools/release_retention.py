"""Retention applies only to releases registered by the trusted deployment helper."""
import datetime,json,pathlib,re,subprocess,hashlib,time

def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()

def remember(root,result):
 root=root.resolve();file=root/'verified-releases.json';history=json.loads(file.read_text()) if file.exists() else []
 row={**result,'verifiedAt':time.time()};history.append(row);file.write_text(json.dumps(history,indent=2));file.chmod(0o600);return row

def preview(root,history,now=None):
 root=root.resolve();now=now or time.time();latest=history[-1] if history else None
 if not latest:return {'files':[],'containers':[],'pending':'No verified release registry'}
 files=[];containers=[];keep={latest['container'],latest['retained']}
 for r in history[:-1]:
  if r['retained'] not in keep and re.fullmatch(re.escape(latest['container'])+r'-before-[\w-]+',r['retained']):containers.append(r['retained'])
  folder=pathlib.Path(r['backup'])
  if now-r['verifiedAt']<7*86400 or str(folder)==latest['backup']:continue
  if not folder.is_dir() or folder.is_symlink() or folder.resolve().parent!=root:continue
  folder=folder.resolve()
  for p in folder.rglob('*'):
   if p.is_symlink():raise ValueError('Backup contains symlinks')
   if p.is_file():files.append({'path':str(p.relative_to(root)),'sha256':sha(p),'bytes':p.stat().st_size})
 return {'root':str(root),'createdAt':now,'files':files,'containers':sorted(set(containers)),'keepContainers':sorted(keep),'keepUpgradeBackup':latest['backup']}

def apply_files(root,plan):
 root=root.resolve();removed=[]
 if plan.get('root')!=str(root) or time.time()-plan['createdAt']>3600:raise ValueError('Invalid cleanup manifest')
 # Verify each whole backup first. A changed backup is left intact.
 groups={}
 for e in plan['files']:groups.setdefault(pathlib.PurePosixPath(e['path']).parts[0],[]).append(e)
 for group,entries in groups.items():
  folder=root/group
  if not re.fullmatch(r'[a-f0-9-]{36}',group) or folder.is_symlink() or folder.resolve().parent!=root:continue
  valid=True
  for e in entries:
   p=root/e['path']
   if '..' in pathlib.PurePosixPath(e['path']).parts or any(x.is_symlink() for x in [p,*p.parents] if x!=root) or not p.is_file() or p.stat().st_size!=e['bytes'] or sha(p)!=e['sha256']:valid=False;break
  if not valid:continue
  for e in entries:(root/e['path']).unlink();removed.append(e)
  for p in sorted(folder.rglob('*'),key=lambda p:len(p.parts),reverse=True):
   if p.is_dir():
    try:p.rmdir()
    except OSError:pass
  try:folder.rmdir()
  except OSError:pass
 return {'reclaimedBytes':sum(e['bytes'] for e in removed),'files':removed}

def apply_containers(plan,inspect,command,all_images):
 """Remove only registered stopped releases; never prune unrelated Docker data."""
 removed=[];images=[];skipped=[]
 for name in plan.get('containers',[]):
  try:
   info=inspect(name)
   if info.get('State',{}).get('Running') or name in plan['keepContainers']:raise ValueError('Protected running/retained release')
   image=info['Image'];command('rm',name);removed.append(name)
   # Re-read every container reference after removal. No force image deletion.
   if image not in set(all_images()) and image not in images:command('image','rm',image);images.append(image)
  except Exception:skipped.append(name)
 return {'containers':removed,'images':images,'skipped':skipped}

def after_verified_deploy(root,result,docker):
 root=root.resolve();remember(root,result);history=json.loads((root/'verified-releases.json').read_text());plan=preview(root,history)
 report={'files':apply_files(root,plan),'docker':apply_containers(plan,docker.inspect,docker.command,lambda:[docker.inspect(name)['Image'] for name in subprocess.check_output(['docker','ps','-aq'],text=True).splitlines()])}
 # Docker ps can return tags, so all_images must resolve to immutable IDs.
 target=root/'last-cleanup.json';target.write_text(json.dumps(report,indent=2));target.chmod(0o600);return report
