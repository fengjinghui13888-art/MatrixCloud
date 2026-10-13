import {describe,it,expect,vi} from 'vitest';
import {focusBrowserPage} from '../../../local-connector/browser-focus.mjs';

describe('connector browser scan handoff',()=>{
 it('brings the customer-visible XHS tab to the front',async()=>{
  const selectTab=vi.fn(),activate=vi.fn(),close=vi.fn();
  const connectPage=vi.fn(async()=>({page:{selectTab},activate,close}));
  const found=await focusBrowserPage({session:{debugPort:47821},findPage:vi.fn(async()=> 'xhs-tab'),connectPage});
  expect(found).toBe(true);expect(connectPage).toHaveBeenCalledWith(47821);expect(selectTab).toHaveBeenCalledWith('xhs-tab');expect(activate).toHaveBeenCalledTimes(1);expect(close).toHaveBeenCalledTimes(1);
 });
 it('leaves the current browser alone when no web login tab exists',async()=>{
  const connectPage=vi.fn();const found=await focusBrowserPage({session:{debugPort:47821},findPage:vi.fn(async()=>undefined),connectPage});
  expect(found).toBe(false);expect(connectPage).not.toHaveBeenCalled();
 });
});
