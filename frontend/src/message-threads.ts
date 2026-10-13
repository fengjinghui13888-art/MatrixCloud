import type {DirectMessage} from '../../shared/domain';
export function messageThreads(messages:DirectMessage[]){
 const groups=new Map<string,DirectMessage[]>();
 for(const m of messages){const key=JSON.stringify([m.accountId,m.conversationId]);const group=groups.get(key)??[];group.push(m);groups.set(key,group);}
 return [...groups.entries()].map(([key,items])=>({key,accountId:items[0].accountId,label:items.find(m=>m.direction==='incoming')?.author||items[0].conversationId,items:items.sort((a,b)=>a.createdAt.localeCompare(b.createdAt))}));
}
