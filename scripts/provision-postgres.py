"""Provision a dedicated Matrix PostgreSQL instance. Existing databases are untouched."""
import os,pathlib,secrets,subprocess,json
root=pathlib.Path(os.environ.get('MATRIX_POSTGRES_ROOT', pathlib.Path.cwd()/'work'/'postgres'))
root.mkdir(mode=0o700,exist_ok=True)
def run(*args,**kwargs):return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs)
def secret(name,value):
 p=root/name
 if not p.exists():p.write_text(value);os.chmod(p,0o600)
 return p.read_text().strip()
admin=secret('admin-password',secrets.token_hex(32))
app=secret('app-password',secrets.token_hex(32))
env=root/'postgres.env';env.write_text('POSTGRES_PASSWORD='+admin+'\nPOSTGRES_DB=matrix\n');os.chmod(env,0o600)
exists=subprocess.run(['docker','inspect','matrix-postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
if not exists:
 run('docker','run','-d','--name','matrix-postgres','--restart','unless-stopped','--memory','320m','--cpus','1','--env-file',str(env),'-v',str(root/'data')+':/var/lib/postgresql/data','-p','127.0.0.1:55432:5432','postgres:16-alpine','-c','shared_buffers=64MB','-c','max_connections=30','-c','work_mem=2MB','-c','log_statement=none')
import time
for i in range(30):
 if subprocess.run(['docker','exec','matrix-postgres','pg_isready','-U','postgres','-d','matrix'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
 time.sleep(1)
sql="SELECT 'CREATE ROLE matrix_app LOGIN PASSWORD ''"+app+"'' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS' WHERE NOT EXISTS(SELECT FROM pg_roles WHERE rolname='matrix_app')\\gexec\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;\n"
run('docker','exec','-i','matrix-postgres','psql','-U','postgres','-d','matrix','-v','ON_ERROR_STOP=1',input=sql.encode())
secret('admin-url','postgresql://postgres:'+admin+'@127.0.0.1:55432/matrix')
secret('app-url','postgresql://matrix_app:'+app+'@127.0.0.1:55432/matrix')
print(json.dumps({'container':'matrix-postgres','bind':'127.0.0.1:55432','database':'matrix','applicationRole':'matrix_app','new':not exists}))
