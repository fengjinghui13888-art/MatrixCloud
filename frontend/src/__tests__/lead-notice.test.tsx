import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {LeadNotice} from '../LeadNotice';
test('new lead pops a notice once and opens the follow-up inbox',async()=>{
 let ids=['old'];const request=vi.fn(async()=>({ids,waiting:ids.length})),open=vi.fn(),refresh=vi.fn(async()=>{});
 render(<LeadNotice request={request} onOpen={open} onRefresh={refresh}/>);
 await screen.findByText('待跟进线索 1 条');expect(screen.queryByRole('alertdialog')).toBeNull();
 ids=['new','old'];
 await waitFor(()=>expect(screen.getByRole('alertdialog',{name:'新线索提醒'})).toBeInTheDocument(),{timeout:4000});
 expect(refresh).toHaveBeenCalledTimes(1);fireEvent.click(screen.getByRole('button',{name:'立即查看'}));expect(open).toHaveBeenCalledTimes(1);
 expect(screen.queryByRole('alertdialog')).toBeNull();
});
