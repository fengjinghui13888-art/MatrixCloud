import {describe,it,expect} from 'vitest';
import {join} from 'node:path';
import {chromeCandidates,findChrome} from '../../../local-connector/browser-path.mjs';

describe('customer Chrome discovery',()=>{
  it('uses installed Windows Edge without requiring a path setting',()=>{
    const expected=join('C:/Program Files','Microsoft','Edge','Application','msedge.exe');
    expect(findChrome({platform:'win32',env:{ProgramFiles:'C:/Program Files'}},path=>path===expected)).toBe(expected);
  });
  it('finds Windows Chrome installed for all users',()=>{
    const options={platform:'win32',env:{LOCALAPPDATA:'C:/Users/customer/AppData/Local',ProgramFiles:'C:/Program Files'},home:''};
    const expected=join('C:/Program Files','Google','Chrome','Application','chrome.exe');
    expect(chromeCandidates(options)).toContain(expected);
    expect(findChrome(options,path=>path===expected)).toBe(expected);
  });
  it('uses an explicit Chrome path and reports missing Chrome clearly',()=>{
    expect(findChrome({platform:'win32',env:{CHROME_BIN:'D:/Chrome/chrome.exe'}},path=>path==='D:/Chrome/chrome.exe')).toBe('D:/Chrome/chrome.exe');
    expect(()=>findChrome({platform:'win32',env:{}},()=>false)).toThrow('未找到 Google Chrome');
  });
  it('finds Microsoft Edge on Linux when Chrome is unavailable',()=>{
    expect(findChrome({platform:'linux',env:{}},path=>path==='/usr/bin/microsoft-edge')).toBe('/usr/bin/microsoft-edge');
  });
});
