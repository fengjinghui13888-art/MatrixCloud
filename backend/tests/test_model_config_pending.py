import pytest
from app.models import Models,call_model
from app.store import ServiceError

@pytest.mark.asyncio
async def test_pending_model_config_is_saved_but_never_billed(tmp_path):
    models=Models(tmp_path)
    value=dict(label='Relay',baseUrl='https://relay.example/v1',apiKey='synthetic',protocol='chat-completions',model='')
    assert models.save(value)['model']==''
    calls=[]
    async def transport(*args):calls.append(args)
    with pytest.raises(ServiceError,match='尚未发现可用文案模型'):
        await call_model(models.read(),'test',transport)
    assert not calls
