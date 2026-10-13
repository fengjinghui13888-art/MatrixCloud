import {TeamSettings} from './TeamSettings';
import { useEffect,useRef,useState } from 'react';

export function PersonalMenu({username,onProfile,onSettings,onLogout,onSwitchAccount}:{username:string;onProfile:()=>void;onSettings:()=>void;onLogout:()=>Promise<void>;onSwitchAccount?:()=>Promise<void>}){
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(!open)return;const close=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[open]);
  async function leave(action:()=>Promise<void>,message:string){setBusy(true);setError('');try{await action();}catch{setError(message);setBusy(false);}}
  return <div ref={root} className="personal-anchor" onKeyDown={e=>{if(e.key==='Escape'){setOpen(false);trigger.current?.focus();}}}>
    <button ref={trigger} className="profile-trigger" aria-label="打开个人中心" aria-expanded={open} onClick={()=>setOpen(v=>!v)}><span className="avatar" aria-hidden="true">{username.slice(0,1).toUpperCase()}</span><span><strong>{username}</strong><small>个人账户</small></span><span aria-hidden="true">⋯</span></button>
    {open&&<div className="profile-menu" aria-label="个人账户菜单"><strong>{username}</strong><button onClick={()=>{setOpen(false);onProfile();}}>个人中心</button><button onClick={()=>{setOpen(false);onSettings();}}>设置</button><button disabled={busy} onClick={()=>{setOpen(false);void leave(onSwitchAccount??onLogout,'切换账号失败，请重试');}}>切换系统账号</button><button disabled={busy} onClick={()=>{setOpen(false);void leave(onLogout,'退出失败，请重试');}}>退出登录</button>{error&&<p role="alert">{error}</p>}</div>}
  </div>;
}

export function PersonalCenter({request}:{request:(path:string,body?:unknown)=>Promise<any>}){
  const [profile,setProfile]=useState<{username:string;displayName:string;role?:string}|null>(null),[name,setName]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const ref=useRef(request);ref.current=request;
  useEffect(()=>{let active=true;ref.current('auth/profile').then(p=>{if(active){setProfile(p);setName(p.displayName);}}).catch(()=>{if(active)setMessage('个人资料加载失败，请重新进入');});return()=>{active=false;};},[]);
  return <><section className="grey-panel model-settings personal-center"><h2>个人资料</h2>{profile?<form onSubmit={async e=>{e.preventDefault();setBusy(true);setMessage('');try{const p=await request('auth/profile',{displayName:name});setProfile(p);setMessage('个人资料已保存');}catch{setMessage('保存失败，请重试');}finally{setBusy(false);}}}><div className="personal-identity"><span className="avatar">{(name||profile.username).slice(0,1).toUpperCase()}</span><div><h3>{profile.displayName}</h3><p>系统账号：{profile.username}</p></div></div><label>昵称<input required maxLength={40} value={name} onChange={e=>setName(e.target.value)}/></label><p>切换系统账号需重新登录。同一客户下的团队成员共享内容；不同客户的数据独立保存。</p><button className="primary" disabled={busy||!name.trim()}>{busy?'正在保存…':'保存资料'}</button></form>:<p>正在读取个人资料…</p>}{message&&<p role="status">{message}</p>}</section>{profile?.role==='admin'&&<TeamSettings request={request}/>}</>;
}
