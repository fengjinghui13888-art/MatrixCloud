import {render,screen,fireEvent,act,cleanup} from '@testing-library/react';
import {vi,it,expect,afterEach} from 'vitest';
import {ConnectorPairingPanel} from './ConnectorPairingPanel';
afterEach(()=>{cleanup();vi.useRealTimers();});
it('keeps the code visible after polls and refreshes device execution state',async()=>{
 vi.useFakeTimers();let online=true;
 const request=vi.fn(async(path:string,body?:unknown)=>{
   if(path==='connector/capabilities')return {secure:true};
   if(path==='connector/devices')return {devices:[{id:'d',name:'我的电脑',platform:'darwin',version:'3.0.0',online,executionReady:online,revoked:false}]};
   if(path==='connector/pairings'&&body)return {id:'p',code:'12345678',status:'pending',expiresAt:Date.now()+300000};
   if(path==='connector/pairings/p')return {id:'p',status:'pending',expiresAt:Date.now()+300000};
 });
 render(<ConnectorPairingPanel request={request}/>);await act(async()=>{});
 fireEvent.click(screen.getByText('备用：生成一次性配对码'));await act(async()=>{});
 expect(screen.getByLabelText('一次性配对码')).toHaveValue('12345678');
 await act(async()=>{await vi.advanceTimersByTimeAsync(1600);});expect(screen.getByLabelText('一次性配对码')).toHaveValue('12345678');
 expect(screen.getByText(/任务通道已连接/)).toBeInTheDocument();online=false;
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(screen.getByText(/离线/)).toBeInTheDocument();
});
it('shows transport setup requirement and never silently creates a code over HTTP',async()=>{
 const request=vi.fn(async(path:string)=>path==='connector/devices'?{devices:[]}:{secure:false});
 render(<ConnectorPairingPanel request={request}/>);await act(async()=>{});expect(screen.getByText('备用：生成一次性配对码')).toBeDisabled();expect(screen.getByText(/当前地址尚未启用 HTTPS/)).toBeInTheDocument();
});
