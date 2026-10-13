import {it,expect,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {uploadWithPreview,classifyTiming} from '../../scripts/studio-upload.mjs';
import {uploadLocalFiles,focusExistingCreator} from '../../scripts/studio-browser.mjs';
import {downloadImages} from '../../scripts/studio-media.mjs';
import {acquireProfileLock} from '../../scripts/studio-lock.mjs';
import {inspectDraftList} from '../../scripts/studio-draft.mjs';
import {saveAndConfirmDraft} from '../../scripts/studio-draft-flow.mjs';
import {waitForSignal} from '../../scripts/studio-wait.mjs';

const empty={editor:false,imageCount:0,pendingImageCount:0};
const ready={editor:true,imageCount:1};
it('executor entry point parses as the Node process that the button launches',()=>{
 expect(()=>execFileSync(process.execPath,['--check','scripts/studio-executor.mjs'])).not.toThrow();
});
it('foregrounding selects the already-bound creator URL and propagates activation failure',async()=>{
 const url='https://creator.xiaohongshu.com/publish/publish?from=menu_left&target=image';
 const page={evaluate:vi.fn(async()=>{throw Error('Hidden page is suspended');}),tabs:async()=>[{page:'creator',url}],getActivePage:()=> 'creator',cdp:vi.fn(),newTab:vi.fn()};
 const run=vi.fn(async()=>{});
 await focusExistingCreator(page,{platform:'darwin',run});
 expect(run).toHaveBeenCalledWith('/usr/bin/osascript',['-e',expect.any(String),url],expect.objectContaining({timeout:5000}));
 expect(page.newTab).not.toHaveBeenCalled();
 expect(page.evaluate).not.toHaveBeenCalled();
 run.mockRejectedValueOnce(Error('Expected exactly one existing creator tab'));
 await expect(focusExistingCreator(page,{platform:'darwin',run})).rejects.toThrow('exactly one');
});
it('foregrounding refuses a page outside the image creator before controlling Chrome',async()=>{
 const run=vi.fn();
 await expect(focusExistingCreator({tabs:async()=>[{page:'other',url:'https://example.com/'}],getActivePage:()=> 'other'},{platform:'darwin',run})).rejects.toThrow('图文创作页');
 expect(run).not.toHaveBeenCalled();
});
it('native delayed previews are waited for without a second upload',async()=>{
 const fallbackUpload=vi.fn(),waitForEditor=vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(ready);
 const result=await uploadWithPreview({nativeUpload:async()=>{},fallbackUpload,waitForEditor,expected:1});
 expect(result.transport).toBe('cdp');expect(fallbackUpload).not.toHaveBeenCalled();
 expect(waitForEditor.mock.calls).toEqual([[5000],[15000]]);
});
it('unsupported upload checks for partial images immediately before falling back',async()=>{
 let clock=0;const order=[];
 const fallbackUpload=vi.fn(async()=>{order.push('transfer');clock+=100;});
 const waitForEditor=vi.fn(async ms=>{order.push('read:'+ms);if(ms===0){clock+=2;return empty;}clock+=30;return ready;});
 const result=await uploadWithPreview({expected:1,now:()=>clock,nativeUpload:async()=>{clock+=10;throw Error('Unknown action cdp');},fallbackUpload,waitForEditor});
 expect(order).toEqual(['read:0','transfer','read:15000']);
 expect(result.timing).toEqual({upload:110,preview:32});
});
it('the extension rejecting direct file CDP uses the existing DataTransfer compatibility path',async()=>{
 const fallbackUpload=vi.fn();const result=await uploadWithPreview({expected:1,nativeUpload:async()=>{throw Error('CDP method not permitted: DOM.setFileInputFiles');},fallbackUpload,waitForEditor:vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(ready)});
 expect(result.transport).toBe('data-transfer');expect(fallbackUpload).toHaveBeenCalledTimes(1);
});
it.each([12001,15000,18001])('a %i ms run is over the 12 second budget, never acceptable variance',elapsed=>{
 expect(classifyTiming(elapsed)).toMatchObject({class:'over-budget',targetMs:12000});
});
it.each([undefined,NaN,Infinity,-1])('invalid elapsed time cannot pass the speed gate: %s',elapsed=>{
 expect(classifyTiming(elapsed).class).toBe('unmeasured');
});
it('a measured 12 second run meets its own target only',()=>expect(classifyTiming(12000).class).toBe('target'));
it.each(['command_result_unknown','Page.fileChooserOpened not received','Connection lost','图片上传控件数量异常'])('does not repeat upload on unknown outcome: %s',async message=>{
 const fallbackUpload=vi.fn();await expect(uploadWithPreview({expected:1,nativeUpload:async()=>{throw Error(message);},fallbackUpload,waitForEditor:vi.fn()})).rejects.toThrow(message);
 expect(fallbackUpload).not.toHaveBeenCalled();
});
it('an unknown-outcome error code overrides an apparently unsupported error message',async()=>{
 const error=Object.assign(Error('method not supported'),{code:'COMMAND_RESULT_UNKNOWN'});
 const fallbackUpload=vi.fn();
 await expect(uploadWithPreview({expected:1,nativeUpload:async()=>{throw error;},fallbackUpload,waitForEditor:async()=>empty})).rejects.toThrow('method not supported');
 expect(fallbackUpload).not.toHaveBeenCalled();
});
it.each([{editor:true,imageCount:1,pendingImageCount:1},{editor:false,imageCount:0,pendingImageCount:1}])('partial images are preserved before any fallback (%j)',async actual=>{
 const fallbackUpload=vi.fn();await expect(uploadWithPreview({expected:2,nativeUpload:async()=>{throw Error('not supported');},fallbackUpload,waitForEditor:async()=>actual})).rejects.toThrow('部分内容');expect(fallbackUpload).not.toHaveBeenCalled();
});
it('no preview after a successful native command cannot become success or trigger fallback',async()=>{
 const fallbackUpload=vi.fn();await expect(uploadWithPreview({expected:1,nativeUpload:async()=>{},fallbackUpload,waitForEditor:async()=>empty})).rejects.toThrow('图片预览未完成');expect(fallbackUpload).not.toHaveBeenCalled();
});
it('direct CDP binds to exactly one file input and preserves file order',async()=>{
 const cdp=vi.fn(async method=>method==='DOM.getDocument'?{root:{nodeId:1}}:method==='DOM.querySelectorAll'?{nodeIds:[5]}:{});
 await uploadLocalFiles({cdp},['/tmp/first.jpg','/tmp/second.png']);
 expect(cdp).toHaveBeenLastCalledWith('DOM.setFileInputFiles',{files:['/tmp/first.jpg','/tmp/second.png'],nodeId:5});
 cdp.mockImplementation(async method=>method==='DOM.getDocument'?{root:{nodeId:1}}:{nodeIds:[5,6]});
 await expect(uploadLocalFiles({cdp},['/tmp/a.jpg'])).rejects.toThrow('数量异常');
});
it('parallel downloads preserve original bytes and task order despite reverse completion',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'studio-media-'));const bytes=[Buffer.from([255,216,255,1]),Buffer.from([137,80,78,71,13,10,26,10,2])];
 const pending=[];const fetcher=vi.fn(()=>new Promise(resolve=>pending.push(resolve)));
 try{const result=downloadImages(['https://example.com/1','https://example.com/2'],dir,fetcher);
 await vi.waitFor(()=>expect(pending).toHaveLength(2));
 pending[1]({ok:true,arrayBuffer:async()=>bytes[1]});pending[0]({ok:true,arrayBuffer:async()=>bytes[0]});
 const files=await result;expect(files.map(f=>f.name)).toEqual(['1.jpg','2.png']);
 expect(await readFile(files[0].path)).toEqual(bytes[0]);expect(await readFile(files[1].path)).toEqual(bytes[1]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('one profile cannot run two executors and a released profile can be reused',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'studio-lock-'));
 try{const release=await acquireProfileLock(dir,'chrome1','a');await expect(acquireProfileLock(dir,'chrome1','b')).rejects.toThrow('正在同步');await release();await (await acquireProfileLock(dir,'chrome1','b'))();}finally{await rm(dir,{recursive:true,force:true});}
});
it('draft evidence excludes matching titles in the editor and outside the draft list',()=>{
 document.body.innerHTML='<p>标题</p><div class="draft-drawer"><p>标题</p><div class="draft-list"><div class="draft-item" data-draft-id="one" data-draft-type="image"><span class="draft-title-text">标题</span></div></div></div>';
 document.body.innerText='标题';
 for(const e of document.querySelectorAll('*'))e.getBoundingClientRect=()=>({width:10,height:10});
 expect(inspectDraftList('标题').matches).toBe(1);
 document.querySelector('.draft-list').innerHTML='';expect(inspectDraftList('标题').matches).toBe(0);
});
it('a matching label inside the drawer is not a saved draft row',()=>{
 document.body.innerHTML='<div class="draft-drawer"><div class="draft-list"><span>标题</span><div class="draft-item" data-draft-id="video" data-draft-type="video"><span class="draft-title-text">标题</span></div></div></div>';
 for(const e of document.querySelectorAll('*'))e.getBoundingClientRect=()=>({width:10,height:10});
 expect(inspectDraftList('标题').matches).toBe(0);
});
it('save confirmation requires persistence and the visible row even after a transient toast disappears',async()=>{
 vi.useFakeTimers();try{let inspected=0,stored=0;const evaluate=vi.fn(async source=>{
  if(source.includes('function readPersistedImageDraft'))return ++stored===1?{available:true,matches:0}:{available:true,matches:1};
  if(source.includes('function inspectDraftList'))return ++inspected===1?{saved:true,drawer:false,matches:0}:{saved:false,drawer:true,matches:1};
  return true;
 });
 const result=saveAndConfirmDraft(evaluate,'标题');await vi.advanceTimersByTimeAsync(200);expect(await result).toMatchObject({saved:true,matches:1,sawSaved:true});expect(evaluate.mock.calls.filter(([s])=>s.startsWith('(function saveDraft'))).toHaveLength(1);
 }finally{vi.useRealTimers();}
});
it('missing draft row is never successful even if persistence and the save toast appeared',async()=>{
 vi.useFakeTimers();try{let stored=0;const evaluate=async source=>source.includes('function readPersistedImageDraft')?{available:true,matches:++stored===1?0:1}:source.includes('function inspectDraftList')?{saved:true,drawer:true,matches:0}:true;const result=saveAndConfirmDraft(evaluate,'标题');await vi.advanceTimersByTimeAsync(20200);expect(await result).toMatchObject({saved:false,matches:0});}finally{vi.useRealTimers();}
});
it('signal waits run locally with immediate browser reads and a bounded deadline',async()=>{
 let time=0;const read=vi.fn(async()=>({ready:time>=300}));
 const result=await waitForSignal(read,s=>s.ready,{now:()=>time,sleep:async ms=>{time+=ms;},timeout:500,interval:150});
 expect(result.ready).toBe(true);expect(time).toBe(300);expect(read).toHaveBeenCalledTimes(3);
});
it('generic CDP rejection cannot retry the incompatible chooser-based native method',async()=>{
 const setFileInput=vi.fn(async()=>{throw Error('Page.fileChooserOpened not received within 5s');});
 const cdp=async method=>{if(method==='DOM.getDocument')return {root:{nodeId:1}};if(method==='DOM.querySelectorAll')return {nodeIds:[5]};if(method==='DOM.setFileInputFiles')throw Error('CDP method not permitted: DOM.setFileInputFiles');return {};};
 await expect(uploadLocalFiles({cdp,setFileInput},['/tmp/first.jpg'])).rejects.toThrow('CDP method not permitted');
 expect(setFileInput).not.toHaveBeenCalled();
});
