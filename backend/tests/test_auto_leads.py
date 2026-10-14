from app.store import Store

def test_all_external_interactions_become_unique_leads_and_preserve_followups(tmp_path):
    store=Store(tmp_path/'operations.sqlite')
    account=dict(id='a',name='owner',handle='owner-id')
    comment=dict(id='c',accountId='a',noteId='n',author='visitor',body='好看',status='pending',tags=[])
    message=dict(id='d',accountId='a',conversationId='chat',author='visitor',body='私我',direction='incoming')
    snapshot=dict(account=account,comments=[comment,{**comment,'id':'self','direction':'outgoing'}],messages=[message,{**message,'id':'out','direction':'outgoing'}])
    store.import_snapshot(snapshot)
    leads=store.list_leads()
    assert len(leads)==2
    direct=next(l for l in leads if l.get('sourceKind')=='direct')
    assert direct['sourceCommentId']=='d' and direct['sourceNoteId'] is None
    store.add_follow_up(direct['id'],'已沟通','operator')
    store.import_snapshot(snapshot)
    assert len(store.list_leads())==2
    assert len(store.list_follow_ups(direct['id']))==1
    assert store.get_comment('c')['status']=='lead_created'
    store.delete_lead(direct['id'])
    store.import_snapshot(snapshot)
    assert len(store.list_leads())==1
    assert store.collect_leads()==0

def test_backfill_existing_interactions_is_idempotent(tmp_path):
    store=Store(tmp_path/'operations.sqlite')
    with store.state(True) as data:
        data['accounts']=[dict(id='a',name='owner')]
        data['comments']=[dict(id='c',accountId='a',noteId='n',author='visitor',body='滴滴我',status='pending')]
    assert store.collect_leads()==1
    assert store.collect_leads()==0

def test_verified_comment_identity_excludes_own_reply_even_with_other_display_name():
    from connector.content import extract_content
    comment=dict(comment_id='c',note_id='n',content='答复',user_info=dict(user_id='self',nickname='不同昵称'))
    assert extract_content(comment,'a',dict(selfId='self'))['comments'][0]['direction']=='outgoing'
    comment['user_info']['user_id']='visitor'
    assert extract_content(comment,'a',dict(selfId='self'))['comments'][0]['direction']=='incoming'
