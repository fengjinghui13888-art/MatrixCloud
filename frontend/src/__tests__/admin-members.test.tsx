import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {AdminMembers} from '../../admin/AdminMembers';
import {AdminApp} from '../../admin/AdminApp';

test('super administrator creates a named account with explicit permissions',async()=>{
 const writes:any[]=[];
 const request=vi.fn(async(path,body)=>{if(body){writes.push({path,body});return {ok:true};}return {items:[],superAdmin:'root'};});
 render(<AdminMembers request={request} onChanged={async()=>{}}/>);
 await screen.findByText('root');fireEvent.click(screen.getByRole('button',{name:'新增子管理员'}));
 fireEvent.change(screen.getByLabelText('登录账号'),{target:{value:'support1'}});
 fireEvent.change(screen.getByLabelText('姓名或备注'),{target:{value:'客服一号'}});
 fireEvent.change(screen.getByLabelText('初始密码'),{target:{value:'synthetic-password'}});
 fireEvent.change(screen.getByRole('combobox',{name:'权限模板'}),{target:{value:'客户支持'}});
 fireEvent.click(screen.getByRole('button',{name:'保存管理员'}));
 await waitFor(()=>expect(writes).toEqual([{path:'admins',body:{username:'support1',displayName:'客服一号',password:'synthetic-password',permissions:['customers.read','customers.recovery','devices.read']}}]));
 expect(screen.queryByLabelText('初始密码')).not.toBeInTheDocument();
});

test('three existing accounts disable creating a fourth even if stopped',async()=>{
 const request=async()=>({items:[1,2,3].map(i=>({username:'assistant'+i,displayName:'成员'+i,enabled:false,permissions:[]})),superAdmin:'root'});
 render(<AdminMembers request={request} onChanged={async()=>{}}/>);
 await screen.findByText('已创建 3 / 3');expect(screen.getByRole('button',{name:'新增子管理员'})).toBeDisabled();
});

test('read-only delegate only loads allowed data and has no privileged actions',async()=>{
 const routes:string[]=[];const customer={id:'customer',name:'合成客户',enabled:true,createdAt:'2026-10-15T00:00:00Z',counts:{accounts:1,notes:2,leads:3,tasks:0},members:[{username:'fixture',displayName:'测试成员',role:'admin',enabled:true}],devices:[]};
 vi.stubGlobal('fetch',vi.fn(async(path)=>{const route=String(path).split('/api/platform-admin/')[1];routes.push(route);return new Response(JSON.stringify(route==='session'?{username:'viewer',isSuper:false,permissions:['customers.read']}:{items:[customer]}));}));
 render(<AdminApp/>);await screen.findByText('合成客户');
 expect(screen.queryByRole('button',{name:/管理员管理/})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:/操作日志/})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:/客户管理/}));fireEvent.click(screen.getByRole('button',{name:'管理 →'}));
 expect(screen.queryByRole('button',{name:'停用客户'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'签发密码恢复码'})).not.toBeInTheDocument();
 expect(routes).toEqual(['session','customers']);
});
