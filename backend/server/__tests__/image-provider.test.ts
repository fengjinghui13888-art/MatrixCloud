import { expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateImages } from '../model-gateway';
import { createModelSettings } from '../model-settings';

const settings={label:'Text',protocol:'chat-completions' as const,baseUrl:'https://text.example/v1',model:'text',apiKey:'text-secret',imageModel:'image',imageBaseUrl:'https://images.example/v1',imageApiKey:'image-secret'};
it('uses Agnes documented nested output format and accepts null base64',async()=>{
 const transport=vi.fn().mockResolvedValue({data:[{url:'https://example.com/image.png',b64_json:null}]});
 const result=await generateImages({...settings,imageBaseUrl:'https://api.agnes-ai.cn/v1'},'test',1,transport);
 expect(result.images).toEqual(['https://example.com/image.png']);
 expect(transport.mock.calls[0][2]).toMatchObject({extra_body:{response_format:'url'}});
 expect(transport.mock.calls[0][2]).not.toHaveProperty('response_format');
});
it('preserves omitted keys and allows replacing them without exposing them',()=>{
 const store=createModelSettings(mkdtempSync(join(tmpdir(),'key-edit-')));
 store.save(settings);
 store.save({...settings,model:'new-model',apiKey:undefined,imageApiKey:undefined});
 expect(store.read()?.apiKey).toBe('text-secret');
 expect(store.read()?.imageApiKey).toBe('image-secret');
 store.save({...settings,apiKey:'replacement',imageApiKey:'image-replacement'});
 expect(store.read()?.apiKey).toBe('replacement');
 expect(JSON.stringify(store.summary())).not.toContain('replacement');
});
it('does not carry a saved secret to a changed provider URL',()=>{
 const store=createModelSettings(mkdtempSync(join(tmpdir(),'key-host-')));
 store.save(settings);
 expect(()=>store.save({...settings,baseUrl:'https://other.example',apiKey:undefined})).toThrow();
});
it('routes images to the independent provider and key',async()=>{
 const transport=vi.fn().mockResolvedValue({data:[{url:'https://images.example/result.png'}]});
 await generateImages(settings,'a landscape',1,transport);
 expect(transport.mock.calls[0][0]).toBe('https://images.example/v1/images/generations');
 expect(transport.mock.calls[0][1]).toEqual({Authorization:'Bearer image-secret'});
});
it('encrypts both keys and excludes both from public settings',()=>{
 const store=createModelSettings(mkdtempSync(join(tmpdir(),'image-provider-')));
 const summary=store.save(settings);
 expect(summary).not.toHaveProperty('apiKey');
 expect(summary).not.toHaveProperty('imageApiKey');
 expect(store.read()?.imageApiKey).toBe('image-secret');
});
it('rejects a separate image URL without its own key',async()=>{
 await expect(generateImages({...settings,imageApiKey:undefined},'test')).rejects.toThrow();
});
