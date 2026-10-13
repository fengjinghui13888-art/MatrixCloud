import {it,expect,vi} from 'vitest';
import {fetchImageBytes} from '../../../scripts/studio-media.mjs';
it('retries only transient download failures and preserves the returned bytes',async()=>{
 const bytes=Buffer.from([137,80,78,71]);
 const fetcher=vi.fn().mockRejectedValueOnce(TypeError('fetch failed')).mockResolvedValueOnce({ok:false,status:503}).mockResolvedValueOnce({ok:true,arrayBuffer:async()=>bytes});
 expect(await fetchImageBytes(new URL('https://example.com/image.png'),fetcher,async()=>{})).toEqual(bytes);
 expect(fetcher).toHaveBeenCalledTimes(3);
});
it('does not retry a missing image and bounds repeated connection failures',async()=>{
 const missing=vi.fn(async()=>({ok:false,status:404}));
 await expect(fetchImageBytes(new URL('https://example.com/image.png'),missing,async()=>{})).rejects.toThrow('HTTP 404');expect(missing).toHaveBeenCalledTimes(1);
 const offline=vi.fn(async()=>{throw Error('offline');});
 await expect(fetchImageBytes(new URL('https://example.com/image.png'),offline,async()=>{})).rejects.toThrow('素材服务连接失败');expect(offline).toHaveBeenCalledTimes(3);
});
