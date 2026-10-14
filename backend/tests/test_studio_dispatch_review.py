import pytest
from fastapi.testclient import TestClient
from app.api import create_app
from app.settings import Settings

def test_review_dispatch_checks_revision_then_approves_and_starts(tmp_path):
    app=create_app(Settings(data_dir=tmp_path,public_origin='http://localhost',service_token='s'*64))
    scope=app.state.services.for_workspace('owner')
    scope.store.add_account(dict(id='a',name='Synthetic',handle='a',profile='local:a',avatar='',state='connected',followers=0,lastSyncedAt=''))
    task=scope.studio.create(dict(accountId='a',topic='Synthetic',persona='',style='',imageCount=1,size='1024x1024',requestId='qa-dispatch',confirmCharge=True))['task']
    task=scope.studio.update(task['id'],task['revision'],dict(status='review',title='Synthetic',body='Body',tags=[],images=['https://example.com/image.png']))
    started=[]
    async def device(request):return 'd'
    async def start(value,request):started.append(value);return value
    app.state.runtime.execution_device=device;app.state.runtime.start_studio=start;app.state.runtime.channel.binding=lambda *args:'d'
    with TestClient(app,base_url='http://localhost') as c:
        headers={'Authorization':'Bearer '+'s'*64}
        url=f"/api/studio/{task['id']}/dispatch"
        assert c.post(url,json=dict(accountIds=['a'],revision=task['revision']-1),headers=headers).status_code==409
        assert started==[]
        response=c.post(url,json=dict(accountIds=['a'],revision=task['revision']),headers=headers)
        assert response.status_code==201
        assert len(started)==1 and started[0]['status']=='approved'
