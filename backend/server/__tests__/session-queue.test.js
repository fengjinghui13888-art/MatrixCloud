import {createSessionQueue} from '../../../local-connector/session-queue.mjs';
test('same account serializes while another account can progress; errors release queue',async()=>{
 const queue=createSessionQueue();let release;const events=[];
 const first=queue('a',()=>new Promise(r=>{release=r;events.push('first');}));
 const second=queue('a',()=>events.push('second'));
 await queue('b',()=>events.push('other'));expect(events).toEqual(['first','other']);release();await first;await second;
 await expect(queue('a',()=>{throw Error('offline');})).rejects.toThrow('offline');
 await queue('a',()=>events.push('recovered'));expect(events).toEqual(['first','other','second','recovered']);
});
