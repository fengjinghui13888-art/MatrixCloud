import {customerMessage} from './customer-message';
import {useEffect,useRef,useState} from 'react';
import type {Account} from '../server/domain';
type Props={request:(path:string,body?:unknown)=>Promise<any>;onDone:(job:any)=>void;onStopped?:()=>void;externalJob?:any;accounts?:Account[]};
export function XhsQrLogin({request,onDone,onStopped,externalJob,accounts=[]}:Props){
 const [job,setJob]=useState<any>(null),[target,setTarget]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const lastStage=useRef<string>('');
 const requester=useRef(request),done=useRef(onDone);requester.current=request;done.current=onDone;
 useEffect(()=>{
  // Deleting an account removes its option from the list. Clear the local
  // selection as well, otherwise a stale id would be sent as a reconnect
  // target and the customer would be told that the deleted account is gone.
  if(target && !accounts.some(account=>account.id===target)){
   setTarget('');setJob(null);setError('');lastStage.current='';
  }
 },[accounts,target]);
 useEffect(()=>{if(externalJob){lastStage.current=externalJob.stage??'creator';setJob(externalJob);setTarget(externalJob.accountId??'');setError('');}},[externalJob?.id]);
 useEffect(()=>{if(externalJob)return;let cancelled=false;void requester.current('xhs/qr-login').then(latest=>{if(!cancelled&&latest&&!['failed','cancelled','authenticated'].includes(latest.status)){lastStage.current=latest.stage??'creator';setJob(latest);setTarget(latest.accountId??'');}}).catch(()=>{});return()=>{cancelled=true;};},[externalJob?.id]);
 useEffect(()=>{if(!job?.id||['authenticated','failed','cancelled'].includes(job.status))return;let cancelled=false;let timer:ReturnType<typeof setTimeout>;
 const poll=async()=>{try{const next=await requester.current('xhs/qr-login/'+job.id);if(cancelled)return;setJob(next);if(next.stage!==lastStage.current)lastStage.current=next.stage;setError('');if(next.status==='authenticated'&&next.account){done.current(next);return;}if(['failed','cancelled'].includes(next.status)){onStopped?.();return;}}catch(e){if(!cancelled)setError(e instanceof Error?customerMessage(e):'无法读取扫码状态');}if(!cancelled)timer=setTimeout(poll,1200);};timer=setTimeout(poll,500);return()=>{cancelled=true;clearTimeout(timer);};},[job?.id,job?.status]);
 async function start(){setBusy(true);setError('');lastStage.current='creator';try{setJob(await requester.current('xhs/qr-login',target?{accountId:target}:{}));}catch(e){setError(e instanceof Error?customerMessage(e):'无法打开登录窗口');}finally{setBusy(false);}}
 async function cancel(){try{setJob(await requester.current('xhs/qr-login/'+job.id+'/cancel',{}));onStopped?.();}catch(e){setError(String(e));}}
 return <section className="grey-panel qr-login-panel"><div className="creation-heading"><div><h2>连接小红书账号</h2><p className="section-intro">点击后，所选执行电脑会自动打开小红书登录页。请在弹出的浏览器中使用小红书 App 扫码；账号会独立保存，互不影响。</p></div></div>
 <label>接入账号<select aria-label="扫码目标账号" value={target} disabled={busy||!!job&&!['failed','cancelled','authenticated'].includes(job.status)} onChange={e=>{setTarget(e.target.value);setJob(null);}}><option value="">添加新的小红书账号</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name} · {a.handle}</option>)}</select></label>
 {(!job||['failed','cancelled','authenticated'].includes(job.status))&&<button className="primary" disabled={busy} onClick={()=>void start()}>{busy?'正在打开浏览器…':target?'打开浏览器并连接账号':'打开浏览器并添加账号'}</button>}
 {job?.deviceName&&<p className="media-caption">登录和同步电脑：{job.deviceName}。请在这台电脑打开的小红书窗口完成登录；登录完成后会自动继续同步，可随时停止。</p>}
 {job?.status==='failed'&&job.message?.includes('不一致')&&<button className="ghost" onClick={()=>void requester.current('xhs/qr-login/'+job.id+'/adopt',{}).then(next=>{setJob(next);if(next.account)done.current(next);}).catch(e=>setError(String(e)))}>按扫码的实际账号接入</button>}
 {job&&<div className="qr-login-status">{job.status==='waiting_scan'&&<div className="browser-login-step" role="status"><strong>请在弹出的浏览器中扫码</strong><p>{job.stage==='web'?'小红书网页版已经打开，请使用小红书 App 扫码登录。':'创作服务平台已经打开，请使用小红书 App 扫码登录。'}</p><small>二维码只显示在执行电脑的浏览器窗口中，工作台不会重复显示或保存二维码。</small></div>}<p role="status">{job.status==='authenticated'?'登录完成，正在自动同步账号数据。':job.status==='waiting_scan'?(job.message?customerMessage(job.message):'等待浏览器中的扫码结果…'):customerMessage(job.message)}</p>{['starting','waiting_scan'].includes(job.status)&&<button className="ghost" onClick={()=>void cancel()}>取消扫码</button>}</div>}{error&&<p role="alert" className="login-error">{error}</p>}
 <p className="media-caption">登录过期时可在这里重新扫码。</p></section>;
}
