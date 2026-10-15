from pathlib import Path
import pytest
from connector.browser import BrowserRuntime


@pytest.mark.parametrize('platform,relative',[
    ('win32','chromium-123/chrome-win64/chrome.exe'),
    ('darwin','chromium-123/chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
    ('darwin','chromium-123/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    ('linux','chromium-123/chrome-linux64/chrome'),
])
def test_packaged_browser_discovery_for_each_platform(tmp_path,platform,relative):
    from connector.execution_browser import packaged_browser
    browser=tmp_path/relative;browser.parent.mkdir(parents=True);browser.write_bytes(b'fixture')
    assert packaged_browser(tmp_path,platform)==str(browser)


def test_runtime_uses_packaged_browser_only_when_native_browser_missing(tmp_path,monkeypatch):
    native=tmp_path/'native';native.write_bytes(b'fixture')
    bundled=tmp_path/'chromium-123/chrome-win64/chrome.exe';bundled.parent.mkdir(parents=True);bundled.write_bytes(b'fixture')
    monkeypatch.setattr('connector.browser.chrome_candidates',lambda:[])
    monkeypatch.setattr('connector.browser.bundled_browser_roots',lambda:[tmp_path])
    assert BrowserRuntime(tmp_path/'data').executable()==str(bundled)
    monkeypatch.setattr('connector.browser.chrome_candidates',lambda:[str(native)])
    assert BrowserRuntime(tmp_path/'data').executable()==str(native)


def test_missing_browser_has_actionable_error_and_never_downloads(tmp_path,monkeypatch):
    monkeypatch.setattr('connector.browser.chrome_candidates',lambda:[])
    monkeypatch.setattr('connector.browser.bundled_browser_roots',lambda:[tmp_path])
    with pytest.raises(ValueError,match='完整客户端'):
        BrowserRuntime(tmp_path/'data').executable()


def test_packaged_browser_rejects_symlink_outside_bundle(tmp_path):
    from connector.execution_browser import packaged_browser
    other=tmp_path/'outside';other.write_bytes(b'fixture');root=tmp_path/'bundle';path=root/'chromium-123/chrome-win64/chrome.exe';path.parent.mkdir(parents=True)
    try:path.symlink_to(other)
    except OSError:pytest.skip('symlink permission unavailable')
    assert packaged_browser(root,'win32') is None
