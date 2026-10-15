import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {AdminApp} from '../../admin/AdminApp';

const customer={id:'customer-id',name:'合成客户',enabled:true,createdAt:'2026-10-15T00:00:00Z',members:[{username:'fixture',displayName:'合成成员',role:'admin',enabled:true}],counts:{accounts:1,notes:2,leads:3,tasks:4},devices:[{id:'dev',name:'合成电脑',platform:'win32',version:'4',online:true,revoked:false,lastSeenAt:'2026-10-15T00:00:00Z'}]};
test('independent admin login loads customers, filters, devices and scoped recovery',async()=>{
 let logged=false;const writes:any[]=[];
 vi.stubGlobal('fetch',vi.fn(async(path,init)=>{
  const route=String(path).replace('/api/platform-admin/','');
  if(route==='session'&&!logged)return new Response('{"message":"请登录"}',{status:401});
  if(route==='login'){writes.push({route,body:JSON.parse(init.body)});logged=true;return new Response(JSON.stringify({username:'platform',isSuper:true,permissions:['customers.read','customers.status','customers.recovery','devices.read','audit.read']}));}
  if(route==='customers')return new Response(JSON.stringify({items:[customer]}));
  if(route==='devices')return new Response(JSON.stringify({items:customer.devices.map(d=>({...d,customer:customer.name}))}));
  if(route==='audit')return new Response('{"items":[]}');
  if(route.endsWith('/recovery')){writes.push({route,body:JSON.parse(init.body)});return new Response(JSON.stringify({username:'fixture',code:'synthetic-recovery',expiresAt:Date.now()+900000}));}
  return new Response('{}');
 }));
 render(<AdminApp/>);await screen.findByRole('heading',{name:'登录管理后台'});
 fireEvent.change(screen.getByLabelText('管理员账号'),{target:{value:'platform'}});fireEvent.change(screen.getByLabelText('密码'),{target:{value:'synthetic-password'}});fireEvent.click(screen.getByRole('button',{name:'登录管理后台'}));
 await screen.findByText('合成客户');fireEvent.click(screen.getByRole('button',{name:/02.*客户管理/}));
 fireEvent.change(screen.getByLabelText('搜索客户'),{target:{value:'nobody'}});expect(screen.getByText('没有符合条件的客户')).toBeInTheDocument();
 fireEvent.change(screen.getByLabelText('搜索客户'),{target:{value:'fixture'}});fireEvent.click(screen.getByRole('button',{name:'管理 →'}));
 fireEvent.click(screen.getByRole('button',{name:'签发密码恢复码'}));
 expect(await screen.findByLabelText('密码恢复码')).toHaveValue('synthetic-recovery');
 expect(writes.at(-1)).toEqual({route:'customers/customer-id/recovery',body:{username:'fixture'}});
 fireEvent.click(screen.getByRole('button',{name:/03.*连接设备/}));expect(screen.queryByLabelText('密码恢复码')).not.toBeInTheDocument();expect(screen.getByText('合成电脑')).toBeInTheDocument();
});

test('rejected customer login stays at dedicated login screen',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"message":"管理员账号或密码不正确"}',{status:401})));
 render(<AdminApp/>);await screen.findByLabelText('管理员账号');
 fireEvent.change(screen.getByLabelText('管理员账号'),{target:{value:'customer'}});fireEvent.change(screen.getByLabelText('密码'),{target:{value:'synthetic-password'}});fireEvent.click(screen.getByRole('button',{name:'登录管理后台'}));
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('管理员账号或密码不正确'));
 expect(screen.queryByRole('navigation',{name:'后台导航'})).not.toBeInTheDocument();
});
