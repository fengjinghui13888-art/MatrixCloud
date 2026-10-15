from app.store import Store
from app.api import create_app
from app.settings import Settings
from fastapi.testclient import TestClient


def test_followups_are_grouped_with_one_read_and_selected_leads_only(tmp_path,monkeypatch):
    store=Store(tmp_path/'ops.sqlite')
    with store.state(True) as data:
        data['followUps']=[dict(id='f1',leadId='one',body='one'),dict(id='f2',leadId='other',body='other'),dict(id='f3',leadId='one',body='two')]
    reads=[];original=store._list
    def counted(key,*args):reads.append(key);return original(key,*args)
    monkeypatch.setattr(store,'_list',counted)
    groups=store.follow_ups_by_lead(['one','empty'])
    assert groups=={'one':[dict(id='f1',leadId='one',body='one'),dict(id='f3',leadId='one',body='two')],'empty':[]}
    assert reads==['followUps']
    reads.clear()
    assert store.follow_ups_by_lead([])=={} and reads==[]


def test_operations_reads_followups_once_for_hundreds_of_leads(tmp_path,monkeypatch):
    app=create_app(Settings(data_dir=tmp_path,service_token='s'*64,public_origin='http://localhost'))
    store=app.state.services.for_workspace('owner').store
    with store.state(True) as data:
        data['leads']=[dict(id='lead-'+str(i),accountId='a',sourceCommentId='c',status='new') for i in range(192)]
        data['followUps']=[dict(id='f',leadId='lead-1',body='fixture')]
    reads=[];original=store._list
    def counted(key,*args):reads.append(key);return original(key,*args)
    monkeypatch.setattr(store,'_list',counted)
    with TestClient(app,base_url='http://localhost') as client:
        result=client.get('/api/operations',headers={'Authorization':'Bearer '+'s'*64})
    assert result.status_code==200
    rows=result.json()['leads'];assert len(rows)==192
    assert next(r for r in rows if r['id']=='lead-1')['followUps'][0]['body']=='fixture'
    assert reads.count('followUps')==1
