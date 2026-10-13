import {useEffect,useRef,useState} from 'react';
type Member={username:string;displayName:string;role:'admin'|'operator'|'lead_viewer';enabled:boolean};
const roles={admin:'管理员',operator:'运营',lead_viewer:'仅看线索'};
export function TeamSettings({request}:{request:(path:string,body?:unknown)=>Promise<any>}){
 const ref=useRef(request);ref.current=request;
 const [items,setItems]=useState<Member[]>([]),[me,setMe]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [username,setUsername]=useState(''),[displayName,setName]=useState(''),[password,setPassword]=useState(''),[role,setRole]=useState<Member['role']>('operator');
 const [resetUser,setResetUser]=useState(''),[newPassword,setNewPassword]=useState('');
 async function load(){const r=await ref.current('auth/team');setItems(r.items);setMe(r.currentUsername);}
 useEffect(()=>{void load().catch(()=>setMessage('成员加载失败，请点击刷新'));},[]);
 async function action(path:string,body:unknown){setBusy(true);setMessage('');try{await request(path,body);await load();setMessage('已保存，成员权限立即生效');return true;}catch(e){setMessage(e instanceof Error?e.message:'保存失败，请重试');return false;}finally{setBusy(false);}}
 return <section className="grey-panel team-settings"><header><div><h2>团队成员</h2><p>同一客户的成员共享账号、内容和线索。管理员管理设备撤销与模型；运营可连接自己的电脑并处理日常业务；仅看线索不能修改数据。</p></div><button className="ghost" disabled={busy} onClick={()=>void load().catch(()=>setMessage('加载失败，请重试'))}>刷新</button></header>
 <form className="team-create" onSubmit={async e=>{e.preventDefault();if(await action('auth/team',{username,password,displayName,role})){setUsername('');setName('');setPassword('');}}}>
 <label>成员姓名<input required maxLength={40} value={displayName} onChange={e=>setName(e.target.value)} autoComplete="off"/></label>
 <label>登录账号<input required minLength={3} maxLength={40} pattern="[a-zA-Z0-9_.\-]+" value={username} onChange={e=>setUsername(e.target.value)} autoComplete="off"/></label>
 <label>初始密码<input required type="password" minLength={12} maxLength={72} value={password} onChange={e=>setPassword(e.target.value)} autoComplete="new-password"/></label>
 <label>权限<select value={role} onChange={e=>setRole(e.target.value as Member['role'])}>{Object.entries(roles).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
 <button className="primary" disabled={busy}>{busy?'正在保存…':'添加成员'}</button></form>
 {message&&<p role="status">{message}</p>}
 <div className="team-list">{items.map(m=><article key={m.username}><div><strong>{m.displayName}</strong><p>{m.username}{m.username===me?' · 当前账号':''} · {m.enabled?'已启用':'已停用'}</p></div><label>权限<select aria-label={`${m.username} 的权限`} disabled={busy||m.username===me} value={m.role} onChange={e=>{if(window.confirm('修改权限后，此成员需重新登录。确认修改？'))void action('auth/team/'+encodeURIComponent(m.username),{role:e.target.value});}}>{Object.entries(roles).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label><button className="ghost" disabled={busy||m.username===me} onClick={()=>{setResetUser(m.username);setNewPassword('');}}>重设密码</button><button className="ghost" disabled={busy||m.username===me} onClick={()=>{if(window.confirm(`${m.enabled?'停用后将立即退出并失去访问权限':'重新启用此成员'}，确认继续？`))void action('auth/team/'+encodeURIComponent(m.username),{enabled:!m.enabled});}}>{m.enabled?'停用':'启用'}</button></article>)}</div>
 {resetUser&&<form className="team-create" onSubmit={async e=>{e.preventDefault();if(await action('auth/team/'+encodeURIComponent(resetUser),{password:newPassword})){setResetUser('');setNewPassword('');setMessage('密码已重设，该成员需使用新密码重新登录');}}}><label>{resetUser} 的新密码<input autoFocus required type="password" minLength={12} maxLength={72} autoComplete="new-password" value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></label><p>保存后该成员的现有登录会立即失效。密码不会再次显示。</p><button className="primary" disabled={busy}>保存新密码</button><button type="button" className="ghost" disabled={busy} onClick={()=>{setResetUser('');setNewPassword('');}}>取消</button></form>}
 </section>;
}
