#!/usr/bin/env node
import {protectStudioConnection} from './studio-safety.mjs';
import {executionGuard} from './execution-guard.mjs';
import {createActionPacer} from './action-pacing.mjs';
import {readIdentity} from '../local-connector/identity.mjs';
import {readFile, mkdir, writeFile,rm,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {projectPath} from './runtime-path.mjs';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {fillNativeTopics} from './studio-topics.mjs';
import {readEditor, fillEditor, verifyEditor, readTitlePreview} from './studio-page.mjs';
import {connectStudioBrowser, uploadLocalFiles} from './studio-browser.mjs';
import {downloadImages} from './studio-media.mjs';
import {uploadWithPreview, timingMessage, safeExecutionError, classifyTiming} from './studio-upload.mjs';
import {readPersistedImageDraft,verifyPersistedDraft,uploadedDraftFileIds} from './studio-persisted-draft.mjs';
import {inspectBeforeUpload, saveAndConfirmDraft,confirmVisibleDraft} from './studio-draft-flow.mjs';
import {waitForSignal} from './studio-wait.mjs';
import {acquireProfileLock} from './studio-lock.mjs';
import {clickDraftButton} from './studio-save-button.mjs';
import {waitForCreator,prepareImageCreator} from './prepare-studio-page.mjs';

const base = process.env.STUDIO_URL ?? 'http://127.0.0.1:4174';
const token = process.env.STUDIO_TOKEN;
const profile = process.env.MATRIX_PROFILE;
const taskId = process.argv[2];
const cli = process.env.BROWSER_BRIDGE_NODE;
if (!token || !profile || !taskId) throw Error('需要 STUDIO_TOKEN、MATRIX_PROFILE 和任务 ID');
const evidenceDir = join(process.env.DATA_DIR ?? projectPath('work','grey'), 'studio-executions');
const lockDir = join(process.env.DATA_DIR ?? projectPath('work','grey'), 'studio-locks');
const dispatchedAt = Date.parse(process.env.STUDIO_STARTED_AT ?? '');
const startedAt = Number.isFinite(dispatchedAt) ? dispatchedAt : Date.now();
const timing = {page:0, download:0, upload:0, preview:0, fill:0, save:0};
const evidence = {taskId, runId:process.env.STUDIO_RUN_ID||randomUUID(), startedAt:new Date(startedAt).toISOString(), timing, events:[]};
const guard=executionGuard(process.env.LOCAL_CONNECTOR_ROOT??projectPath('work','grey','local-connector'),profile),pace=createActionPacer();
let downloadDirectory,connection, release, task, revision, claimed = false, uploadAttempted = false, stage = 'page';

async function api(path, body) {
 const response = await fetch(base + '/api/' + path, {
  method: body ? 'POST' : 'GET',
  headers: {Authorization:'Bearer ' + token, 'Content-Type':'application/json'},
  body: body ? JSON.stringify(body) : undefined,
  signal: AbortSignal.timeout(15000)
 });
 if (!response.headers.get('content-type')?.includes('application/json')) throw Error(`工作台接口 ${path.split('/').at(-1)} 未就绪（HTTP ${response.status}），请检查服务版本`);
 const value = await response.json();
 if (!response.ok) throw Error(value.message ?? `HTTP ${response.status}`);
 return value;
}
async function writeEvidence() {
 await mkdir(evidenceDir, {recursive:true});
 await writeFile(join(evidenceDir, `${taskId}.json`), JSON.stringify(evidence, null, 2), {mode:0o600});
 await writeFile(join(evidenceDir, `${taskId}-${evidence.runId}.json`), JSON.stringify(evidence, null, 2), {mode:0o600});
}
async function progress(nextStage, message) {
 guard.check();await pace();guard.check();
 stage = nextStage;
 evidence.events.push({stage, elapsedMs:Date.now()-startedAt, message});
 await writeEvidence();
 if (claimed) {
  const updated = await api(`studio/${taskId}/progress`, {revision, message:`${message}（已用时 ${((Date.now()-startedAt)/1000).toFixed(1)} 秒）`});
  revision = updated.revision;
 }
}
// Both the initial and final checks read the visible account header.
function readAccount() {
 return document.querySelector('#header-area, .header-area, header, [class*=header-area]')?.innerText?.split('\n').map(s=>s.trim()).filter(s=>s && s!=='创作服务平台').join(' ') || '';
}

try {
 task = await api('studio/' + taskId);
 if (task.status !== 'approved') throw Error('任务尚未审核通过');
 const claim = await api(`studio/${task.id}/claim`, {revision:task.revision, profile,runId:evidence.runId});
 claimed = true;
 revision = claim.revision;
 release = await acquireProfileLock(lockDir, profile, task.id);
 await progress('page', '正在连接当前 Chrome 并核对账号');
 const operations = await api('operations');
 const target = operations.accounts.find(account=>account.id===task.accountId);
 if (!target) throw Error('目标账号未同步到当前工作区');
 connection = await connectStudioBrowser({cli, profile});
 await protectStudioConnection(connection,guard,pace);
 const {page, evaluate} = connection;
 if(profile.startsWith('local:')){
  const homeTabs=await page.tabs();
  const home=homeTabs.find(t=>/^https:\/\/creator\.xiaohongshu\.com\/(new\/home|home)/.test(t.url));
  await page.selectTab(home?.page??await page.newTab('https://creator.xiaohongshu.com/new/home'));
  await connection.foreground();
  const identity=await waitForCreator(()=>evaluate(`(${readIdentity.toString()})()`),v=>v.loggedIn&&v.handle,{timeout:45000});
  if(!identity.loggedIn||identity.handle!==target.handle)throw Error(`本机实际账号 ${identity.handle||'未读取'} 与目标 ${target.handle} 不一致，请先扫码连接此账号`);
  evidence.handle=identity.handle;
 }
 const tab = await prepareImageCreator(connection);
 evidence.page = tab;
 await connection.foreground();
 const initial = await waitForCreator(()=>evaluate(`(()=>({name:(${readAccount.toString()})(),...(${readEditor.toString()})(),visible:!document.hidden,input:!!document.querySelector('input[type="file"][multiple][accept*=".jpg"]')}))()`),state=>state.visible&&state.name&&(state.input||state.editor),{timeout:45000});
 evidence.initialPage=initial;
 const name = initial.name;
 if (!name) throw Error('未能从创作页识别登录账号，已停止上传');
 if (name.trim().toLowerCase() !== String(target.name).trim().toLowerCase()) throw Error(`浏览器当前账号 ${name} 与任务目标 ${target.name} 不一致`);
 if (initial.editor || initial.imageCount || initial.pendingImageCount) throw Error('当前创作页已有未保存内容，已保留原页面；请核对后再同步');
 if (!initial.input) throw Error('当前页面缺少图片上传控件');
 if (!initial.visible) throw Error('Chrome 创作页未能切到前台，已停止上传以保持操作可见');
 evidence.account = name;
 const stored=await evaluate(`(${readPersistedImageDraft.toString()})(${JSON.stringify(task.title)})`);
 const manifestPath=join(evidenceDir,task.id+'.approved.json');
 const fingerprint=createHash('sha256').update(JSON.stringify({profile,title:task.title,body:task.body,tags:task.tags,images:task.images})).digest('hex');
 let manifest;try{manifest=JSON.parse(await readFile(manifestPath,'utf8'));}catch{}
 let readback;
 if(stored.matches){
  if(manifest?.fingerprint!==fingerprint)throw Error('已有同名草稿缺少本次审核的图片回读凭据，请检查现有草稿，不会重复上传');
  readback=verifyPersistedDraft(stored,task,manifest.fileIds,{requireNativeTopics:true});
  if(!readback)throw Error('已有同名草稿无法唯一确认，已停止重复上传');
  const visible=await confirmVisibleDraft(evaluate,task.title);
  if(!visible.drawer||visible.matches!==1||!visible.draftIds.includes(readback.draftId))throw Error('草稿已存储，但平台列表未能显示，请人工核对');
  evidence.persisted=readback;evidence.draft={...visible,saved:true,recovered:true};evidence.readback=readback;
 }else{
 // A prior uncertain run may already be saved; prevent a duplicate before upload.
 await inspectBeforeUpload(evaluate,task.title);

 await progress('download', '正在下载审核稿原始图片');
 const downloadStart = Date.now();
 const mediaPrefix=base+'/api/studio/'+task.id+'/media/';
 const urls=task.images.map(url=>/^\/api\/templates\/media\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(url)?mediaPrefix+url.split('/').at(-1):url);
 const cache=join(process.env.LOCAL_CONNECTOR_ROOT??join(tmpdir(),'matrix-connector'),'generated-cache');await mkdir(cache,{recursive:true,mode:0o700});downloadDirectory=await mkdtemp(join(cache,'draft-'));
 const files = await downloadImages(urls,downloadDirectory,(url,options)=>fetch(url,{...options,...(String(url).startsWith(mediaPrefix)?{headers:{Authorization:'Bearer '+token}}:{})}));
 timing.download = Date.now()-downloadStart;
 evidence.files = files.map(({name, mime, bytes})=>({name, mime, bytes}));
 const waitForEditor = timeout=>waitForSignal(()=>evaluate(`(${readEditor.toString()})()`),actual=>actual.editor&&actual.imageCount===task.images.length,{timeout});
 const upload = await uploadWithPreview({
  expected:task.images.length, waitForEditor, onPhase:progress, timing,
  onEvent:event=>evidence.events.push({elapsedMs:Date.now()-startedAt, ...event}),
  nativeUpload:()=>{uploadAttempted=true;return uploadLocalFiles(page, files.map(file=>file.path));},
  fallbackUpload:async()=>{
   uploadAttempted=true;
   const payload = await Promise.all(files.map(async file=>({name:file.name, mime:file.mime, data:(await readFile(file.path)).toString('base64')})));
   // Keep DataTransfer + File + change and original bytes. Four verified 12 KB
   // chunks share one bridge request without changing their assembly checks.
   await evaluate(`((items)=>{const input=[...document.querySelectorAll('input[type="file"][multiple]')].find(e=>/\.jpg|\.jpeg|\.png|\.webp/i.test(e.accept));if(!input)throw Error('未找到图片上传控件');const dt=new DataTransfer();for(const item of items){const bytes=Uint8Array.from(atob(item.data),c=>c.charCodeAt(0));dt.items.add(new File([bytes],item.name,{type:item.mime}));}input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return {submitted:items.length};})(${JSON.stringify(payload)})`);
  }
 });
 evidence.transport = upload.transport;
 evidence.imageCount = upload.actual.imageCount;
 await progress('fill', '图片已就绪，正在填充并回读标题、正文和标签');
 const fillStart = Date.now();
 await evaluate(`(${fillEditor.toString()})(${JSON.stringify({title:task.title, body:task.body, tags:[]})})`);
 evidence.topics=await fillNativeTopics(connection,task.tags);
 // Native insertText emits the same input event as typing. DOM setters alone
 // can look correct while the site's draft model still contains an empty title.
 await evaluate(`(()=>{const title=document.querySelector('#web input[placeholder*="标题"]');title.focus();title.select();return true;})()`);
 await page.insertText(task.title);
 const titleReady=await waitForSignal(()=>evaluate(`(${readTitlePreview.toString()})(${JSON.stringify(task.title)})`),Boolean,{timeout:5000});
 if(!titleReady)throw Error('标题尚未同步到小红书预览，已保留编辑器，未保存空标题草稿');
 readback = verifyEditor(await evaluate(`(${readEditor.toString()})()`), task);
 timing.fill = Date.now()-fillStart;
 evidence.readback = readback;
 const fileIds=await evaluate(`(${uploadedDraftFileIds.toString()})()`);
 manifest={fingerprint,fileIds};await writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});
 await progress('save', '内容回读一致，正在保存并核对草稿箱');
 const saveStart = Date.now();
 const saved = await saveAndConfirmDraft(evaluate,task.title,{save:()=>clickDraftButton(page),acceptExisting:s=>!!verifyPersistedDraft(s,task,manifest.fileIds,{requireNativeTopics:true}),showDrafts:async s=>{if(!verifyPersistedDraft(s,task,manifest.fileIds,{requireNativeTopics:true}))throw Error('草稿尚未持久化');if((await evaluate(`(${readEditor.toString()})()`)).editor){await page.selectTab(await page.newTab('https://creator.xiaohongshu.com/publish/publish?target=image'));const ready=await waitForSignal(()=>evaluate(`location.origin==='https://creator.xiaohongshu.com'&&!!document.querySelector('#web')`).catch(()=>false),Boolean,{timeout:15000});if(!ready)throw Error('草稿箱页面未就绪');}}});
 timing.save = Date.now()-saveStart;
 evidence.persisted=verifyPersistedDraft(saved.persisted,task,manifest.fileIds,{requireNativeTopics:true});
 if (!evidence.persisted)throw Error('草稿持久化内容与审核稿不一致');
 if (!saved.saved || !saved.drawer || saved.matches!==1) throw Error('未得到保存成功提示和草稿箱唯一条目确认；请检查草稿箱，勿直接重复上传');
 evidence.draft = saved;
 }
 const final = await evaluate(`(()=>({name:(${readAccount.toString()})(),url:location.href}))()`);
 if (final.name !== name || !final.url.startsWith('https://creator.xiaohongshu.com/publish/publish')) throw Error('保存后账号或创作页发生变化，请检查草稿箱');
 timing.total = Date.now()-startedAt;
 timing.page = timing.total-timing.download-timing.upload-timing.preview-timing.fill-timing.save;
 const receipt = await api(`studio/${task.id}/receipt`, {revision, status:'filled', accountId:task.accountId, title:readback.title, body:readback.body, tags:readback.tags, imageCount:readback.imageCount, runId:evidence.runId,draftId:evidence.persisted?.draftId,message:`已核对账号 ${name}、图片和正文，并确认平台草稿持久化内容与草稿箱唯一条目一致。草稿位于执行电脑上该账号专属浏览器的图文草稿箱，手机和其他浏览器不会自动同步。请检查后由人工点击发布。${timingMessage(timing)}`});
 evidence.executionElapsedMs = receipt.executionElapsedMs;
 evidence.requestToReceiptMs = Date.now()-startedAt;
 evidence.performance = classifyTiming(receipt.executionElapsedMs);
 evidence.status = 'filled';
 evidence.finishedAt = new Date().toISOString();
 console.log(JSON.stringify({ok:true, taskId:task.id, timing, transport:evidence.transport}));
} catch (error) {
 const labels = {page:'连接/页面检查', download:'素材下载', upload:'图片上传', preview:'图片预览', fill:'内容填充核对', save:'草稿保存核对'};
 const message = `${labels[stage]}失败：${safeExecutionError(error)}`;
 evidence.status = 'blocked';
 evidence.error = message;
 evidence.elapsedMs = Date.now()-startedAt;
 if (claimed) {
  const current = await api('studio/' + taskId).catch(()=>null);
  if (current?.status==='filling') await api(`studio/${taskId}/receipt`, {revision:current.revision, status:'blocked', message,runId:evidence.runId,retrySafe:!uploadAttempted&&['page','download'].includes(stage)}).catch(()=>{});
 }
 console.error(message);
 process.exitCode = 1;
} finally {
 await connection?.close().catch(()=>{});
 if(downloadDirectory)await rm(downloadDirectory,{recursive:true,force:true}).catch(()=>{});
 await release?.().catch(()=>{});
 await writeEvidence();
}
