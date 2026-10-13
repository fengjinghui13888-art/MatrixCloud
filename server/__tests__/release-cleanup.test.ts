// @vitest-environment node
import {it,expect} from 'vitest';import {execFileSync} from 'node:child_process';
it('quarantines only unreferenced media and preserves rollback releases and changed backups',()=>{
 const result=execFileSync(process.platform==='win32'?'python':'python3',['-c',`
import sys,tempfile,pathlib,time,json,importlib.util
sys.path.insert(0,'scripts')
from release_retention import preview,apply_files,apply_containers
spec=importlib.util.spec_from_file_location('media','scripts/media-quarantine.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d);(root/'media').mkdir();a=root/'media/a.png';a.write_bytes(b'active');b=root/'media/b.png';b.write_bytes(b'orphan')
 import os
 for f in (a,b):os.utime(f,(time.time()-400000,time.time()-400000))
 snapshot={'source':'postgres','offline':True,'createdAt':time.time()*1000,'files':['media/a.png']}
 isolated=m.quarantine(root,snapshot);assert len(isolated)==1 and a.exists() and not b.exists()
 snapshot['files'].append('media/b.png');assert m.purge(root,snapshot)==[] and b.exists()
 backup=root/'11111111-1111-4111-8111-111111111111';backup.mkdir();(backup/'data').write_text('old')
 history=[{'container':'matrix','retained':'matrix-before-old','backup':str(backup),'verifiedAt':time.time()-800000},{'container':'matrix','retained':'matrix-before-current','backup':str(root/'new'),'verifiedAt':time.time()}]
 plan=preview(root,history);assert plan['containers']==['matrix-before-old'];(backup/'data').write_text('changed');assert apply_files(root,plan)['reclaimedBytes']==0
 commands=[];r=apply_containers(plan,lambda name:{'State':{'Running':False},'Image':'sha256:old'},lambda *args:commands.append(args),lambda:['sha256:old']);assert commands==[('rm','matrix-before-old')] and not r['images']
print('ok')
`],{encoding:'utf8'});expect(result.trim()).toBe('ok');
});
