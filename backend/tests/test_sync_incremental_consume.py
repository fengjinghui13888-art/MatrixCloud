from connector.sync import SyncCollector

def test_consume_does_not_parse_historical_messages_again(monkeypatch):
    import connector.sync as sync
    calls=[]
    def extract(body,account,context=None):
        calls.append(body)
        return dict(notes=[],comments=[],messages=[])
    monkeypatch.setattr(sync,'extract_content',extract)
    c=SyncCollector(dict(id='a',handle='42',name='Synthetic'))
    c.creator=dict(redId='42',userId='self')
    c.web=dict(red_id='42',user_id='self')
    c.record(dict(url='https://www.xiaohongshu.com/api/im/web/messages/history',path='/api/im/web/messages/history',body={'data':{}}))
    c.consume();c.consume();c.consume()
    assert len(calls)==1
