// @vitest-environment node
import {expect,it} from 'vitest';
import {roleAllows} from '../tenant-auth';
it('lets operators connect and select their computer without granting device administration',()=>{
 for(const path of ['/api/connector/pairings','/api/connector/pairings/pair-id/cancel','/api/connector/devices/device-id/select'])expect(roleAllows('operator','POST',path)).toBe(true);
 for(const path of ['/api/connector/devices/device-id/revoke','/api/connector/devices/device-id/cleanup','/api/connector/register','/api/auth/team'])expect(roleAllows('operator','POST',path)).toBe(false);
 expect(roleAllows('lead_viewer','POST','/api/connector/pairings')).toBe(false);
 expect(roleAllows('admin','POST','/api/connector/devices/device-id/revoke')).toBe(true);
});
