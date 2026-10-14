import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {ConnectorPairingPanel} from '../ConnectorPairingPanel';

const device={id:'mac',name:'我的 Mac',platform:'darwin',version:'4.0.0',online:true,executionReady:true,revoked:false};

test('offers a first-install client without describing it as a ZIP',async()=>{
 render(<ConnectorPairingPanel request={async path=>path==='connector/downloads'?{downloads:[{id:'windows',label:'Windows 客户端',filename:'windows.exe',bytes:1024,url:'/api/connector/client/installers/windows.exe',kind:'client'}]}:path==='connector/devices'?{devices:[]}:{secure:true}}/>);
 const link=await screen.findByRole('link',{name:/Windows 客户端 安装客户端/});
 expect(link).toHaveAttribute('href','/api/connector/client/installers/windows.exe');
 expect(screen.getByText(/普通网页更新无需重装客户端/)).toBeInTheDocument();
});
test('removes a revoked device immediately and ignores a stale in-flight device response',async()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
 let reads=0,finish:((v:any)=>void)|undefined;
 const onChanged=vi.fn();
 const request=vi.fn(async(path:string)=>{
  if(path==='connector/capabilities')return {secure:true};
  if(path==='connector/devices'){
   if(++reads===2)return new Promise(resolve=>{finish=resolve;});
   return {devices:[device],selectedDeviceId:device.id};
  }
  return {};
 });
 try{
  render(<ConnectorPairingPanel request={request} onChanged={onChanged}/>);
  await screen.findByText('我的 Mac');
  vi.useFakeTimers();await act(async()=>{vi.advanceTimersByTime(5000);});
  fireEvent.click(screen.getByRole('button',{name:'撤销'}));
  await act(async()=>{});
  expect(screen.queryByText('我的 Mac')).not.toBeInTheDocument();
  await act(async()=>finish?.({devices:[device],selectedDeviceId:device.id}));
  expect(screen.queryByText('我的 Mac')).not.toBeInTheDocument();
  expect(onChanged).toHaveBeenCalledTimes(1);
 }finally{vi.useRealTimers();confirm.mockRestore();}
});
test('keeps the device visible when revocation fails',async()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
 try{
  render(<ConnectorPairingPanel request={async path=>{
   if(path.endsWith('/revoke'))throw Error('网络中断，请重试');
   if(path==='connector/devices')return {devices:[device]};
   return {secure:true};
  }}/>);
  await screen.findByText('我的 Mac');fireEvent.click(screen.getByRole('button',{name:'撤销'}));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('网络中断'));
  expect(screen.getByText('我的 Mac')).toBeInTheDocument();
 }finally{confirm.mockRestore();}
});
