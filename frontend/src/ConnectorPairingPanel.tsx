import {useEffect,useRef,useState} from 'react';
import './styles/connector-pairing.css';
import {customerMessage} from './customer-message';
import {readSessionValue,removeSessionValue} from './safe-storage';
import {copyText} from './safe-clipboard';
type Device={id:string;name:string;platform:string;version:string;online:boolean;executionReady:boolean;revoked:boolean};
type Pairing={id:string;code?:string;status:'pending'|'claimed'|'expired'|'cancelled';expiresAt:number};
type Download={id:string;label:string;filename:string;bytes:number;url:string;kind?:'client'};
type Props={request:(path:string,body?:unknown)=>Promise<any>;onChanged?:()=>void;manageDevices?:boolean};
export function ConnectorPairingPanel({request,onChanged,manageDevices=true}:Props){
 const requester=useRef(request);requester.current=request;
 const [pairing,setPairing]=useState<Pairing|null>(()=>{try{const saved=readSessionValue('matrix.pendingPairing');return saved?JSON.parse(saved):null;}catch{return null;}}),[devices,setDevices]=useState<Device[]>([]),[selected,setSelected]=useState('');
 const [secure,setSecure]=useState<boolean|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 const [downloads,setDownloads]=useState<Download[]>([]);
 const epoch=useRef(0),removed=useRef(new Set<string>()),acting=useRef(false);
 const applyDevices=(result:any)=>{const active=(result.devices??[]).filter((d:Device)=>!d.revoked&&!removed.current.has(d.id));setDevices(active);setSelected(active.some((d:Device)=>d.id===result.selectedDeviceId)?result.selectedDeviceId:'');};
 const refresh=async()=>{const version=epoch.current;const result=await requester.current('connector/devices');if(version===epoch.current)applyDevices(result);};
 useEffect(()=>{
   let cancelled=false,timer:ReturnType<typeof setTimeout>;
   const poll=async()=>{const version=epoch.current;try{
     const [state,capabilities]=await Promise.all([requester.current('connector/devices'),requester.current('connector/capabilities')]);
     if(cancelled)return;if(version===epoch.current&&!acting.current)applyDevices(state);setSecure(capabilities.secure);
   }catch(e){if(!cancelled&&version===epoch.current)setError(customerMessage(e,'暂时无法读取电脑连接状态'));}
   if(!cancelled)timer=setTimeout(poll,5000);};void poll();return()=>{cancelled=true;clearTimeout(timer);};
 },[]);
 useEffect(()=>{let cancelled=false;void requester.current('connector/downloads').then(value=>{if(!cancelled)setDownloads(value?.downloads??[]);}).catch(()=>{});return()=>{cancelled=true;};},[]);
 useEffect(()=>{
   if(!pairing?.id||pairing.status!=='pending')return;
   let cancelled=false,timer:ReturnType<typeof setTimeout>;const id=pairing.id;
   const poll=async()=>{try{const next=await requester.current('connector/pairings/'+id);if(cancelled)return;
     setPairing(old=>old?.id===id?{...old,...next}:old);
     if(next.status!=='pending')removeSessionValue('matrix.pendingPairing');
     if(next.status==='claimed'){await refresh();onChanged?.();setMessage('已将这台新配对电脑设为本浏览器的执行电脑，正在等待任务通道连接。');return;}
     if(next.status!=='pending')return;
   }catch(e){if(!cancelled)setError(e instanceof Error?e.message:'配对状态读取失败');}
   if(!cancelled)timer=setTimeout(poll,1500);};timer=setTimeout(poll,1000);return()=>{cancelled=true;clearTimeout(timer);};
 },[pairing?.id,pairing?.status]);
 async function action(fn:()=>Promise<void>){if(acting.current)return;acting.current=true;epoch.current++;setBusy(true);setError('');setMessage('');try{await fn();}catch(e){setError(customerMessage(e,'操作失败，请重试'));}finally{epoch.current++;acting.current=false;setBusy(false);}}
 async function revoke(id:string){await requester.current('connector/devices/'+id+'/revoke',{});removed.current.add(id);setDevices(old=>old.filter(d=>d.id!==id));setSelected(old=>old===id?'':old);setMessage('设备已撤销');onChanged?.();}
 async function copy(){if(await copyText(pairing?.code??'')){setMessage('配对码已复制');}else setError('复制失败，请选中配对码手动复制');}
 return <section className="grey-panel connector-pairing-panel" aria-label="本机连接器">
  <div className="creation-heading"><div><h2>连接你的电脑</h2><p>在每位团队成员的电脑启动连接器并授权连接，再在下方选择执行电脑。登录窗口、账号同步和草稿执行都在所选电脑完成。</p></div></div>
  <ol className="connector-setup-steps"><li>首次下载并安装与你的电脑匹配的矩阵云客户端。</li><li>启动后打开工作台，登录你的团队账号并点击“授权连接这台电脑”。</li><li>等待下方显示电脑已连接，再扫码添加小红书账号。</li></ol>
  {downloads.length>0&&<div className="pairing-actions connector-downloads">{downloads.map(item=><a className="ghost" key={item.id} href={item.url} download={item.filename}>{item.label} {item.kind==='client'?'安装客户端':'下载 ZIP'} · {Math.ceil(item.bytes/1024/1024)} MB</a>)}</div>}
  <p className="muted">普通网页更新无需重装客户端。客户端会自动检查更新，正在扫码、同步或保存草稿时等待任务结束再切换，启动失败会回退已验证版本。请保持客户端运行；执行任务时会自动打开 Chrome 或 Edge。工作台可用 Safari、Chrome、Edge 和 Firefox。换电脑后选择新电脑并重新登录平台。</p>
  {secure===false&&<p className="pairing-warning" role="status">当前地址尚未启用 HTTPS，暂不能配对新设备。请使用管理员提供的 HTTPS 地址。</p>}
  <div className="pairing-actions"><button className="ghost" disabled={busy} onClick={()=>void action(refresh)}>刷新连接状态</button><button className="primary" disabled={busy||secure!==true} onClick={()=>void action(async()=>{setPairing(await requester.current('connector/pairings',{}));})}>{busy?'处理中…':pairing?.status==='pending'?'重新生成配对码':'备用：生成一次性配对码'}</button></div>
  {pairing?.status==='pending'&&<div className="pairing-code"><label>在本机连接器中输入<input aria-label="一次性配对码" value={pairing.code??''} readOnly onFocus={e=>e.target.select()}/></label><p>5 分钟内有效，只能使用一次。</p><div className="pairing-actions"><button className="ghost" onClick={()=>void copy()}>复制配对码</button><button className="ghost" disabled={busy} onClick={()=>void action(async()=>{setPairing(await requester.current('connector/pairings/'+pairing.id+'/cancel',{}));})}>取消配对</button></div></div>}
  {pairing?.status==='expired'&&<p role="status">配对码已过期，请重新生成。</p>}
  {devices.length>0&&<ul className="connector-devices">{devices.map(d=><li className="connector-device" key={d.id}><div><strong>{d.name}</strong><p>{d.platform} · v{d.version} · {d.revoked?'已撤销':d.executionReady?'任务通道已连接':d.online?'已在线，任务通道未连接':'离线'}</p>{selected===d.id&&!d.revoked&&<small>本浏览器当前选择的执行电脑；旧账号将在验证新登录后转到这里</small>}</div><div className="pairing-actions"><button className="ghost" disabled={!manageDevices||busy||d.revoked} title={manageDevices?undefined:'请由团队管理员清理电脑缓存'} onClick={()=>void action(async()=>{const plan=await requester.current('connector/devices/'+d.id+'/cleanup',{});if(plan.status==='pending'){setMessage(plan.message);return;}const result=await requester.current('connector/devices/'+d.id+'/cleanup',{manifestId:plan.id});setMessage('已回收 '+result.reclaimedBytes+' 字节临时配图缓存；有效素材和登录状态已保留。');})}>清理临时缓存</button><button className="ghost" disabled={busy||d.revoked||!d.executionReady||selected===d.id} onClick={()=>void action(async()=>{await requester.current('connector/devices/'+d.id+'/select',{});await refresh();onChanged?.();})}>{selected===d.id?'当前执行电脑':'在这台电脑执行'}</button><button className="danger" title={manageDevices?undefined:'请由团队管理员撤销电脑'} disabled={!manageDevices||busy||d.revoked} onClick={()=>{if(window.confirm('撤销后，此电脑不能再接收任务。确认撤销？'))void action(async()=>{await revoke(d.id);});}}>撤销</button></div></li>)}</ul>}
  {!devices.length&&<p className="muted">尚未配对客户设备。已配对设备会显示在这里。</p>}
  {message&&<p role="status">{message}</p>}{error&&<p role="alert" className="login-error">{error}</p>}
 </section>;
}
