const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const profile=/^local:[\w-]{1,100}$/;
const fingerprint=/^[a-f0-9]{64}$/;
const kinds=new Set(['notes','comments','messages']);
export function validXhsEvent(event){
  return !!event&&typeof event==='object'&&!Array.isArray(event)&&Object.keys(event).every(k=>['eventId','profile','kind','fingerprint'].includes(k))&&typeof event.eventId==='string'&&uuid.test(event.eventId)&&typeof event.profile==='string'&&profile.test(event.profile)&&typeof event.kind==='string'&&kinds.has(event.kind)&&typeof event.fingerprint==='string'&&fingerprint.test(event.fingerprint);
}
export function validXhsSubscriptions(items){
  const text=v=>typeof v==='string'&&v.length>0&&v.length<=256;
  return Array.isArray(items)&&items.length<=100&&items.every(item=>item&&typeof item==='object'&&!Array.isArray(item)&&typeof item.profile==='string'&&profile.test(item.profile)&&text(item.accountId)&&text(item.handle)&&(item.enabled===undefined||typeof item.enabled==='boolean')&&['knownNotes','knownComments','knownMessages'].every(k=>Array.isArray(item[k])&&item[k].length<=10000&&item[k].every(text)));
}
