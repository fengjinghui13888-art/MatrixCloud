import {expect,it} from 'vitest';
import {parseOpenCLI} from '../../../scripts/studio-opencli.mjs';
it('parses real CLI text, envelopes and log-prefixed pretty JSON',()=>{
 expect(parseOpenCLI('JINGHUI\n')).toBe('JINGHUI');
 expect(parseOpenCLI('{"session":"studio","data":"JINGHUI"}')).toBe('JINGHUI');
 expect(parseOpenCLI('connected\n{\n"uploaded": true,\n"files": 1\n}')).toEqual({uploaded:true,files:1});
 expect(()=>parseOpenCLI('{broken')).toThrow('无法解析');
});
