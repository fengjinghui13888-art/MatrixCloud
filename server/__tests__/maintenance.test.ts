// @vitest-environment node
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach,expect,it} from 'vitest';
import {MaintenanceService} from '../maintenance-service';

const roots:string[]=[];
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'matrix-maintenance-'));roots.push(root);
 const repo=join(root,'repo');mkdirSync(join(repo,'src'),{recursive:true});
 writeFileSync(join(repo,'src/app.ts'),'export const value = 1;\n');writeFileSync(join(repo,'.env'),'SECRET=must-not-leak');
 writeFileSync(join(repo,'.gitignore'),'.env\n');
 const git=(...a:string[])=>execFileSync('git',['-C',repo,...a],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 git('init');git('add','src','.gitignore');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','baseline');
 const calls:any[]=[];const runner=async(kind:string,context:any)=>{calls.push({kind,context});return {ok:true,summary:'passed',imageDigest:kind==='build'?'sha256:'+'a'.repeat(64):undefined};};
 const svc=new MaintenanceService({repoRoot:repo,stateRoot:join(root,'state'),runner});
 return {root,repo,svc,calls,head:git('rev-parse','HEAD')};
}
afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
it('reads only tracked source and refuses traversal, secrets and symlinks',async()=>{
 const {svc,repo}=fixture();
 expect(await svc.readSource('src/app.ts',1,10)).toContain('value = 1');
 for(const name of ['../repo/.env','.env','/etc/passwd','src/../.env'])await expect(svc.readSource(name,1,10)).rejects.toThrow();
 const outside=join(repo,'..','private');mkdirSync(outside);writeFileSync(join(outside,'secret.ts'),'secret');
 symlinkSync(outside,join(repo,'src/link'),process.platform==='win32'?'junction':'dir');
 await expect(svc.readSource('src/link/secret.ts',1,10)).rejects.toThrow('符号链接');
});
it('binds checks and human approval to the exact reviewed release and consumes approval',async()=>{
 const {svc,head,calls}=fixture();const change=await svc.createChange(head);
 await svc.applyPatch(change.id,'src/app.ts','export const value = 2;\n',await svc.fileHash(change.id,'src/app.ts'));
 await expect(svc.prepareRelease(change.id)).rejects.toThrow(/检查/);
 await svc.runChecks(change.id);const release=await svc.prepareRelease(change.id);
 await expect(svc.deployRelease(release.id)).rejects.toThrow(/确认/);
 svc.approveRelease(release.id,'owner');
 await svc.deployRelease(release.id);
 expect(calls.filter(c=>c.kind==='deploy')).toHaveLength(1);
 await expect(svc.deployRelease(release.id)).rejects.toThrow();
});
it('rejects stale patches and invalidates checks after another edit',async()=>{
 const {svc,head}=fixture();const c=await svc.createChange(head),hash=await svc.fileHash(c.id,'src/app.ts');
 await svc.applyPatch(c.id,'src/app.ts','export const value = 3;\n',hash);
 await expect(svc.applyPatch(c.id,'src/app.ts','oops',hash)).rejects.toThrow(/已改变/);
 await svc.runChecks(c.id);
 await svc.applyPatch(c.id,'src/app.ts','export const value = 4;\n',await svc.fileHash(c.id,'src/app.ts'));
 await expect(svc.prepareRelease(c.id)).rejects.toThrow(/检查/);
});
it('refuses an approved release after a patch and after checks fail',async()=>{
 const {svc,head,calls}=fixture();const c=await svc.createChange(head);await svc.runChecks(c.id);const release=await svc.prepareRelease(c.id);svc.approveRelease(release.id,'owner');await svc.applyPatch(c.id,'src/app.ts','export const value = 5;\n',await svc.fileHash(c.id,'src/app.ts'));await expect(svc.deployRelease(release.id)).rejects.toThrow('改变');expect(calls.some(c=>c.kind==='deploy')).toBe(false);
 await svc.runChecks(c.id);const next=await svc.prepareRelease(c.id);svc.approveRelease(next.id,'owner');svc.options.runner=async()=>({ok:false,summary:'failure injection'});await svc.runChecks(c.id);await expect(svc.deployRelease(next.id)).rejects.toThrow('改变');
});
