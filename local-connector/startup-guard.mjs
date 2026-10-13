export async function inspectExistingConnector({port=47821,fetcher=fetch}={}){
  try{
    const response=await fetcher(`http://127.0.0.1:${port}/verify`,{method:'GET',signal:AbortSignal.timeout(1500)});
    const value=await response.json().catch(()=>({}));
    if(!response.ok)return {kind:'rejected',status:response.status,value};
    return {kind:'connected',status:response.status,value};
  }catch(error){
    return {kind:'unreachable',error};
  }
}

export function existingConnectorMessage(status){
  if(status?.kind==='connected'){
    const capabilities=Array.isArray(status.value?.capabilities)?status.value.capabilities:[];
    if(!capabilities.includes('reconnect'))return '检测到旧版连接器正在运行，请关闭旧连接器窗口后重新启动最新入口。';
    return '已有最新版连接器正在运行，本次操作已转交给它。';
  }
  if(status?.kind==='rejected')return `已有连接器正在运行，但拒绝状态检查（HTTP ${status.status}）。请关闭旧连接器后重试。`;
  return '连接器端口已被占用，但无法确认占用进程。请关闭旧连接器窗口后重试。';
}
