import {newSyncRecords} from '../new-sync-records';

test('counts only newly stored account-scoped records, not edits or deletions',()=>{
 const old={notes:[{accountId:'a',id:'n'}],comments:[{accountId:'a',id:'c'}],messages:[{accountId:'a',id:'m'}]};
 const next={notes:[{accountId:'a',id:'n',title:'编辑'},{accountId:'b',id:'n'}],comments:[],messages:[{accountId:'a',id:'m'},{accountId:'a',id:'new'}]};
 expect(newSyncRecords(old,next)).toEqual({notes:1,comments:0,messages:1});
 expect(newSyncRecords(null,next)).toEqual({notes:0,comments:0,messages:0});
});
