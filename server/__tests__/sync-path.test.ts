import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createXhsSync} from '../xhs-sync';
import {createStore} from '../store';
test('sync status cannot escape task directory with a crafted id',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sync-path-'));writeFileSync(join(dir,'foreign.json'),JSON.stringify({id:'secret',accountId:'a',status:'complete'}));
 const sync=createXhsSync(dir,createStore(join(dir,'ops.sqlite')));expect(sync.status('../foreign')).toBeNull();
});
