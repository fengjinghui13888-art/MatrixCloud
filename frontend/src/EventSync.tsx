import {useEffect,useRef,useState} from 'react';

type Request=(path:string,body?:unknown,signal?:AbortSignal)=>Promise<any>;
type Props={request:Request;onDataChanged?:()=>void|Promise<void>;accounts?:Array<{id:string;name:string}>;readOnly?:boolean};
type EventStatus={enabled:boolean;mode:'event';accounts:Array<{accountId:string;status:string;message?:string;lastEventAt?:string;lastSyncedAt?:string}>};

const time=(value?:string)=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'尚未发现';

export function EventSync({request,onDataChanged,accounts=[],readOnly=false}:Props){
 const [state,setState]=useState<EventStatus|null>(null),[error,setError]=useState(''),[saving,setSaving]=useState(false),[epoch,setEpoch]=useState(0);
 const previous=useRef(''),requestRef=useRef(request),onDataChangedRef=useRef(onDataChanged),version=useRef(0);
 requestRef.current=request;onDataChangedRef.current=onDataChanged;
 useEffect(()=>{
  let stopped=false,timer:number|undefined;const controller=new AbortController(),stamp=version.current;
  const read=async()=>{
   try{
    const next=await requestRef.current('event-sync',undefined,controller.signal);if(stopped||stamp!==version.current)return;
    if(!next||next.mode!=='event'||!Array.isArray(next.accounts))return;
    const signature=JSON.stringify(next.accounts.map((a:EventStatus['accounts'][number])=>[a.accountId,a.lastSyncedAt??'']));
    const changed=previous.current&&signature!==previous.current;previous.current=signature;setState(next);setError('');
    if(changed)await onDataChangedRef.current?.();
   }catch(e){if(!stopped)setError(e instanceof Error?e.message:'自动同步状态读取失败');}
   if(!stopped&&state?.enabled)timer=window.setTimeout(read,3000);
  };
  void read();return()=>{stopped=true;controller.abort();if(timer!==undefined)window.clearTimeout(timer);};
 },[state?.enabled,epoch]);
 const enabled=state?.enabled===true;
 const toggle=async()=>{
  if(saving)return;version.current++;setSaving(true);setError('');try{const next=await requestRef.current('event-sync',{enabled:!enabled});setState(next);}catch(e){setError(e instanceof Error?e.message:'自动同步设置失败');}finally{setSaving(false);setEpoch(value=>value+1);}
 };
 return <section className="grey-panel event-sync-panel" aria-label="事件自动同步">
  <div className="library-heading"><div><h2>发现变化后自动同步</h2><p className="media-caption">只在检测到新笔记、评论或私信变化时采集，不按固定时间抓取。</p></div><label><input type="checkbox" aria-label="发现变化后自动同步" checked={enabled} disabled={saving||readOnly||!state} onChange={()=>void toggle()}/> {saving?'正在保存…':enabled?'已开启':'未开启'}</label></div>
  {enabled&&<p className="media-caption">小红书专属浏览器窗口需保持登录；页面休眠或平台没有变化事件时不会主动刷新。</p>}
  {state?.accounts?.length?<div className="event-sync-accounts">{state.accounts.filter(a=>a.accountId).map(account=><p key={account.accountId} role="status"><strong>{accounts.find(a=>a.id===account.accountId)?.name??'小红书账号'}</strong>：{enabled&&account.message==='事件同步已关闭'?'等待浏览器变化':account.message||'等待页面变化'} · 最近发现 {time(account.lastEventAt)} · 最近完成 {time(account.lastSyncedAt)}</p>)}</div>:<p className="media-caption">还没有绑定小红书账号。</p>}
  {error&&<p role="alert" className="warning">{error}</p>}
 </section>;
}
