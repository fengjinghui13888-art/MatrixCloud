// @vitest-environment node
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

afterEach(()=>{
 vi.unstubAllEnvs();vi.resetModules();
 vi.doUnmock('../../../scripts/xhs-playwright.mjs');
 vi.doUnmock('../../../scripts/xhs-media.mjs');
});

test.each(['write','rename'])('the local worker saves a specific blocked receipt after a progress %s failure',async failure=>{
 const fixture=mkdtempSync(join(tmpdir(),'local-sync-worker-')),root=join(fixture,'connector'),id='fixture-job',dir=join(root,'sync-jobs',id);
 const statePath=join(dir,'state.json'),obstacle=failure==='write'?statePath+'.tmp':statePath;
 mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'input.json'),JSON.stringify({target:{id:'fixture',handle:'fixture',profile:'local:fixture'},knownNotes:[]}));
 writeFileSync(statePath,JSON.stringify({status:'running',stage:'account',checkpoint:false}));
 vi.stubEnv('LOCAL_CONNECTOR_ROOT',root);
 vi.doMock('../../../scripts/xhs-playwright.mjs',()=>({collectWithPlaywright:async({onProgress})=>{
  if(failure==='rename')rmSync(statePath);
  mkdirSync(obstacle);
  try{await onProgress({stage:'notes',message:'fixture notes'});}
  finally{rmSync(obstacle,{recursive:true,force:true});}
  throw Error('unexpected successful progress');
 }}));
 vi.doMock('../../../scripts/xhs-media.mjs',()=>({archiveMedia:async()=>{throw Error('unexpected media collection');}}));
 const argv=process.argv;process.argv=[argv[0],argv[1],id];
 try{
  await expect(import('../../../local-connector/sync-worker.mjs')).resolves.toBeDefined();
  const receipt=JSON.parse(readFileSync(statePath,'utf8'));
  expect(receipt).toMatchObject({status:'blocked',stage:'blocked',errorStage:'notes',checkpoint:false});
  expect(receipt.message).toContain('state.json');
  expect(receipt.message).not.toContain('unexpected successful progress');
  expect(receipt.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(existsSync(join(dir,'result.json'))).toBe(false);
 }finally{process.argv=argv;rmSync(fixture,{recursive:true,force:true});}
});

test('the local worker retains a saved checkpoint when its state receipt fails',async()=>{
 const fixture=mkdtempSync(join(tmpdir(),'local-sync-checkpoint-')),root=join(fixture,'connector'),id='fixture-job',dir=join(root,'sync-jobs',id);
 const statePath=join(dir,'state.json'),target={id:'fixture',handle:'fixture',profile:'local:fixture'};
 mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'input.json'),JSON.stringify({target,knownNotes:[]}));
 writeFileSync(statePath,JSON.stringify({status:'running',stage:'account',checkpoint:false}));
 vi.stubEnv('LOCAL_CONNECTOR_ROOT',root);
 vi.doMock('../../../scripts/xhs-playwright.mjs',()=>({collectWithPlaywright:async({onProgress,onCheckpoint})=>{
  await onProgress({stage:'notes',message:'fixture notes'});
  mkdirSync(statePath+'.tmp');
  try{await onCheckpoint({account:target,notes:[{id:'fixture-note',title:'saved note'}],comments:[],messages:[]});}
  finally{rmSync(statePath+'.tmp',{recursive:true,force:true});}
  throw Error('unexpected successful checkpoint receipt');
 }}));
 vi.doMock('../../../scripts/xhs-media.mjs',()=>({archiveMedia:async()=>{throw Error('unexpected media collection');}}));
 const argv=process.argv;process.argv=[argv[0],argv[1],id];
 try{
  await expect(import('../../../local-connector/sync-worker.mjs')).resolves.toBeDefined();
  expect(JSON.parse(readFileSync(statePath,'utf8'))).toMatchObject({status:'blocked',stage:'blocked',errorStage:'notes',checkpoint:true,message:expect.stringContaining('state.json.tmp')});
  expect(JSON.parse(readFileSync(join(dir,'result.json'),'utf8'))).toEqual({account:{id:'fixture',handle:'fixture',profile:'local:fixture'},notes:[{id:'fixture-note',title:'saved note'}],comments:[],messages:[]});
 }finally{process.argv=argv;rmSync(fixture,{recursive:true,force:true});}
});

test('the local worker reports blocked when media collection catches a progress persistence failure',async()=>{
 const fixture=mkdtempSync(join(tmpdir(),'local-sync-media-failure-')),root=join(fixture,'connector'),id='fixture-job',dir=join(root,'sync-jobs',id);
 const statePath=join(dir,'state.json'),target={id:'fixture',handle:'fixture',profile:'local:fixture'};
 mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'input.json'),JSON.stringify({target,knownNotes:[]}));
 writeFileSync(statePath,JSON.stringify({status:'running',stage:'account',checkpoint:false}));
 vi.stubEnv('LOCAL_CONNECTOR_ROOT',root);
 vi.doMock('../../../scripts/xhs-playwright.mjs',()=>({collectWithPlaywright:async({onProgress})=>{
  await onProgress({stage:'notes',message:'fixture notes'});
  return {account:target,notes:[{id:'fixture-note',title:'saved note'}],comments:[],messages:[],browser:{close:async()=>{}},context:{}};
 }}));
 vi.doMock('../../../scripts/xhs-media.mjs',()=>({archiveMedia:async({onProgress})=>{
  mkdirSync(statePath+'.tmp');
  try{await onProgress({total:1,finished:1,saved:1});}
  finally{rmSync(statePath+'.tmp',{recursive:true,force:true});}
  return {total:1,saved:1,failed:0,cached:0};
 }}));
 const argv=process.argv;process.argv=[argv[0],argv[1],id];
 try{
  await expect(import('../../../local-connector/sync-worker.mjs')).resolves.toBeDefined();
  expect(JSON.parse(readFileSync(statePath,'utf8'))).toMatchObject({status:'blocked',stage:'blocked',errorStage:'media',checkpoint:true,message:expect.stringContaining('state.json.tmp')});
  expect(JSON.parse(readFileSync(join(dir,'result.json'),'utf8'))).toEqual({account:{id:'fixture',handle:'fixture',profile:'local:fixture'},notes:[{id:'fixture-note',title:'saved note'}],comments:[],messages:[]});
 }finally{process.argv=argv;rmSync(fixture,{recursive:true,force:true});}
});

test('the local worker reports blocked when collection catches a checkpoint persistence failure',async()=>{
 const fixture=mkdtempSync(join(tmpdir(),'local-sync-caught-checkpoint-')),root=join(fixture,'connector'),id='fixture-job',dir=join(root,'sync-jobs',id);
 const statePath=join(dir,'state.json'),target={id:'fixture',handle:'fixture',profile:'local:fixture'};
 mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'input.json'),JSON.stringify({target,knownNotes:[]}));
 writeFileSync(statePath,JSON.stringify({status:'running',stage:'account',checkpoint:false}));
 vi.stubEnv('LOCAL_CONNECTOR_ROOT',root);
 vi.doMock('../../../scripts/xhs-playwright.mjs',()=>({collectWithPlaywright:async({onProgress,onCheckpoint})=>{
  await onProgress({stage:'notes',message:'fixture notes'});
  mkdirSync(statePath+'.tmp');
  try{await onCheckpoint({account:target,notes:[{id:'fixture-note',title:'saved note'}],comments:[],messages:[]});}
  catch{}
  finally{rmSync(statePath+'.tmp',{recursive:true,force:true});}
  return {account:target,notes:[{id:'fixture-note',title:'saved note'},{id:'later-note',title:'later note'}],comments:[],messages:[],browser:{close:async()=>{}},context:{}};
 }}));
 vi.doMock('../../../scripts/xhs-media.mjs',()=>({archiveMedia:async()=>({total:0,saved:0,failed:0,cached:0})}));
 const argv=process.argv;process.argv=[argv[0],argv[1],id];
 try{
  await expect(import('../../../local-connector/sync-worker.mjs')).resolves.toBeDefined();
  expect(JSON.parse(readFileSync(statePath,'utf8'))).toMatchObject({status:'blocked',stage:'blocked',errorStage:'notes',checkpoint:true,message:expect.stringContaining('state.json.tmp')});
  expect(JSON.parse(readFileSync(join(dir,'result.json'),'utf8'))).toEqual({account:{id:'fixture',handle:'fixture',profile:'local:fixture'},notes:[{id:'fixture-note',title:'saved note'}],comments:[],messages:[]});
 }finally{process.argv=argv;rmSync(fixture,{recursive:true,force:true});}
});
