// @vitest-environment node
import {it,expect} from 'vitest';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,utimesSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {MaintenanceCleanup} from '../maintenance-cleanup';import {MaintenanceState} from '../maintenance-state';import {BrowserRuns} from '../browser-runs';
it('respects release and log retention on native filesystem paths',()=>{
 const root=mkdtempSync(join(tmpdir(),'retention-'));
 try{
  mkdirSync(join(root,'outputs'));mkdirSync(join(root,'service-logs'));
  const old=new Date(Date.now()-20*86400000);
  for(const name of ['outputs/old.zip','outputs/keep.txt','service-logs/old.log','service-logs/keep.txt']){
   const file=join(root,name);writeFileSync(file,'old');utimesSync(file,old,old);
  }
  writeFileSync(join(root,'outputs/new.zip'),'new');writeFileSync(join(root,'service-logs/new.log'),'new');
  const cleanup=new MaintenanceCleanup(root,new MaintenanceState(join(root,'state'))),plan=cleanup.preview();
  expect(plan.files.map(f=>f.path).sort()).toEqual(['outputs/old.zip','service-logs/old.log']);
  expect(cleanup.apply(plan.id)).toEqual({reclaimedBytes:6,skipped:[]});
  expect(readFileSync(join(root,'outputs/keep.txt'),'utf8')).toBe('old');
  expect(readFileSync(join(root,'service-logs/new.log'),'utf8')).toBe('new');
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('cleanup protects source, credentials and changed files',()=>{const root=mkdtempSync(join(tmpdir(),'clean-'));try{mkdirSync(join(root,'dist'));writeFileSync(join(root,'dist','a.js'),'cache');writeFileSync(join(root,'dist','changed.js'),'old');writeFileSync(join(root,'.env'),'secret');mkdirSync(join(root,'private'));writeFileSync(join(root,'private','secret'),'secret');symlinkSync(join(root,'private'),join(root,'dist','link'),process.platform==='win32'?'junction':'dir');const c=new MaintenanceCleanup(root,new MaintenanceState(join(root,'state'))),plan=c.preview();expect(plan.files).toHaveLength(2);writeFileSync(join(root,'dist','changed.js'),'new');expect(c.apply(plan.id)).toEqual({reclaimedBytes:5,skipped:['dist/changed.js']});expect(readFileSync(join(root,'.env'),'utf8')).toBe('secret');expect(()=>c.apply(plan.id)).toThrow();}finally{rmSync(root,{recursive:true,force:true});}});
it('account mutex persists across restarts and different computers',()=>{const root=mkdtempSync(join(tmpdir(),'mutex-'));try{const file=join(root,'runs.sqlite'),a=new BrowserRuns(file);a.claim('user-123','run-a','local:mac');const b=new BrowserRuns(file);expect(()=>b.claim('USER-123','run-b','local:windows')).toThrow();b.release('wrong');expect(()=>a.assertAvailable('user-123')).toThrow();b.release('run-a');a.claim('user-123','run-b','local:windows');}finally{rmSync(root,{recursive:true,force:true});}});
