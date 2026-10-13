import {ConnectorAuthorize} from './ConnectorAuthorize';
import {AccountSafety} from './AccountSafety';
import {customerMessage} from './customer-message';
import { useEffect, useRef, useState } from 'react';
import type { Account, Note, Comment, DirectMessage, Lead, FollowUp } from '../contracts/domain';
import './styles/grey.css';
import { ModelSettings } from './ModelSettings';
import { NoteCard, NoteDetail } from './NoteContent';
import { Overview } from './Overview';
import { PublishCenter } from './PublishCenter';
import { AccountLogin } from './AccountLogin';
import { PersonalCenter, PersonalMenu } from './PersonalCenter';
import { XhsQrLogin } from './XhsQrLogin';
import {messageThreads} from './message-threads';
import {ConnectorPairingPanel} from './ConnectorPairingPanel';
import {EventSync} from './EventSync';
import {newSyncRecords} from './new-sync-records';
import {readSessionValue} from './safe-storage';
type Data={role?:'admin'|'operator'|'lead_viewer';accounts:Account[];notes:Note[];comments:Comment[];messages?:DirectMessage[];leads:(Lead&{followUps:FollowUp[]})[]};
const sections=['经营概览','账号矩阵','内容管理','互动管理','线索中心','发布中心','连接设置'];
const displayDate=(value:string)=>{if(!value)return '尚未同步';const date=new Date(value);return Number.isNaN(date.getTime())?'待确认':date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});};
const activeSync=(job:any)=>!job?.localOnly&&['running','queued','stopping'].includes(job?.status);
const syncStages:Record<string,string>={queued:'等待执行电脑',starting:'连接执行电脑',account:'核对账号',notes:'同步内容',comments:'同步评论',messages:'同步私信',media:'同步图片',saving:'保存同步结果',finished:'同步完成',blocked:'同步已暂停'};
const syncCounts=(job:any)=>{const counts=job.counts??{};return `${typeof counts.notes==='number'?` · 内容 ${counts.notes}`:''}${typeof counts.comments==='number'?` · 评论 ${counts.comments}`:''}${typeof counts.messages==='number'?` · 私信 ${counts.messages}`:''}`;};
const syncSummary=(job:any)=>{
  if(job.localOnly)return job.message;
  const readNotice=job.readError?`；状态读取中断：${job.readError}。正在核对，最后确认的任务状态保留。`:'';
  return syncStatus(job)+readNotice;
};
const syncStatus=(job:any)=>{
  if(job?.status==='stopping')return '正在停止，等待执行电脑确认…';
  if(job?.status==='queued'||job?.status==='running'&&job?.stage==='queued')return `等待执行电脑${job.message?`：${customerMessage(job.message)}`:''}${typeof job.queuePosition==='number'?` · 排队位置 ${job.queuePosition}`:''}`;
  if(job.status==='running'){const stage=syncStages[job.stage];return `${stage?`${stage}：`:''}${customerMessage(job.message,'正在同步内容…')}${syncCounts(job)}`;}
  if(job.status==='failed'||job.status==='blocked')return customerMessage(job.error||job.message,'同步未完成，请核对执行电脑');
  if(job.status==='partial')return '已保存部分内容，可继续同步补全';
  if(job.status==='cancelled'||job.status==='canceled')return '同步已停止';
  return `同步完成${syncCounts(job)}`;
};
export function GreyApp(){return <AccountLogin>{(username,logout,switchAccount)=><Workspace username={username} logout={logout} switchAccount={switchAccount}/>}</AccountLogin>;}
function Workspace({username,logout,switchAccount}:{username:string;logout:()=>Promise<void>;switchAccount:()=>Promise<void>}){
  const [setupNonce,setSetupNonce]=useState(()=>/^#connectorSetup=([a-f0-9]{64})$/.exec(window.location.hash)?.[1]??'');
  const [setupComplete,setSetupComplete]=useState(()=>window.location.hash==='#connectorComplete');
  useEffect(()=>{
    const readSetupLink=()=>{
      const nonce=/^#connectorSetup=([a-f0-9]{64})$/.exec(window.location.hash)?.[1];
      const complete=window.location.hash==='#connectorComplete';
      if(nonce||complete){setSetupNonce(nonce??'');setSetupComplete(complete);history.replaceState(null,'',location.pathname+location.search);setPage('账号矩阵');}
    };
    window.addEventListener('hashchange',readSetupLink);
    return()=>window.removeEventListener('hashchange',readSetupLink);
  },[]);
  useEffect(()=>{if(setupNonce||setupComplete){history.replaceState(null,'',location.pathname+location.search);setPage('账号矩阵');}else if(readSessionValue('matrix.pendingPairing'))setPage('账号矩阵');},[setupNonce,setupComplete]);
  const [data,setData]=useState<Data|null>(null);const [page,setPage]=useState('经营概览');const [scope,setScope]=useState('all');const [query,setQuery]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [detail,setDetail]=useState<Note|null>(null);const [follow,setFollow]=useState<Record<string,string>>({});const [profileOpen,setProfileOpen]=useState(false);const [syncJobs,setSyncJobs]=useState<Record<string,any>>({});const [connectedProfiles,setConnectedProfiles]=useState<string[]>([]);const [contentPage,setContentPage]=useState(1);const [selectedAccounts,setSelectedAccounts]=useState<string[]>([]);const [selectedNotes,setSelectedNotes]=useState<string[]>([]);const [selectedLeads,setSelectedLeads]=useState<string[]>([]);
  async function request(path:string,body?:unknown,signal?:AbortSignal){
    const controller=new AbortController(),timer=window.setTimeout(()=>controller.abort(),65000);
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try{const r=await fetch('/api/'+path,{method:body?'POST':'GET',credentials:'same-origin',signal:controller.signal,headers:{'Content-Type':'application/json',Accept:'application/json'},...(body?{body:JSON.stringify(body)}:{})});const raw=await r.text();let value:any;try{value=raw?JSON.parse(raw):null;}catch{throw new Error(r.ok?'服务器返回了无法读取的结果':`服务暂时不可用（HTTP ${r.status}）`);}if(!r.ok)throw new Error(value?.message??`请求失败（HTTP ${r.status}）`);return value;}
    catch(e){if(controller.signal.aborted)throw Error('请求超时，结果未确认，请核对执行电脑和账号状态后再继续。');throw e;}
    finally{window.clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  async function refresh(){setBusy(true);setError('');try{const next=await request('operations');setData(next);if(next.role==='lead_viewer')setPage('线索中心');}catch(e){setError(customerMessage(e));}finally{setBusy(false);}}
  const dataRef=useRef(data);dataRef.current=data;
  const [newDataNotice,setNewDataNotice]=useState('');
  async function refreshQuiet(){try{const next=await request('operations'),counts=newSyncRecords(dataRef.current,next);if(counts.notes||counts.comments||counts.messages)setNewDataNotice(`已同步新增内容 ${counts.notes} 篇、评论 ${counts.comments} 条、私信 ${counts.messages} 条`);setData(next);}catch(e){setError(customerMessage(e));}}
  const [loginJob,setLoginJob]=useState<any>(null);
  const syncRemaining=useRef<string[]>([]);
  const completedLogins=useRef(new Set<string>());
  const stopRequests=useRef(new Set<string>());
  const stopVersions=useRef(new Map<string,number>());
  async function stopSync(job:any){
    if(stopRequests.current.has(job.id))return;
    stopRequests.current.add(job.id);
    stopVersions.current.set(job.id,(stopVersions.current.get(job.id)??0)+1);
    setSyncJobs(old=>({...old,[job.accountId]:{...job,status:'stopping'}}));
    try{const next=await request(`accounts/${job.accountId}/sync/${job.id}/cancel`,{});setSyncJobs(old=>({...old,[job.accountId]:next}));}
    catch(e){setError(customerMessage(e,'停止尚未确认，请保持执行电脑在线'));}
    finally{stopRequests.current.delete(job.id);stopVersions.current.set(job.id,(stopVersions.current.get(job.id)??0)+1);}
  }
  const loginPending=!!loginJob&&!['failed','cancelled','authenticated'].includes(loginJob.status);
  function localSync(accountId:string,status:string,message:string){return {id:`local-sync:${accountId}`,accountId,status,message,localOnly:true};}
  function pauseAccounts(ids:string[],message:string){setSyncJobs(old=>{const next={...old};for(const id of ids)if(next[id]?.localOnly)next[id]={...next[id],status:'paused',message};return next;});}
  async function syncSequence(ids:string[],deviceId?:string){
    setBusy(true);setError('');
    setSyncJobs(old=>({...old,...Object.fromEntries(ids.map(accountId=>[accountId,localSync(accountId,'waiting','等待前一账号确认后同步')]))}));
    let index=0;
    try{
      for(;index<ids.length;index++){
        const accountId=ids[index];
        setSyncJobs(old=>({...old,[accountId]:localSync(accountId,'submitting','正在提交同步，等待执行电脑确认…')}));
        const job=await request(`accounts/${accountId}/sync`,deviceId?{deviceId}:{});
        if(job.loginRequired){
          syncRemaining.current=ids.slice(index+1);
          setSyncJobs(old=>({...old,[accountId]:localSync(accountId,'login_required','等待扫码登录，登录完成后自动继续同步')}));
          pauseAccounts(syncRemaining.current,'等待前一账号扫码登录，后续同步已暂停');
          setLoginJob(job.loginJob);setPage('账号矩阵');
          if(job.loginJob.status==='failed'){syncRemaining.current=[];pauseAccounts(ids.slice(index),`账号登录未完成，后续同步已暂停：${customerMessage(job.loginJob.message)}`);setError(job.loginJob.message);}
          return;
        }
        setSyncJobs(old=>({...old,[accountId]:job}));
        if(job.status==='blocked'||job.status==='failed'){syncRemaining.current=[];pauseAccounts(ids.slice(index+1),'前一账号同步未完成，后续同步已暂停');return;}
      }
      syncRemaining.current=[];
    }catch(e){
      const accountId=ids[index],name=data?.accounts.find(a=>a.id===accountId)?.name??'当前账号',message=customerMessage(e);
      syncRemaining.current=[];
      setSyncJobs(old=>({...old,[accountId]:localSync(accountId,'unconfirmed',`同步请求未完成：${message}。启动结果未确认，请核对后再继续。`)}));
      pauseAccounts(ids.slice(index+1),`因 ${name} 同步请求未确认，后续同步已暂停`);
      setPage('账号矩阵');setError(`${name}：${message}`);
    }
    finally{setBusy(false);}
  }
  async function syncAllAndRefresh(){
    const ids=(data?.accounts??[]).map(a=>a.id);
    if(!ids.length){setPage('账号矩阵');setError('请先扫码添加小红书账号');return;}
    try{
      const selection=await request('connector/devices');
      if(!selection.selectedDeviceId)throw Error('请先在账号矩阵选择当前要执行的电脑');
      if(!window.confirm('将依次同步全部账号的内容、评论与私信。过程中可停止，遇到登录或限制提示将暂停。是否开始？'))return;await syncSequence(ids,selection.selectedDeviceId);
    }catch(e){setPage('账号矩阵');setError(customerMessage(e));}
  }
  async function loginComplete(job:any){
    if(!job.id||completedLogins.current.has(job.id))return;
    completedLogins.current.add(job.id);
    setBusy(true);
    setLoginJob(null);setPage('账号矩阵');
    const remaining=syncRemaining.current;syncRemaining.current=[];
    try{
      setData(await request('operations'));
      if(!job.account?.id||!job.deviceId)throw Error('登录完成，但执行电脑信息不完整，请重新连接此账号。');
      const selection=await request('connector/devices');
      if(selection.selectedDeviceId!==job.deviceId)throw Error('登录完成，但所选电脑已改变，自动同步已暂停。请在原电脑继续同步。');
      await syncSequence([...new Set([job.account.id,...remaining])],job.deviceId);
    }catch(e){const message=customerMessage(e);pauseAccounts([job.account?.id,...remaining].filter(Boolean),`自动同步已暂停：${message}`);setError(message);}
    finally{setBusy(false);}
  }
  function loginStopped(){pauseAccounts([loginJob?.accountId,...syncRemaining.current].filter(Boolean),'扫码登录已停止，后续同步已暂停');syncRemaining.current=[];setLoginJob(null);}

  async function mutate(path:string,body:unknown):Promise<boolean>{setBusy(true);setError('');try{await request(path,body);setData(await request('operations'));return true;}catch(e){setError(customerMessage(e));return false;}finally{setBusy(false);}}
  useEffect(()=>{
    let cancelled=false;void refresh();
    void request('accounts').then(accounts=>Promise.allSettled(accounts.map(async(account:Account)=>{
      try{const job=await request(`accounts/${account.id}/sync/latest`);if(!cancelled&&job)setSyncJobs(old=>old[account.id]?old:{...old,[account.id]:job});}
      catch(e){if(!cancelled)setSyncJobs(old=>old[account.id]?old:{...old,[account.id]:localSync(account.id,'read_unconfirmed',`同步状态读取中断：${customerMessage(e)}。账号任务状态未确认，请核对执行电脑。`)});}
    }))).catch(e=>{if(!cancelled)setError(customerMessage(e));});
    return()=>{cancelled=true;};
  },[]);
  async function syncAccount(accountId:string){
    try{const selection=await request('connector/devices');if(!selection.selectedDeviceId)throw Error('请先选择执行电脑');const account=data?.accounts.find(a=>a.id===accountId),device=selection.devices?.find((d:any)=>d.id===selection.selectedDeviceId);if(!window.confirm(`将同步 ${account?.name??'所选账号'} 的内容、评论与私信。执行电脑：${device?.name??'当前所选电脑'}。如需登录，完成后将自动继续同步。是否继续？`))return;syncRemaining.current=[];await syncSequence([accountId],selection.selectedDeviceId);}catch(e){setError(customerMessage(e));}

  }
  async function deleteAccount(account:Account){
    if(!window.confirm(`确定删除账号“${account.name}”吗？该账号的内容、评论、私信和线索都会一并删除。`))return;
    if(await mutate(`accounts/${encodeURIComponent(account.id)}/delete`,{})){setScope('all');setDetail(null);}
  }
  async function deleteAccounts(){const ids=[...new Set(selectedAccounts)];if(!ids.length)return;if(!window.confirm(`确定删除选中的 ${ids.length} 个账号及其全部内容吗？`))return;if(await mutate('accounts/bulk-delete',{ids})){setSelectedAccounts([]);setScope('all');}}
  async function deleteNote(note:Note){
    if(!window.confirm(`确定删除内容“${note.title}”吗？相关评论和线索也会删除。`))return;
    if(await mutate(`accounts/${encodeURIComponent(note.accountId)}/notes/${encodeURIComponent(note.id)}/delete`,{}))setDetail(null);
  }
  async function deleteSelectedNotes(){const items=selectedNotes.map(noteId=>{const note=(data?.notes??[]).find(n=>n.id===noteId);return note&&{accountId:note.accountId,noteId:note.id};}).filter(Boolean);if(!items.length)return;if(!window.confirm(`确定删除选中的 ${items.length} 篇内容及其评论、线索吗？`))return;if(await mutate('notes/bulk-delete',{items})){setSelectedNotes([]);setDetail(null);}}
  async function deleteLead(id:string){if(!window.confirm('确定删除这条线索及其全部跟进记录吗？'))return;if(await mutate(`leads/${encodeURIComponent(id)}/delete`,{}))setSelectedLeads(ids=>ids.filter(x=>x!==id));}
  async function deleteSelectedLeads(){if(!selectedLeads.length)return;if(!window.confirm(`确定删除选中的 ${selectedLeads.length} 条线索及其跟进记录吗？`))return;if(await mutate('leads/bulk-delete',{ids:selectedLeads}))setSelectedLeads([]);}
  async function clearHistory(){
    const label=scope==='all'?'全部账号':'当前账号';
    if(!window.confirm(`确定清空${label}的历史内容吗？内容、评论、私信和线索都会删除。`))return;
    if(await mutate('content/clear',scope==='all'?{}:{accountId:scope}))setDetail(null);
  }
  const activeKey=Object.values(syncJobs).filter(j=>activeSync(j)).map(j=>j.accountId+'|'+j.id).sort().join(',');
  const syncing=!!activeKey;
  const readOnly=data?.role==='lead_viewer';
  useEffect(()=>{
    if(!activeKey)return;
    const jobs=Object.values(syncJobs).filter(j=>activeSync(j)),controller=new AbortController(),timers=new Set<number>();let cancelled=false;
    async function poll(job:any){
      const version=stopVersions.current.get(job.id);let stillActive=true;
      try{
        const next=await request(`accounts/${job.accountId}/sync/${job.id}`,undefined,controller.signal);
        if(!next||next.id!==job.id||next.accountId!==job.accountId)throw Error('同步状态暂不可用');
        const canApply=!stopRequests.current.has(job.id)&&version===stopVersions.current.get(job.id);
        if(!cancelled&&canApply)setSyncJobs(old=>old[job.accountId]?.id===job.id?{...old,[job.accountId]:{...next,readError:undefined}}:old);
        stillActive=!canApply||activeSync(next);
      }catch(e){if(!cancelled)setSyncJobs(old=>old[job.accountId]?.id===job.id&&!stopRequests.current.has(job.id)&&version===stopVersions.current.get(job.id)?{...old,[job.accountId]:{...old[job.accountId],readError:customerMessage(e)}}:old);}
      if(!cancelled&&stillActive){const timer=window.setTimeout(()=>{timers.delete(timer);void poll(job);},1000);timers.add(timer);}
    }
    for(const job of jobs)void poll(job);
    return()=>{cancelled=true;controller.abort();for(const timer of timers)window.clearTimeout(timer);};
  },[activeKey]);
  const syncRefreshNeeded=useRef(false);
  useEffect(()=>{
    if(!syncing&&!syncRefreshNeeded.current)return;syncRefreshNeeded.current=syncing;
    const controller=new AbortController();let cancelled=false,timer:number|undefined;
    async function refreshSaved(){
      try{const value=await request('operations',undefined,controller.signal);if(!cancelled)setData(value);}
      catch(e){if(!cancelled)setError(customerMessage(e));}
      if(!cancelled&&syncing)timer=window.setTimeout(refreshSaved,4000);
    }
    void refreshSaved();return()=>{cancelled=true;controller.abort();window.clearTimeout(timer);};
  },[activeKey]);
  useEffect(()=>{const viewport=document.querySelector('.customer-shell .page');if(viewport)viewport.scrollTop=0;},[page]);
  const publishVisited=useRef(false);if(page==='发布中心')publishVisited.current=true;
  const accounts=data?.accounts??[];const scopedNotes=(data?.notes??[]).filter(n=>scope==='all'||n.accountId===scope);const filteredNotes=scopedNotes.filter(n=>n.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));const pageSize=12;const notes=filteredNotes.slice((contentPage-1)*pageSize,contentPage*pageSize);const comments=(data?.comments??[]).filter(c=>scope==='all'||c.accountId===scope);const leads=(data?.leads??[]).filter(l=>scope==='all'||l.accountId===scope);
  const visibleAccounts=accounts.filter(a=>scope==='all'||a.id===scope);
  useEffect(()=>{setSelectedAccounts([]);setSelectedNotes([]);setSelectedLeads([]);},[scope,query]);
  useEffect(()=>{setContentPage(p=>Math.min(p,Math.max(1,Math.ceil(filteredNotes.length/pageSize))));},[filteredNotes.length]);
  useEffect(()=>{
    if(!data)return;
    setSelectedAccounts(ids=>ids.filter(id=>data.accounts.some(a=>a.id===id)));
    setSelectedNotes(ids=>ids.filter(id=>data.notes.some(n=>n.id===id)));
    setSelectedLeads(ids=>ids.filter(id=>data.leads.some(l=>l.id===id)));
    setDetail(old=>old?data.notes.find(n=>n.id===old.id)??null:null);
    setSyncJobs(old=>Object.fromEntries(Object.entries(old).filter(([id])=>data.accounts.some(a=>a.id===id))));
    if(scope!=='all'&&!data.accounts.some(a=>a.id===scope))setScope('all');
  },[data]);
  const name=(id:string)=>accounts.find(a=>a.id===id)?.name??id;
  const messages=(data?.messages??[]).filter(m=>scope==='all'||m.accountId===scope);
  return <div className="app-shell customer-shell"><aside className="sidebar"><div className="brand">华科未来·矩阵云</div><nav>{sections.filter(s=>!readOnly||s==='线索中心').map(s=><button className={'nav-item '+(page===s?'active':'')} key={s} aria-current={page===s?'page':undefined} onClick={()=>{setPage(s);setQuery('');}}>{s}</button>)}</nav><div className="sidebar-bottom"><PersonalMenu username={username} onProfile={()=>setPage("个人中心")} onSettings={()=>setPage("连接设置")} onLogout={logout} onSwitchAccount={switchAccount}/></div></aside><main className="workspace"><header className="topbar"><h1>{page}</h1><div className="workspace-actions"><span>{username}</span><button className="ghost" disabled={readOnly||busy||syncing||loginPending||!data} onClick={()=>void syncAllAndRefresh()}>{busy||syncing?'同步进行中…':'同步最新数据'}</button><button className="ghost" onClick={()=>{void logout().catch(()=>setError('退出失败，请重试'));}}>退出登录</button></div></header><div className="page">{!readOnly&&<EventSync request={request} onDataChanged={refreshQuiet} accounts={accounts}/>} {newDataNotice&&<div className="sync-notice" role="status"><span>{newDataNotice}</span><button className="ghost" onClick={()=>setNewDataNotice("")}>知道了</button></div>}{Object.values(syncJobs).map(job=><div role="status" className={`sync-notice ${job.status}`} key={job.id}><span><strong>{data?.accounts.find(a=>a.id===job.accountId)?.name??'账号'}</strong>{syncSummary(job)}</span>{(job.status==='running'||job?.status==='queued')&&<button className="ghost" onClick={()=>void stopSync(job)}>停止</button>}</div>)}{error&&<p role="alert" className="warning">{error}</p>}{!data?<section className="grey-panel" role="status"><h2>{error?'数据读取失败':'正在读取你的内容…'}</h2>{error&&<button className="ghost" onClick={()=>void refresh()}>重新加载内容</button>}</section>:<><div className="toolbar"><select aria-label="账号范围" value={scope} onChange={e=>{setScope(e.target.value);setContentPage(1);}}><option value="all">全部真实账号（{accounts.length}）</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name} · {a.handle}</option>)}</select></div>
  {page==='经营概览'&&<Overview accounts={accounts.filter(a=>scope==='all'||a.id===scope)} notes={scopedNotes} comments={comments} leads={leads} onNavigate={setPage} onAccount={id=>{setScope(id);setQuery('');setPage('内容管理');}}/>}
  {page==='账号矩阵'&&<>{setupNonce&&<ConnectorAuthorize nonce={setupNonce} request={request}/>}<ConnectorPairingPanel request={request} manageDevices={data.role!=='operator'} onChanged={()=>void refresh()}/><XhsQrLogin accounts={accounts} request={request} externalJob={loginJob} onDone={job=>void loginComplete(job)} onStopped={loginStopped}/><div className="library-heading"><label><input type="checkbox" aria-label="全选账号" checked={visibleAccounts.length>0&&visibleAccounts.every(a=>selectedAccounts.includes(a.id))} onChange={e=>setSelectedAccounts(e.target.checked?visibleAccounts.map(a=>a.id):[])}/> 全选账号</label><button className="danger" disabled={busy||!selectedAccounts.length} onClick={()=>void deleteAccounts()}>批量删除账号（{selectedAccounts.length}）</button></div><button className="primary" disabled={busy||syncing||loginPending} onClick={()=>void syncAllAndRefresh()}>{busy||syncing?'正在同步全部账号…':'同步全部账号'}</button>{accounts.filter(a=>scope==='all'||a.id===scope).map(a=>{const job=syncJobs[a.id];const available=a.profile.startsWith('local:')&&!!a.executionDevice?.online;return <section className="account-card" key={a.id}><div><label><input type="checkbox" aria-label={`选择账号 ${a.name}`} checked={selectedAccounts.includes(a.id)} onChange={e=>setSelectedAccounts(ids=>e.target.checked?[...new Set([...ids,a.id])]:ids.filter(id=>id!==a.id))}/> 选择账号</label><h3>{a.name}</h3><AccountSafety id={a.id} request={request}/><p>{a.handle} · {a.followers} 粉丝 · {available?'已连接':a.executionDevice?'执行电脑离线':'需要重新连接'}</p><p>账号执行电脑：{a.executionDevice?`${a.executionDevice.name} · ${a.executionDevice.online?'在线':'离线'}`:'尚未连接'}；换电脑时点击同步并重新登录。</p><p>最近同步：{displayDate(a.lastSyncedAt)}</p>{!available&&<p role="alert" className="warning">{a.executionDevice&&!a.executionDevice.online?'请先在执行电脑启动连接器；换电脑时需选择新电脑并重新登录。':'此账号需要重新扫码连接。'}</p>}{job&&<p role="status" className="media-caption">{syncSummary(job)}</p>}</div><div className="card-actions"><button className="ghost" disabled={busy||loginPending||activeSync(job)} onClick={()=>void syncAccount(a.id)}>{activeSync(job)?'同步中…':available?'开始同步':'重新连接'}</button><button className="ghost" onClick={()=>{setScope(a.id);setQuery('');setPage('内容管理');}}>查看内容</button><button className="danger" disabled={busy} onClick={()=>void deleteAccount(a)}>删除账号</button></div></section>})}</>}
  {page==='内容管理'&&<><div className="library-heading"><div><p>浏览已同步的笔记，查看封面、正文、视频和图文翻页。</p><button className="danger" disabled={busy||!selectedNotes.length} onClick={()=>void deleteSelectedNotes()}>批量删除内容（{selectedNotes.length}）</button><button className="danger" disabled={busy||!filteredNotes.length} onClick={()=>void clearHistory()}>清空{scope==='all'?'全部':'当前账号'}历史内容</button></div><input aria-label="搜索内容" placeholder="搜索笔记标题" value={query} onChange={e=>{setQuery(e.target.value);setContentPage(1)}}/></div><label><input type="checkbox" aria-label="全选当前内容" checked={filteredNotes.length>0&&filteredNotes.every(n=>selectedNotes.includes(n.id))} onChange={e=>setSelectedNotes(e.target.checked?[...new Set([...selectedNotes,...filteredNotes.map(n=>n.id)])]:selectedNotes.filter(id=>!filteredNotes.some(n=>n.id===id)))}/> 全选</label><div className="library-grid">{notes.map(n=><div key={n.id}><label><input type="checkbox" aria-label={`选择内容 ${n.title}`} checked={selectedNotes.includes(n.id)} onChange={e=>setSelectedNotes(ids=>e.target.checked?[...new Set([...ids,n.id])]:ids.filter(id=>id!==n.id))}/></label><NoteCard key={n.id} note={n} account={name(n.accountId)} onOpen={()=>setDetail(n)} onDelete={()=>void deleteNote(n)}/></div>)}</div>{filteredNotes.length>pageSize&&<div className="pager"><button className="ghost" disabled={contentPage===1} onClick={()=>setContentPage(p=>p-1)}>上一页</button><span>第 {contentPage} / {Math.ceil(filteredNotes.length/pageSize)} 页 · 共 {filteredNotes.length} 篇</span><button className="ghost" disabled={contentPage>=Math.ceil(filteredNotes.length/pageSize)} onClick={()=>setContentPage(p=>p+1)}>下一页</button></div>}{!notes.length&&<div className="grey-panel"><h2>{query?'没有找到匹配笔记':'还没有同步内容'}</h2><p>{query?'换个关键词试试。':'完成账号同步后，笔记会显示在这里。'}</p></div>}</>}
  {page==='互动管理'&&<>{comments.map(c=><section className="grey-panel interaction-card" key={c.id}><h3>{c.author}</h3><p>{c.body}</p><p className="media-caption">{name(c.accountId)} · {displayDate(c.createdAt)}</p><button className="ghost" disabled={busy||c.status==='lead_created'} onClick={()=>mutate('leads',{commentId:c.id,level:'medium'})}>{c.status==='lead_created'?'已加入线索中心':'创建线索'}</button></section>)}{!comments.length&&<p className="empty">暂无已同步评论。</p>}</>}
  {page==='线索中心'&&<><div className="library-heading"><label><input type="checkbox" aria-label="全选线索" checked={leads.length>0&&selectedLeads.length===leads.length} onChange={e=>setSelectedLeads(e.target.checked?leads.map(l=>l.id):[])}/> 全选线索</label><button className="danger" disabled={readOnly||busy||!selectedLeads.length} onClick={()=>void deleteSelectedLeads()}>批量删除线索（{selectedLeads.length}）</button></div>{leads.map(l=><section className="grey-panel" key={l.id}><label><input type="checkbox" aria-label={`选择线索 ${l.id}`} checked={selectedLeads.includes(l.id)} onChange={e=>setSelectedLeads(ids=>e.target.checked?[...new Set([...ids,l.id])]:ids.filter(id=>id!==l.id))}/></label><h3>{comments.find(c=>c.id===l.sourceCommentId)?.author??l.id}</h3><p>{name(l.accountId)} · {l.status}</p>{l.followUps.map(f=><p key={f.id}>{f.body} · {f.createdAt}<button className="danger" disabled={readOnly||busy} onClick={()=>{if(window.confirm("删除这条跟进记录？无法撤销。"))void mutate(`follow-ups/${encodeURIComponent(f.id)}/delete`,{});}}>删除跟进</button></p>)}<label>跟进记录<input aria-label={`跟进 ${l.id}`} disabled={readOnly} value={follow[l.id]??''} onChange={e=>setFollow(old=>({...old,[l.id]:e.target.value}))} placeholder="填写这条线索的实际沟通情况"/></label><button className="ghost" disabled={readOnly||busy||!follow[l.id]?.trim()} onClick={async()=>{if(await mutate('leads/'+l.id+'/follow-ups',{body:follow[l.id].trim()}))setFollow(old=>({...old,[l.id]:''}));}}>保存跟进</button><button className="danger" disabled={readOnly||busy} onClick={()=>void deleteLead(l.id)}>删除线索</button></section>)}{!leads.length&&<p className="empty">从真实评论创建第一条线索。</p>}</>}
  {publishVisited.current&&<div hidden={page!=='发布中心'}><PublishCenter onManageAccounts={()=>setPage('账号矩阵')} visible={page==='发布中心'} accounts={accounts} request={request}/></div>}
  {page==='互动管理'&&<section className="grey-panel"><h2>私信 · 已收录 {messages.length} 条</h2><p className="media-caption">按账号和会话整理，仅显示已授权采集的真实消息。</p>{messageThreads(messages).map(thread=>{const items=thread.items;return <details className="message-thread" key={thread.key} open><summary>{thread.label} · {name(thread.accountId)} · {items.length} 条</summary>{items.map(m=><article className="private-message" key={m.accountId+':'+m.id}><strong>{m.direction==='outgoing'?'我 → ':''}{m.author}</strong><p>{m.body}</p><small>{m.createdAt}</small></article>)}</details>})}{!messages.length&&<p>尚未同步私信，不代表小红书没有私信。</p>}</section>}
  {page==='连接设置'&&<ModelSettings request={request}/>}
  {page==='个人中心'&&<PersonalCenter request={request}/>}
  {page==='账号矩阵'&&!accounts.length&&<section className="grey-panel"><h2>当前工作区暂无已授权账号</h2><p>历史账号不会跨客户工作区自动显示。请确认登录的是原工作区，或点击上方添加账号并完成登录。</p></section>}
  {!accounts.length&&page!=='连接设置'&&<section className="grey-panel"><h2>当前工作区暂无账号</h2><p>完成账号授权后，这里会显示该工作区的真实内容和运营数据。</p></section>}
  </>}{detail&&<NoteDetail note={detail} account={name(detail.accountId)} comments={data?.comments??[]} onClose={()=>setDetail(null)}/>}</div></main></div>;
}
