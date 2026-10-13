// Observe completed business responses only. Never persist login tokens or telemetry.
export function captureNetwork(context,onRecord,{onHalt=()=>{}}={}){
 const pending=new Set(),errors=[],evidence=[];let halted;const halt=(message,retryAfter)=>{if(!halted){halted=Error(message);halted.code="PLATFORM_STOP";onHalt(message,retryAfter);}};
 // The consumer web app has used both `/user/me` and the current
 // `/user/selfinfo` endpoint for the authenticated account.  Keep both in
 // the allow-list so login verification and sync do not silently miss the
 // identity response after a platform frontend rollout.
 const relevant=path=>/^\/api\/galaxy\/(user\/info|.*note\/user\/posted)/.test(path)||/^\/api\/sns\/web\/v\d+\/(user\/(?:me|selfinfo)|feed|comment\/|you\/mentions)/.test(path)||/^\/api\/im\/web\/(v3\/chats$|chats\/group$|messages\/history$)/.test(path);
 const listener=response=>{
  const url=new URL(response.url());
  if(!(url.hostname==='xiaohongshu.com'||url.hostname.endsWith('.xiaohongshu.com'))||!relevant(url.pathname))return;
  const work=(async()=>{
   let timer;try{
    if([401,403,429].includes(response.status()))halt('平台限制或登录异常（HTTP '+response.status()+'），后续操作已停止',response.headers()['retry-after']);
    if(response.status()!==200)throw Error('HTTP '+response.status());
    if(!response.headers()['content-type']?.includes('json'))throw Error('接口返回非 JSON');
    const body=await Promise.race([response.json(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('响应体读取超过 15 秒')),15000);})]);
    if(body?.success===false||body?.code&&body.code!==0){halt('平台业务请求未通过，已暂停账号：'+String(body?.msg||body?.code).slice(0,100));throw halted;}
    evidence.push({path:url.pathname,status:response.status(),at:new Date().toISOString()});
    await onRecord({url:url.href,path:url.pathname,body,requestBody:response.request().postData()});
   }catch(e){errors.push({path:url.pathname,error:e.message.replace(/https?:\/\/\S+/g,'[地址省略]').slice(0,200)});}
   finally{clearTimeout(timer);}
  })().finally(()=>pending.delete(work));pending.add(work);
 };
 context.on('response',listener);
 return {errors,evidence,assert:()=>{if(halted)throw halted;},flush:async()=>{await Promise.all([...pending]);if(halted)throw halted;},stop:()=>context.off('response',listener)};
}
