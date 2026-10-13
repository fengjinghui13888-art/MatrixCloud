import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {projectPath} from './runtime-path.mjs';
import {createInterface} from 'node:readline';
export async function archiveMedia({notes,accountId,root,context,onProgress,availableAssets=[]}){
 const python=process.env.COLLECTOR_PYTHON||projectPath('work','collector-venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
 const items=[];
 for(const n of notes){const date=n.publishedAt?.match(/^\d{4}-\d{2}-\d{2}/)?.[0]||'unknown-date';
  if(n.mediaType!=='video')for(const [index,url]of(n.images??[]).entries())items.push({noteId:n.id,date,kind:'image',url,index});
  if(n.cover&&(n.mediaType==='video'||!n.images?.includes(n.cover)))items.push({noteId:n.id,date,kind:'cover',url:n.cover,index:0});
  if(n.videoUrl)items.push({noteId:n.id,date,kind:'video',url:n.videoUrl,index:0});
 }
 const available=new Set(availableAssets);
 const cachedItems=items.filter(i=>notes.find(n=>n.id===i.noteId)?.mediaAssets?.some(a=>available.has(i.noteId+':'+a.id)&&a.kind===i.kind&&a.index===i.index&&a.sourceUrl===i.url));
 const missing=items.filter(i=>!cachedItems.includes(i));
 if(!missing.length)return {total:items.length,saved:0,cached:cachedItems.length,failed:0,errors:[]};
 if(!existsSync(python))throw Error('媒体下载环境未安装，请运行 scripts/setup-collector.py');
 const bounded=async task=>{let timer;try{return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('读取浏览器下载授权超时，请重新同步')),10000);})]);}finally{clearTimeout(timer);}};
 const cookies=await bounded(context.cookies());const userAgent='Mozilla/5.0';
 const results=[];const child=spawn(python,[projectPath('scripts','xhs_media_download.py')],{stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',x=>{stderr=(stderr+x).slice(-1000);});
 let progress=Promise.resolve();let protocolError;
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{try{const r=JSON.parse(line);results.push(r);const status={total:items.length,finished:results.length,saved:results.filter(x=>x.status!=='failed').length};progress=progress.then(()=>onProgress?.(status));}catch{protocolError='下载器返回了无效结果';}});
 const result=new Promise((resolve,reject)=>{child.once('error',()=>reject(Error('无法启动 Python 媒体下载器')));child.once('exit',code=>code===0?resolve():reject(Error('媒体下载器退出：'+code+(stderr.includes('ModuleNotFoundError')?'（缺少 requests 依赖）':''))));});
 const abort=()=>child.kill('SIGTERM');process.once('SIGTERM',abort);process.once('SIGINT',abort);
 child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({root,accountId,cookies,userAgent,items:missing}));
 try{await result;await progress;if(protocolError)throw Error(protocolError);}
 finally{process.off('SIGTERM',abort);process.off('SIGINT',abort);lines.close();}
 for(const note of notes){const assets=results.filter(r=>r.noteId===note.id&&r.asset).map(r=>r.asset);if(assets.length)note.mediaAssets=[...(note.mediaAssets||[]).filter(old=>!assets.some(a=>a.kind===old.kind&&a.index===old.index)),...assets].sort((a,b)=>a.index-b.index);}
 return {total:items.length,saved:results.filter(r=>r.status==='saved').length,cached:cachedItems.length+results.filter(r=>r.status==='cached').length,failed:results.filter(r=>r.status==='failed').length,errors:results.filter(r=>r.status==='failed')};
}
