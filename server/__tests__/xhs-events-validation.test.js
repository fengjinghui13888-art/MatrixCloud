import {validXhsEvent,validXhsSubscriptions} from '../../shared/xhs-events.mjs';
const event={eventId:'11111111-1111-4111-8111-111111111111',profile:'local:p',kind:'messages',fingerprint:'a'.repeat(64)};
test('accepts only the bounded event metadata contract',()=>{
 expect(validXhsEvent(event)).toBe(true);
 expect(validXhsEvent({...event,eventId:[event.eventId]})).toBe(false);
 expect(validXhsEvent({...event,cookie:'private'})).toBe(false);
});
test('bounds and validates subscribed account baselines',()=>{
 const item={profile:'local:p',accountId:'a',handle:'h',knownNotes:[],knownComments:[],knownMessages:[]};
 expect(validXhsSubscriptions([item])).toBe(true);
 expect(validXhsSubscriptions([{...item,knownMessages:['x'.repeat(1024)]}])).toBe(false);
 expect(validXhsSubscriptions(Array(101).fill(item))).toBe(false);
});
