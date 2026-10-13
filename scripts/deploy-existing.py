"""Upgrade the existing single-host container, preserving Docker configuration.
Run on the deployment host as a Docker-capable user. Builds must finish first.
The backup contains credentials and must remain private. No schema rollback.
"""
import argparse,copy,datetime,http.client,json,os,pathlib,socket,subprocess,time,urllib.request,urllib.parse,fcntl
from maintenance import backup,verify

class Docker:
 def inspect(self,name):return json.loads(subprocess.check_output(['docker','inspect',name]))[0]
 def command(self,*args):subprocess.run(['docker',*args],check=True,stdout=subprocess.DEVNULL)
 def create(self,name,payload):
  class UnixHTTP(http.client.HTTPConnection):
   def connect(self):
    self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(30);socket_path=os.environ.get('MATRIX_DOCKER_SOCKET')
    if not socket_path: raise RuntimeError('请设置 MATRIX_DOCKER_SOCKET')
    self.sock.connect(socket_path)
  api=subprocess.check_output(['docker','version','--format','{{.Server.APIVersion}}'],text=True).strip()
  conn=UnixHTTP('localhost',timeout=30)
  try:
   conn.request('POST','/v'+api+'/containers/create?name='+urllib.parse.quote(name),body=json.dumps(payload),headers={'Content-Type':'application/json'})
   response=conn.getresponse();response.read()
   if response.status!=201:raise RuntimeError('Docker 创建替换容器失败：HTTP '+str(response.status))
  finally:conn.close()

def replacement(old,image,image_info=None):
 if old['HostConfig']['NetworkMode']!='host':raise ValueError('此部署工具仅支持当前 host 网络，拒绝猜测其他网络配置')
 mounts=[m for m in old['Mounts'] if m['Destination']=='/app/work/grey' and m['Type']=='bind' and m['RW']]
 if len(mounts)!=1:raise ValueError('必须保留唯一可写持久化数据挂载')
 payload=copy.deepcopy(old['Config']);payload['Image']=image
 payload['HostConfig']=copy.deepcopy(old['HostConfig'])
 if payload['HostConfig'].get('LogConfig',{}).get('Type','json-file') in ('','json-file'):
  payload['HostConfig']['LogConfig']={'Type':'json-file','Config':{'max-size':'20m','max-file':'3'}}
 # Preserve customer bindings and limits, but never let a retained container
 # override the runtime environment baked into the replacement image.
 image_info=image_info or old
 image_defaults={x.split('=',1)[0]:x for x in image_info.get('Config',{}).get('Env',[]) if '=' in x}
 # The retained container's Config is copied to preserve customer bindings,
 # but release identity must come from the replacement image.  Otherwise a
 # healthy upgrade can still report the previous commit to maintenance tools.
 payload['Labels']=copy.deepcopy(image_info.get('Config',{}).get('Labels') or {})
 retained={x.split('=',1)[0]:x for x in payload.get('Env',[]) if '=' in x}
 for key in ('PATH','NODE_VERSION','YARN_VERSION'):
  if key in image_defaults: retained[key]=image_defaults[key]
 payload['Env']=list(retained.values())
 return payload,pathlib.Path(mounts[0]['Source'])

def healthy(config):
 env=dict(x.split('=',1) for x in config.get('Env',[]) if '=' in x)
 url='http://127.0.0.1:'+env.get('PORT','4174')+'/api/health'
 try:
  with urllib.request.urlopen(url,timeout=3) as r:
   health=json.load(r)
   if not health.get('ok'):return False
  connector=env.get('LOCAL_CONNECTOR_URL')
  # Customer computers have independent outbound WebSocket channels. Their
  # availability is a per-device state, not a prerequisite to deploy the cloud.
  customer_cloud=bool(env.get('CUSTOMER_PUBLIC_ORIGIN')) and health.get('storage')=='postgresql'
  if connector and not customer_cloud:
   token=env.get('LOCAL_CONNECTOR_TOKEN')
   if not token:return False
   req=urllib.request.Request(connector.rstrip('/')+'/verify',headers={'Authorization':'Bearer '+token})
   with urllib.request.urlopen(req,timeout=3) as r:
    if not json.load(r).get('ok'):return False
  return True
 except Exception:return False

def deploy(docker,name,image,destination,check=healthy,callback_url=None,tls_origin=None,postgres=False):
 old=docker.inspect(name);docker.inspect(image) # Require already built image.
 payload,data=replacement(old,image,docker.inspect(image))
 if postgres:
  credentials=pathlib.Path(os.environ.get('MATRIX_POSTGRES_ROOT', pathlib.Path.cwd()/'work'/'postgres'))
  if not (credentials/'app-url').is_file() or not (credentials/'admin-url').is_file():raise ValueError('PostgreSQL 凭证未准备')
  payload['Env']=[v for v in payload.get('Env',[]) if not v.startswith(('DATABASE_URL=','DATABASE_URL_FILE=','DEPLOYMENT_HOLD_FILE='))]+['DATABASE_URL_FILE=/run/matrix-db-url','DEPLOYMENT_HOLD_FILE=/app/work/grey/deployment-hold']
  payload['HostConfig']['Binds']=[v for v in payload['HostConfig'].get('Binds',[]) if ':/run/matrix-db-url' not in v]+[str(credentials/'app-url')+':/run/matrix-db-url:ro']
 if callback_url:
  parsed=urllib.parse.urlsplit(callback_url)
  if parsed.scheme not in ("http","https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:raise ValueError("无效回传地址")
  payload["Env"]=[v for v in payload.get("Env",[]) if not v.startswith("STUDIO_CALLBACK_URL=")]+["STUDIO_CALLBACK_URL="+callback_url]
 if tls_origin:
  parsed=urllib.parse.urlsplit(tls_origin)
  if parsed.scheme!="https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path or parsed.port not in (None,443):raise ValueError("HTTPS 来源必须是无路径的标准 443 地址")
  for filename in ("fullchain.pem","privkey.pem"):
   if not (data/"tls"/filename).is_file():raise ValueError("正式 HTTPS 证书文件缺失")
  updated={"CUSTOMER_PUBLIC_ORIGIN":tls_origin,"TLS_CERT":"/app/work/grey/tls/fullchain.pem","TLS_KEY":"/app/work/grey/tls/privkey.pem","TLS_PORT":"443"}
  payload["Env"]=[v for v in payload.get("Env",[]) if v.split("=",1)[0] not in updated]+[k+"="+v for k,v in updated.items()]
 for folder in ('xhs-sync','studio-locks'):
  for p in data.rglob(folder+'/*'):
   if p.is_file():
    try:active=json.loads(p.read_text()).get('status')=='running'
    except (ValueError,UnicodeError):active=False
    if active:raise ValueError('仍有运行任务，请先停止任务后再升级')
 destination=pathlib.Path(destination)
 if destination.exists() or data.resolve()==destination.resolve() or data.resolve() in destination.resolve().parents:raise ValueError('备份必须位于数据目录外的新目录')
 tag=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ');retained=name+'-before-'+tag
 stopped=False;renamed=False;created=False
 try:
  if postgres:
   (data/'deployment-hold').write_text('系统正在升级，请稍后重新打开')
   active=int(subprocess.check_output(['docker','exec','matrix-postgres','psql','-U','postgres','-d','matrix','-At','-c',"SELECT (SELECT count(*) FROM job WHERE status='running')+(SELECT count(*) FROM generation WHERE status IN ('generating','running','filling','approved','pending_confirmation'))"],text=True).strip())
   if active:raise ValueError('数据库中仍有执行中或等待确认的任务，请先处理任务后再升级')
  docker.command('stop','--time','30',name);stopped=True
  backup(data,destination);verify(destination)
  if postgres:
   from postgres_backup import backup as backup_database
   backup_database(destination/'database-before.dump')
   migrated=subprocess.run(['docker','run','--rm','--network','host','-v',str(data)+':/app/work/grey:ro','-v',str(credentials/'admin-url')+':/run/migration-db-url:ro','-e','DATABASE_URL_FILE=/run/migration-db-url',image,'node','--import','tsx','scripts/migrate-postgres.ts','/app/work/grey'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   if migrated.returncode:
    error=destination/'migration-error.log';error.write_text(migrated.stderr);os.chmod(error,0o600)
    raise RuntimeError('数据库迁移未通过，已停止切换；检查备份目录中的迁移日志')
   report=destination/'migration-report.json';report.write_text(migrated.stdout);os.chmod(report,0o600)
   (data/'deployment-hold').write_text('正在验证升级后的服务')
  state=destination/'container-config.json';state.write_text(json.dumps(old));os.chmod(state,0o600)
  docker.command('rename',name,retained);renamed=True
  docker.create(name,payload);created=True;docker.command('start',name)
  for _ in range(20):
   if check(payload):
    state=docker.inspect(name)
    if state.get('State',{}).get('Running') and state.get('RestartCount',0)==0 and state.get('Config',{}).get('Image')==image:
     time.sleep(3)
     confirmed=docker.inspect(name)
     if confirmed.get('State',{}).get('Running') and confirmed.get('RestartCount',0)==0:
      if postgres:
       (data/'postgres-active').write_text('PostgreSQL schema 2; legacy SQLite is a pre-migration snapshot')
       (data/'deployment-hold').unlink(missing_ok=True)
      return {'container':name,'image':image,'retained':retained,'backup':str(destination)}
   time.sleep(1)
  raise RuntimeError('新版本健康或配对检查失败')
 except BaseException:
  if postgres:(data/'deployment-hold').unlink(missing_ok=True)
  if created:docker.command('rm','--force',name)
  if renamed:docker.command('rename',retained,name)
  if stopped:docker.command('start',name)
  raise

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--name',default='matrix-cloud');p.add_argument('--image',required=True);p.add_argument('--backup',type=pathlib.Path,required=True);p.add_argument('--callback-url');p.add_argument('--tls-origin');p.add_argument('--postgres',action='store_true');a=p.parse_args()
 with open(os.environ.get('MATRIX_DEPLOY_LOCK', str(pathlib.Path.cwd()/'work'/'matrix-cloud-deploy.lock')), 'w') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  docker=Docker();result=deploy(docker,a.name,a.image,a.backup,callback_url=a.callback_url,tls_origin=a.tls_origin,postgres=a.postgres)
  try:
   from release_retention import after_verified_deploy
   result['cleanup']=after_verified_deploy(a.backup.parent,result,docker)
  except Exception as error:result['cleanup']={'status':'pending','reason':str(error)}
  print(json.dumps(result,ensure_ascii=False))
