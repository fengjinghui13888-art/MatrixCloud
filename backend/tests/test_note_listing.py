import pytest
from connector.note_listing import collect_note_pages


@pytest.mark.asyncio
async def test_full_sync_does_not_stop_at_ten_already_known_notes():
    owned={str(i):{} for i in range(10)};pages=[10,20,30,34];index=0;advances=[]
    async def state():return dict(total=34,atEnd=index==3)
    async def advance():
        nonlocal index
        advances.append(index)
        if index<3:index+=1
        owned.update({str(i):{} for i in range(pages[index])})
    async def drain():pass
    async def report(message):pass
    result=await collect_note_pages(owned,state,advance,drain,report)
    assert len(owned)==34 and result['complete'] and len(advances)==3


@pytest.mark.asyncio
async def test_one_empty_scroll_does_not_mean_list_ended():
    owned={str(i):{} for i in range(10)};attempt=0
    async def state():return dict(total=20,atEnd=True)
    async def advance():
        nonlocal attempt
        attempt+=1
        if attempt==2:owned.update({str(i):{} for i in range(20)})
    async def noop(*a):pass
    result=await collect_note_pages(owned,state,advance,noop,noop)
    assert result['complete'] and len(owned)==20 and attempt==2


@pytest.mark.asyncio
async def test_stalled_list_reports_partial_instead_of_treating_page_size_as_total():
    owned={str(i):{} for i in range(10)}
    async def state():return dict(total=50,atEnd=False)
    async def noop(*a):pass
    result=await collect_note_pages(owned,state,noop,noop,noop)
    assert not result['complete'] and result['total']==50
