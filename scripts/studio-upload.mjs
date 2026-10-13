export function nativeUploadCount(result) {
 if (!result || result.uploaded !== true) return 0;
 const count=Number(result.files);
 return Number.isFinite(count) ? count : 0;
}

export function shouldFallbackNative(error) {
 const text=`${error?.code??''} ${error?.message||error||''}`.toLowerCase();
 // Only a definitive unsupported command is safe to replace. A timeout,
 // detached target or lost response may already have uploaded the images.
 if(/timeout|timed out|超时|unknown outcome|result_unknown|command_lost|connection|disconnected|chooser|deadline/.test(text))return false;
 return /not supported|unsupported|unknown (action|method)|method.*(not found|wasn't found)|wasn't found|not allowed|cdp method not permitted: dom\.setfileinputfiles/.test(text);
}

export async function uploadWithPreview({nativeUpload,fallbackUpload,waitForEditor,expected,onPhase=async()=>{},onEvent=()=>{},timing={upload:0,preview:0},now=Date.now}) {
 let nativeError;let transport='cdp';
 const timed=async(key,fn)=>{const start=now();try{return await fn();}finally{timing[key]+=now()-start;}};
 await onPhase('upload','正在上传原始图片');
 try {await timed('upload',nativeUpload);} catch(error){nativeError=error;}
 onEvent({stage:'native-result',ok:!nativeError,error:nativeError?safeExecutionError(nativeError):undefined});
 if(nativeError&&!shouldFallbackNative(nativeError))throw nativeError;
 await onPhase('preview','正在核对小红书图片预览');
 // Skip the five-second delay on a definitive capability rejection, but keep
 // an immediate DOM read: a partial upload must never be injected a second time.
 let actual=await timed('preview',()=>waitForEditor(nativeError?0:5000));
 const ready=()=>actual?.editor&&actual.imageCount===expected;
 if(!ready()) {
  if(nativeError) {
   if(!actual)throw Error('无法确认原生上传后的页面状态，已停止重复传图');
   if(actual.editor||actual.imageCount||actual.pendingImageCount)throw Error('页面已有部分内容，已停止重复传图，请检查当前创作页');
   transport='data-transfer';
   await onPhase('upload','浏览器不支持直接上传，正在兼容传图');
   await timed('upload',fallbackUpload);
  }
  await onPhase('preview','正在等待图片上传完成');
  actual=await timed('preview',()=>waitForEditor(15000));
 }
 if(!ready())throw Error(`图片预览未完成：要求 ${expected}，实际 ${actual?.imageCount??0}；保留现有页面，未重复上传`);
 return {actual,timing,transport,nativeError:nativeError?.message};
}

export function classifyTiming(totalMs){
 if(!Number.isFinite(totalMs)||totalMs<0)return {class:'unmeasured',targetMs:12000};
 if(totalMs<=12000)return {class:'target',targetMs:12000};
 return {class:'over-budget',targetMs:12000};
}

export function safeExecutionError(error) {
 return String(error?.message??error??'未知错误').replace(/\x1b\[[0-9;]*m/g,'')
  .replace(/[A-Za-z0-9+/=]{160,}/g,'[大段传输内容已省略]').slice(0,1200);
}

export function timingMessage(timing) {
 return `草稿核对前耗时 ${timing.total}ms（页面/启动 ${timing.page}ms，下载 ${timing.download}ms，上传 ${timing.upload}ms，预览 ${timing.preview}ms，填充 ${timing.fill}ms，保存 ${timing.save}ms）`;
}
