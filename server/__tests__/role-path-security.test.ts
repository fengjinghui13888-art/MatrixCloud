import {expect,it} from 'vitest';
import {roleAllows} from '../tenant-auth';
it('trailing slashes cannot bypass operator restrictions on executor callbacks',()=>{
 for(const endpoint of ['claim','progress','receipt']){
  expect(roleAllows('operator','POST',`/api/studio/task-id/${endpoint}/`)).toBe(false);
  expect(roleAllows('operator','POST',`/api/studio/task-id/${endpoint}//`)).toBe(false);
  expect(roleAllows('operator','POST',`/API/STUDIO/task-id/${endpoint.toUpperCase()}`)).toBe(false);
 }
 expect(roleAllows('operator','POST','/api/studio/task-id/review/')).toBe(true);
 expect(roleAllows('operator','POST','/API/MODELS/')).toBe(false);
 expect(roleAllows('operator','POST','/API/CONNECTOR/devices/id/revoke')).toBe(false);
});
