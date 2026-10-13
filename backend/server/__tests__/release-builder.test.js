// @vitest-environment node
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {it,expect} from 'vitest';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'release-source-'));
 const put=(name,text)=>{mkdirSync(join(root,name,'..'),{recursive:true});writeFileSync(join(root,name),text);};
 put('package.json','{"type":"module"}');put('.env.example','PUBLIC_ORIGIN=https://example.test\n');
 put('.gitignore','.env\n.handoff/\nwork/\noutputs/\nnode_modules/\n');
 put('server/baseline.ts','export const baseline=1;\n');put('server/postgres-schema.sql','CREATE TABLE required_for_migration(id integer);\n');
 put('deploy/matrix-ingress.conf','server { listen 443 ssl; }\n');put('deploy/matrix-cloud.service','[Service]\nExecStart=fixture\n');put('deploy/ingress/Dockerfile','FROM fixture\n');
 mkdirSync(join(root,'scripts'),{recursive:true});copyFileSync(resolve('scripts/build-release.mjs'),join(root,'scripts/build-release.mjs'));
 mkdirSync(join(root,'shared'),{recursive:true});
 for(const name of ['connector-platforms.mjs'])if(existsSync(resolve('shared',name)))copyFileSync(resolve('shared',name),join(root,'shared',name));
 execFileSync('git',['init','--quiet',root]);execFileSync('git',['-C',root,'add','.']);
 execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--quiet','-m','fixture']);
 return {root,put,run:(url='https://example.test')=>spawnSync(process.execPath,[join(root,'scripts/build-release.mjs'),'--cloud-url',url,'--output',join(root,'outputs/release')],{encoding:'utf8',env:{...process.env,PYTHON:process.env.PYTHON??(process.platform==='win32'?'python':'python3')}})};
}
it('packages separate frontend and backend manifests, source and shared contracts',()=>{
 const f=fixture();try{
  f.put('frontend/package.json','{"name":"@matrix/frontend","private":true}');
  f.put('frontend/src/main.tsx','export const frontend="preserved";');
  f.put('backend/package.json','{"name":"@matrix/backend","private":true}');
  f.put('backend/server/grey.ts','export const backend="preserved";');
  f.put('shared/domain.ts','export interface Account { id: string }');
  const result=f.run();expect(result.status,result.stderr).toBe(0);
  for(const name of ['frontend/package.json','frontend/src/main.tsx','backend/package.json','backend/server/grey.ts','shared/domain.ts'])
   expect(existsSync(join(f.root,'outputs/release/source',name)),name).toBe(true);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
it('includes the actual untracked repair snapshot, records dirty state and excludes credentials',()=>{
 const f=fixture();try{
  f.put('server/new-fix.ts','export const fix="customer repair";\n');f.put('server/baseline.ts','export const baseline=2;\n');
  f.put('.env','FIXTURE_SECRET=never-deliver');f.put('.handoff/access/private.key','fixture-private-secret');
  f.put('work/cloud-device.json','{"deviceToken":"fixture-private-token"}');f.put('access/admin.pem','fixture-private-key');
  f.put('server/private.pem','fixture-private-key');f.put('START-CONNECTOR.bat','@echo off\r\n');
  const result=f.run();expect(result.status,result.stderr+result.stdout).toBe(0);
  const output=join(f.root,'outputs/release');
  expect(readFileSync(join(output,'source/server/new-fix.ts'),'utf8')).toContain('customer repair');
  expect(readFileSync(join(output,'source/server/baseline.ts'),'utf8')).toContain('=2');
  expect(readFileSync(join(output,'source/server/postgres-schema.sql'),'utf8')).toContain('required_for_migration');
  expect(readFileSync(join(output,'source/deploy/matrix-ingress.conf'),'utf8')).toContain('listen 443');
  expect(readFileSync(join(output,'source/deploy/matrix-cloud.service'),'utf8')).toContain('ExecStart');
  expect(readFileSync(join(output,'source/deploy/ingress/Dockerfile'),'utf8')).toContain('FROM fixture');
  expect(existsSync(join(output,'source/START-CONNECTOR.bat'))).toBe(true);
  for(const name of ['.env','.handoff/access/private.key','work/cloud-device.json','access/admin.pem','server/private.pem'])expect(existsSync(join(output,'source',name))).toBe(false);
  const manifest=JSON.parse(readFileSync(join(output,'RELEASE-MANIFEST.json'),'utf8'));
  expect(manifest.source.dirty).toBe(true);expect(manifest.source.untrackedIncluded).toContain('server/new-fix.ts');
  expect(manifest.files.find(f=>f.path==='source/server/new-fix.ts').sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(existsSync(output+'.zip')).toBe(true);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
it('rejects a credential-bearing URL before creating a delivery directory',()=>{
 const f=fixture();try{const result=f.run('https://user:secret@example.test');expect(result.status).not.toBe(0);expect(existsSync(join(f.root,'outputs/release'))).toBe(false);}finally{rmSync(f.root,{recursive:true,force:true});}
});
