import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {AdminAccount,AdminAccountMenu} from '../../admin/AdminAccount';

test('avatar opens profile and settings, dismisses outside and Escape, and logs out',()=>{
 const open=vi.fn(),logout=vi.fn();render(<AdminAccountMenu user="matrix-admin" isSuper disabled={false} onOpen={open} onLogout={logout}/>);
 const trigger=screen.getByRole('button',{name:'管理员账号菜单'});
 fireEvent.click(trigger);expect(trigger).toHaveAttribute('aria-expanded','true');
 fireEvent.click(screen.getByRole('button',{name:'个人中心'}));expect(open).toHaveBeenCalledWith('个人中心');expect(trigger).toHaveAttribute('aria-expanded','false');
 fireEvent.click(trigger);fireEvent.keyDown(document,{key:'Escape'});expect(trigger).toHaveFocus();expect(trigger).toHaveAttribute('aria-expanded','false');
 fireEvent.click(trigger);fireEvent.pointerDown(document.body);expect(trigger).toHaveAttribute('aria-expanded','false');
 fireEvent.click(trigger);fireEvent.click(screen.getByRole('button',{name:'账号设置'}));expect(open).toHaveBeenCalledWith('账号设置');
 fireEvent.click(trigger);fireEvent.click(screen.getByRole('button',{name:'退出登录'}));expect(logout).toHaveBeenCalledOnce();
});
test('settings validates confirmation and submits only current account password fields',async()=>{
 const request=vi.fn().mockResolvedValue({ok:true}),done=vi.fn();render(<AdminAccount page="账号设置" user="delegate" isSuper={false} permissions={[]} request={request} onPasswordChanged={done}/>);
 fireEvent.change(screen.getByLabelText('当前密码'),{target:{value:'synthetic-old-password'}});fireEvent.change(screen.getByLabelText('新密码'),{target:{value:'synthetic-new-password'}});fireEvent.change(screen.getByLabelText('确认新密码'),{target:{value:'synthetic-mismatch'}});
 fireEvent.submit(screen.getByRole('button',{name:'保存新密码'}).closest('form')!);expect(screen.getByRole('alert')).toHaveTextContent('两次输入');expect(request).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('确认新密码'),{target:{value:'synthetic-new-password'}});fireEvent.submit(screen.getByRole('button',{name:'保存新密码'}).closest('form')!);
 await waitFor(()=>expect(done).toHaveBeenCalledOnce());expect(request).toHaveBeenCalledWith('account/password',{currentPassword:'synthetic-old-password',newPassword:'synthetic-new-password'});
});
test('profile displays delegated permissions without editing them',()=>{
 render(<AdminAccount page="个人中心" user="delegate" isSuper={false} permissions={['customers.read']} request={vi.fn()} onPasswordChanged={vi.fn()}/>);
 expect(screen.getByText('查看客户')).toBeInTheDocument();expect(screen.queryByText('管理子管理员')).not.toBeInTheDocument();expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});
