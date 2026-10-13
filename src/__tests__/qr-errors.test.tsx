import {act,render,screen} from '@testing-library/react';
import {XhsQrLogin} from '../XhsQrLogin';
test('browser scan flow does not request or render a dashboard QR image',async()=>{
 const request=vi.fn(async(path:string)=>path==='xhs/qr-login'?{id:'scan',status:'waiting_scan',stage:'web',message:'等待扫码'}:{id:'scan',status:'waiting_scan',stage:'web',message:'等待扫码'});
 render(<XhsQrLogin request={request} onDone={()=>{}}/>);await act(async()=>{});
 expect(screen.getByText('请在弹出的浏览器中扫码')).toBeInTheDocument();
 expect(screen.getByText('小红书网页版已经打开，请使用小红书 App 扫码登录。')).toBeInTheDocument();
 expect(screen.queryByRole('img')).not.toBeInTheDocument();
 expect(request.mock.calls.some(([path])=>String(path).includes('/image'))).toBe(false);
});
