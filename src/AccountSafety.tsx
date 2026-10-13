import {useState} from 'react';
import {customerMessage} from './customer-message';
export function AccountSafety({id,request}:{id:string;request:(path:string,body?:unknown)=>Promise<any>}){
 const [state,setState]=useState<any>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 async function load(){setBusy(true);try{setState(await request('accounts/'+encodeURIComponent(id)+'/safety'));setMessage('');}catch(e){setMessage(customerMessage(e));}finally{setBusy(false);}}
 async function resume(){if(!window.confirm('请先在原执行电脑核对平台提示、登录和已有草稿。确认平台允许继续后再恢复；这不会自动开始同步。'))return;setBusy(true);try{setState(await request('accounts/'+encodeURIComponent(id)+'/resume',{confirmed:true}));setMessage('已恢复，请手动开始下一步。');}catch(e){setMessage(customerMessage(e));}finally{setBusy(false);}}
 return <div className="account-safety"><button className="ghost" disabled={busy} onClick={()=>void load()}>查看操作状态</button>{state&&<p>操作状态：{state.state==='normal'?'可操作':state.state==='cooldown'?'等待平台冷却':'已暂停'}{state.until?' · 最早核对时间 '+new Date(state.until).toLocaleString():''}</p>}{state&&<button className="ghost" disabled={busy} onClick={()=>void resume()}>{state.state==='normal'?'核对未完成任务':'已人工核对，恢复操作'}</button>}{message&&<p role="status">{message}</p>}</div>;
}
