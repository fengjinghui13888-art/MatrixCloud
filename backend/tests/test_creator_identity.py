"""The sync's final identity check must work without navigating home again."""
import json
import shutil
import subprocess
import pytest
from connector.expressions import READCREATORIDENTITY, expression

@pytest.mark.parametrize('cached', [False, True])
def test_sync_requires_self_user_id_even_when_dom_or_cache_has_handle(cached):
    node=shutil.which('node')
    if not node:pytest.skip('Node is required for browser expression fixture')
    script="""
global.location={href:'https://creator.xiaohongshu.com/new/note-manager',origin:'https://creator.xiaohongshu.com',pathname:'/new/note-manager'};
global.document={body:{innerText:'小红书号：42'},querySelector:()=>({textContent:'Account'}),querySelectorAll:()=>[]};
global.window={};let calls=0;
if(CACHED)window.__MATRIX_XHS_CREATOR_IDENTITY={at:Date.now(),value:{loggedIn:true,handle:'42'}};
global.fetch=async()=>{calls++;return {status:200,ok:true,json:async()=>({data:{redId:'42',userId:'self-u'}})}};
(async()=>{const identity=await EXPRESSION;console.log(JSON.stringify({identity,calls}));})();
""".replace('CACHED',str(cached).lower()).replace('EXPRESSION',expression(READCREATORIDENTITY,True))
    result=json.loads(subprocess.check_output([node,'-e',script],text=True))
    assert result['identity'].get('userId')=='self-u'
    assert result['calls']==1
