import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {EventSync} from '../EventSync';

afterEach(()=>{cleanup();vi.useRealTimers();});

test('shows event mode and sends the enable choice',async()=>{
 const request=vi.fn(async(path:string,body?:unknown)=>body?{enabled:(body as {enabled:boolean}).enabled,mode:'event',accounts:[]}:{enabled:false,mode:'event',accounts:[]});
 render(<EventSync request={request}/>);
 expect(await screen.findByText('发现变化后自动同步')).toBeInTheDocument();
 const toggle=screen.getByRole('checkbox',{name:'发现变化后自动同步'});
 expect(toggle).not.toBeChecked();
 await act(async()=>fireEvent.click(toggle));
 expect(request).toHaveBeenCalledWith('event-sync',{enabled:true});
 expect(screen.getByText(/只在检测到/)).toBeInTheDocument();
});

test('keeps reading cloud status after enabling and refreshes only after a confirmed completion',async()=>{
 vi.useFakeTimers();let enabled=false,finished=false;const reads:string[]=[];let refreshed=0;
 const request=async(path:string,body?:unknown)=>{reads.push(path);if(body)enabled=(body as {enabled:boolean}).enabled;return {enabled,mode:'event',accounts:[{accountId:'a',status:finished?'idle':'running',lastSyncedAt:finished?'2026-10-13T00:00:00Z':undefined}]};};
 render(<EventSync request={request} onDataChanged={()=>{refreshed++;}} accounts={[{id:'a',name:'我的账号'}]}/>);
 await act(async()=>{});await act(async()=>fireEvent.click(screen.getByRole('checkbox',{name:'发现变化后自动同步'})));
 await act(async()=>{await vi.advanceTimersByTimeAsync(3100);});expect(refreshed).toBe(0);
 finished=true;await act(async()=>{await vi.advanceTimersByTimeAsync(3100);});expect(refreshed).toBe(1);
 expect(reads.every(path=>path==='event-sync')).toBe(true);expect(screen.getByText('我的账号')).toBeInTheDocument();
 cleanup();const before=reads.length;await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});expect(reads).toHaveLength(before);
});
