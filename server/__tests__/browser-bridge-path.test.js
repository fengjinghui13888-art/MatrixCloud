import {describe,it,expect} from 'vitest';
import {browserBridgePath} from '../../scripts/browser-bridge-path.mjs';

describe('browser bridge path',()=>{
 it('requires an explicit existing bridge runtime',()=>{
  expect(()=>browserBridgePath({BROWSER_BRIDGE_NODE:'/missing/opencli'})).toThrow('未找到浏览器连接器运行时');
 });
});
