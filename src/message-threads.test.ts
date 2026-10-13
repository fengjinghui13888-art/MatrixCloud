import {messageThreads} from './message-threads';
test('same peer on different matrix accounts stays in separate conversations',()=>{
 const m={id:'m',conversationId:'peer',author:'Reader',body:'Hi',createdAt:'2025-01-01',direction:'incoming' as const};
 const result=messageThreads([{...m,accountId:'a'},{...m,accountId:'b'}]);
 expect(result).toHaveLength(2);expect(result[0].items.map(m=>m.accountId)).toEqual(['a']);
});
