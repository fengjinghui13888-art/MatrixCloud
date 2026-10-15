import {useEffect,useRef,useState} from 'react';

export const permissionLabels:Record<string,string>={'customers.read':'查看客户','customers.status':'停用/恢复客户','customers.recovery':'协助找回客户密码','devices.read':'查看连接设备','audit.read':'查看操作日志'};
const presets:Record<string,string[]>={'客户运营':['customers.read','customers.status','devices.read'],'客户支持':['customers.read','customers.recovery','devices.read'],'审计查看':['customers.read','devices.read','audit.read']};
type Member={username:string;displayName:string;enabled:boolean;permissions:string[]};
type Request=(path:string,body?:object)=>Promise<any>;
const empty={username:'',displayName:'',password:'',permissions:['customers.read'] as string[],enabled:true};

export function AdminMembers({request,onChanged}:{request:Request;onChanged:()=>Promise<void>}){
 const [items,setItems]=useState<Member[]>([]),[superAdmin,setSuperAdmin]=useState(''),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 const [editing,setEditing]=useState<string|null>(null),[form,setForm]=useState(empty);const pending=useRef(false);
 async function load(){const r=await request('admins');setItems(r.items);setSuperAdmin(r.superAdmin);setLoaded(true);}
 useEffect(()=>{void load().catch(e=>setError(e.message));},[]);
 async function action(work:()=>Promise<void>){if(pending.current)return;pending.current=true;setBusy(true);setError('');setMessage('');try{await work();await load();await onChanged();}catch(e){setError(e instanceof Error?e.message:'操作未完成');}finally{setBusy(false);pending.current=false;}}
 function permissionsChange(permission:string,checked:boolean){setForm(old=>{let permissions=checked?[...old.permissions,permission]:old.permissions.filter(p=>p!==permission);if(permission==='customers.read'&&!checked)permissions=permissions.filter(p=>!['customers.status','customers.recovery'].includes(p));return {...old,permissions};});}
 async function save(){
  if(editing===null)return;
  if((editing===''||form.password)&& (Array.from(form.password).length<12||new TextEncoder().encode(form.password).length>72)){setError('密码至少12个字符，UTF-8不超过72字节');return;}
  await action(async()=>{await request(editing===''?'admins':'admins/'+editing,{...(editing===''?{username:form.username}: {enabled:form.enabled}),displayName:form.displayName,permissions:form.permissions,...(form.password?{password:form.password}:{})});setEditing(null);setForm({...empty,permissions:[...empty.permissions]});setMessage('管理员设置已保存；权限变更后该账号需重新登录。');});
 }
 return <><div className="admin-intro"><div><h2>管理员与权限</h2><p>超级管理员拥有全部权限，最多创建3个独立登录的子管理员。</p></div><span>已创建 {items.length} / 3</span></div>{error&&<p role="alert" className="admin-error">{error}</p>}{message&&<p role="status" className="admin-notice">{message}</p>}
 <section className="admin-panel admin-super-card"><div><span className="admin-badge active">超级管理员</span><h3>{superAdmin||'正在读取…'}</h3><p>拥有全部权限，负责创建子管理员、授权、停用及重设密码。子管理员不能修改此账号。</p></div></section>
 <section className="admin-panel"><div className="admin-panel-title"><h2>子管理员</h2><button className="admin-primary" disabled={busy||!loaded||items.length>=3} onClick={()=>{setEditing('');setForm({...empty,permissions:[...empty.permissions]});setError('');setMessage('');}}>新增子管理员</button></div><p>每人使用各自的登录账号和密码。停用账号仍占用名额，可恢复或修改设置。</p>
 <div className="admin-members">{items.map(m=><article key={m.username}><div><strong>{m.displayName} · {m.username}</strong><p>{m.enabled?'已启用':'已停用'} · {m.permissions.map(p=>permissionLabels[p]).join('、')||'尚未分配权限'}</p></div><div className="admin-member-actions"><button disabled={busy} onClick={()=>{setEditing(m.username);setForm({...m,password:''});setError('');setMessage('');}}>编辑权限或密码</button><button disabled={busy} onClick={()=>{if(window.confirm(`${m.enabled?'停用':'恢复'}子管理员 ${m.username}？${m.enabled?'该账号将立即退出后台。':''}`))void action(async()=>{await request('admins/'+m.username,{enabled:!m.enabled});setMessage('管理员状态已更新');});}}>{m.enabled?'停用':'恢复'}</button></div></article>)}</div>{loaded&&!items.length&&<p className="admin-empty">还没有子管理员，点击上方新增。</p>}</section>
 {editing!==null&&<section className="admin-panel" aria-label="管理员设置"><h2>{editing===''?'新增子管理员':'编辑子管理员'}</h2><form className="admin-member-form" onSubmit={e=>{e.preventDefault();void save();}}>
 <label>登录账号<input required minLength={3} maxLength={40} pattern="[a-zA-Z0-9_.\-]+" autoComplete="off" disabled={busy||editing!==''} value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/></label><label>姓名或备注<input required maxLength={40} disabled={busy} value={form.displayName} onChange={e=>setForm({...form,displayName:e.target.value})}/></label>
 <label>{editing===''?'初始密码':'重设密码（不修改请留空）'}<input type="password" autoComplete="new-password" required={editing===''} disabled={busy} value={form.password} onChange={e=>setForm({...form,password:e.target.value})} placeholder="至少12个字符"/></label>
 <label>快速选择权限<select aria-label="权限模板" disabled={busy} value={Object.keys(presets).find(k=>presets[k].length===form.permissions.length&&presets[k].every(p=>form.permissions.includes(p)))??''} onChange={e=>{if(presets[e.target.value])setForm({...form,permissions:[...presets[e.target.value]]});}}><option value="">自定义权限</option>{Object.keys(presets).map(k=><option key={k}>{k}</option>)}</select></label>
 <fieldset disabled={busy} className="admin-permissions"><legend>允许执行的操作</legend>{Object.entries(permissionLabels).map(([key,label])=><label key={key}><input type="checkbox" checked={form.permissions.includes(key)} disabled={['customers.status','customers.recovery'].includes(key)&&!form.permissions.includes('customers.read')} onChange={e=>permissionsChange(key,e.target.checked)}/>{label}</label>)}<small>客户操作需同时开启“查看客户”。子管理员永远没有管理员账号管理权限。</small></fieldset>
 <div className="admin-member-form-actions"><button className="admin-primary" disabled={busy}>{busy?'正在保存…':'保存管理员'}</button><button type="button" disabled={busy} onClick={()=>{setEditing(null);setForm({...empty,permissions:[...empty.permissions]});}}>取消</button></div></form></section>}
 </>;
}
