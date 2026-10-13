import {expect,it} from 'vitest';
import {nativeUploadCount,shouldFallbackNative,timingMessage} from '../../../scripts/studio-upload.mjs';

it('accepts only the structured native upload envelope',()=>{
 expect(nativeUploadCount({uploaded:true,files:2})).toBe(2);
 expect(nativeUploadCount({uploaded:false,files:2})).toBe(0);
 expect(nativeUploadCount('uploaded')).toBe(0);
});

it('falls back only for unsupported upload targets or chooser failures',()=>{
 expect(shouldFallbackNative(new Error('browser upload is not supported'))).toBe(true);
 expect(shouldFallbackNative(new Error('Page.fileChooserOpened not received'))).toBe(false);
 expect(shouldFallbackNative(new Error('sendCommand: max attempts exhausted'))).toBe(false);
 expect(shouldFallbackNative(new Error('Connection to daemon was lost mid-command'))).toBe(false);
});

it('reports all execution phases',()=>{
 expect(timingMessage({total:30,page:2,download:3,upload:4,preview:5,fill:6,save:7})).toContain('上传 4ms');
});
