from app.protocols import (PROTOCOL_VERSION, CONNECTOR_PLATFORMS, valid_connector_command,
                           valid_xhs_event, valid_xhs_subscriptions)

def test_protocol_four_rejects_arbitrary_cloud_execution():
    assert PROTOCOL_VERSION == 4
    assert valid_connector_command('GET', '/verify')
    assert not valid_connector_command('POST', '/eval', {'script': 'evil'})
    assert not valid_connector_command('POST', '/accounts/a/resume', {})
    assert valid_connector_command('POST', '/accounts/a/resume', {'confirmed': True})
    assert not valid_connector_command('GET', '/accounts/../../state')
    assert not valid_connector_command('GET', '/accounts/a/state', {})
    assert not valid_connector_command('POST', None)
    assert not valid_xhs_event(dict(eventId='c9014397-9dd5-4daa-8f84-4918408414fd',profile='local:a',kind=[],fingerprint='a'*64))

def test_event_does_not_accept_extra_payload_or_unverified_profile():
    event = dict(eventId='c9014397-9dd5-4daa-8f84-4918408414fd', profile='local:a', kind='notes', fingerprint='a'*64)
    assert valid_xhs_event(event)
    assert not valid_xhs_event({**event, 'url':'http://evil'})
    assert not valid_xhs_event({**event, 'profile':'../../a'})
    assert not valid_xhs_event({**event, 'eventId':'0'*36})

def test_watch_bounds_and_package_ids_remain_compatible():
    sub = dict(profile='local:a', accountId='a', handle='42', knownNotes=[], knownComments=[], knownMessages=[])
    assert valid_xhs_subscriptions([sub])
    assert not valid_xhs_subscriptions([sub]*101)
    assert not valid_xhs_subscriptions([{**sub, 'knownNotes':['x']*10001}])
    assert [p['id'] for p in CONNECTOR_PLATFORMS] == ['windows','mac-arm64','mac-intel','windows-arm64','windows-x86','linux-x64','linux-arm64']
