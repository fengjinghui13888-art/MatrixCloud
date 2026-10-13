"""Create and verify a PostgreSQL custom-format backup; output contains no credentials."""
import hashlib,json,os,pathlib,subprocess,sys
def backup(destination,database='matrix'):
 destination=pathlib.Path(destination)
 if destination.exists():raise ValueError('备份文件已存在')
 destination.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 with destination.open('xb') as out:
  os.chmod(destination,0o600)
  subprocess.run(['docker','exec','matrix-postgres','pg_dump','-U','postgres','-d',database,'-Fc','--no-owner','--no-acl'],stdout=out,stderr=subprocess.PIPE,check=True)
 with destination.open('rb') as data:subprocess.run(['docker','exec','-i','matrix-postgres','pg_restore','--list'],stdin=data,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True)
 result={'bytes':destination.stat().st_size,'sha256':hashlib.sha256(destination.read_bytes()).hexdigest(),'format':'postgres-custom','database':database}
 manifest=destination.with_suffix(destination.suffix+'.json');manifest.write_text(json.dumps(result,indent=2));os.chmod(manifest,0o600)
 return result
if __name__=='__main__':print(json.dumps(backup(sys.argv[1],sys.argv[2] if len(sys.argv)>2 else 'matrix')))
