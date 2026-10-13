import {render,screen,act,fireEvent} from '@testing-library/react';
import {XhsQrLogin} from '../XhsQrLogin';
test('status polling tells the customer which browser page to scan without copying QR images into the workbench',async()=>{
 vi.useFakeTimers();let stage='creator';
 const request=vi.fn(async(path:string)=>path==='xhs/qr-login'?{id:'scan-two',status:'waiting_scan',stage,message:stage==='web'?'请继续扫码登录小红书网页版':'请扫描创作平台二维码'}:{id:'scan-two',status:'waiting_scan',stage,message:stage==='web'?'请继续扫码登录小红书网页版':'请扫描创作平台二维码'});
 try{
  render(<XhsQrLogin request={request} onDone={()=>{}}/>);
  await act(async()=>{});
  expect(screen.getByText('请在弹出的浏览器中扫码')).toBeInTheDocument();
  expect(screen.getByText('创作服务平台已经打开，请使用小红书 App 扫码登录。')).toBeInTheDocument();
  expect(request).not.toHaveBeenCalledWith(expect.stringContaining('/image'),expect.anything());
  await act(async()=>{await vi.advanceTimersByTimeAsync(4000);});
  stage='web';await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
  expect(screen.getByText('小红书网页版已经打开，请使用小红书 App 扫码登录。')).toBeInTheDocument();
 }finally{vi.useRealTimers();}
});

test('deleting the selected account returns the login form to add-account mode',async()=>{
 const request=vi.fn(async(path:string)=>path==='xhs/qr-login'?null:null);
 const view=render(<XhsQrLogin request={request} onDone={()=>{}} accounts={[{id:'deleted',name:'旧账号',handle:'old',profile:'local:old',avatar:'',state:'connected',followers:0,lastSyncedAt:''}]}/>);
 await act(async()=>{});request.mockClear();
 fireEvent.change(screen.getByLabelText('扫码目标账号'),{target:{value:'deleted'}});
 view.rerender(<XhsQrLogin request={request} onDone={()=>{}} accounts={[]}/>);
 await act(async()=>{});
 expect(screen.getByLabelText('扫码目标账号')).toHaveValue('');
 expect(screen.getByRole('button',{name:'打开浏览器并添加账号'})).toBeEnabled();
 fireEvent.click(screen.getByRole('button',{name:'打开浏览器并添加账号'}));
 await act(async()=>{});
 expect(request).toHaveBeenCalledWith('xhs/qr-login',{});
});
