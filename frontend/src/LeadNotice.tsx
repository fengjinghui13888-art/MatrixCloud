import {useEffect,useRef,useState} from 'react';

export function LeadNotice({request,onOpen,onRefresh}:{request:(path:string)=>Promise<any>;onOpen:()=>void;onRefresh:()=>Promise<void>}){
 const [notice,setNotice]=useState(0),[waiting,setWaiting]=useState(0);
 const seen=useRef<Set<string>|null>(null),actions=useRef({request,onRefresh});actions.current={request,onRefresh};
 useEffect(()=>{
  let stopped=false,timer:number|undefined;
  async function check(){
   try{const result=await actions.current.request('leads/notifications');if(stopped||!Array.isArray(result?.ids))return;
    const next=new Set<string>(result.ids),added=seen.current?[...next].filter(id=>!seen.current!.has(id)):[];
    seen.current=next;setWaiting(result.waiting??0);
    if(added.length){setNotice(count=>count+added.length);await actions.current.onRefresh();}
   }catch{/* A transient status read must not interrupt other customer actions. */}
   finally{if(!stopped)timer=window.setTimeout(check,3000);}
  }
  void check();return()=>{stopped=true;if(timer!==undefined)window.clearTimeout(timer);};
 },[]);
 return <>
  {waiting>0&&<button className="lead-inbox" onClick={onOpen}>待跟进线索 {waiting} 条</button>}
  {notice>0&&<section className="lead-toast" role="alertdialog" aria-label="新线索提醒" aria-live="assertive"><strong>收到 {notice} 条新线索</strong><p>新评论或私信已加入线索中心，请及时跟进。</p><div><button className="primary" onClick={()=>{setNotice(0);onOpen();}}>立即查看</button><button className="ghost" onClick={()=>setNotice(0)}>稍后处理</button></div></section>}
 </>;
}
