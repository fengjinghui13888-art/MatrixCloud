import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {test,expect,vi} from 'vitest';
import {StudioPublishActions} from '../StudioPublishActions';

test('defaults only to content owner and lets customer choose another account or none',async()=>{
 const accounts=['moya','h'].map(id=>({id,name:id,handle:id,profile:`local:${id}`,avatar:'',state:'connected' as const,followers:0,lastSyncedAt:''}));
 const dispatch=vi.fn().mockResolvedValue(undefined);
 render(<StudioPublishActions task={{status:'review',accountId:'h',message:''}} accounts={accounts} busy={false} dirty={false} onAction={vi.fn()} onDispatch={dispatch}/>);
 expect(screen.getByRole('checkbox',{name:'保存到 h'})).toBeChecked();
 expect(screen.getByRole('checkbox',{name:'保存到 moya'})).not.toBeChecked();
 fireEvent.click(screen.getByRole('button',{name:'保存到小红书草稿'}));
 await waitFor(()=>expect(dispatch).toHaveBeenCalledWith(['h']));
 fireEvent.click(screen.getByRole('checkbox',{name:'保存到 h'}));
 expect(screen.getByRole('button',{name:'保存到小红书草稿'})).toBeDisabled();
 fireEvent.click(screen.getByRole('checkbox',{name:'保存到 moya'}));
 fireEvent.click(screen.getByRole('button',{name:'保存到小红书草稿'}));
 await waitFor(()=>expect(dispatch).toHaveBeenLastCalledWith(['moya']));
});

test('waiting for the same account sync exposes cancellation and never dispatches again',async()=>{
 const action=vi.fn().mockResolvedValue(undefined),dispatch=vi.fn();
 render(<StudioPublishActions task={{status:'approved',accountId:'h',message:'',waitingForSync:true}} accounts={[]} busy={false} dirty={false} onAction={action} onDispatch={dispatch}/>);
 expect(screen.getByText(/同步结束后自动打开草稿窗口/)).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'保存到小红书草稿'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'停止保存草稿'}));
 await waitFor(()=>expect(action).toHaveBeenCalledWith('cancel',{}));
 expect(dispatch).not.toHaveBeenCalled();
});

test('rejected copy is approved explicitly before retrying its original account',async()=>{
 const action=vi.fn().mockResolvedValue(undefined);
 render(<StudioPublishActions task={{status:'rejected',accountId:'h',message:''}} accounts={[]} busy={false} dirty={false} onAction={action} onDispatch={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'保存到小红书草稿'}));
 await waitFor(()=>expect(action).toHaveBeenCalledWith('review',{decision:'approve'}));
});
