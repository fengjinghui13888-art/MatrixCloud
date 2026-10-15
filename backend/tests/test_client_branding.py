from pathlib import Path
from PIL import Image
import pytest
from client.branding import workbench_url
import subprocess,sys


def test_client_opens_customer_origin_and_never_admin_route():
    assert workbench_url({'cloudUrl':'https://matrix.example'})=='https://matrix.example/'
    assert workbench_url({'cloudUrl':'http://127.0.0.1:5173'})=='http://127.0.0.1:5173/'
    for value in ('https://matrix.example/admin.html','https://matrix.example/?admin=1','https://user:pass@matrix.example'):
        with pytest.raises(ValueError):workbench_url({'cloudUrl':value})


def test_branding_does_not_preload_connector_before_signed_worker_selection():
    result=subprocess.run([sys.executable,'-c',"import sys; import client.branding; assert 'connector' not in sys.modules"],capture_output=True)
    assert result.returncode==0


def test_brand_has_exact_wordmark_and_native_icon_formats():
    root=Path(__file__).resolve().parents[2]
    svg=(root/'frontend/public/brand/logo.svg').read_text(encoding='utf-8')
    assert 'HUAKE FUTURE' in svg and 'MatrixCloud' in svg
    assert Image.open(root/'frontend/public/brand/app-icon.png').size==(512,512)
    ico=Image.open(root/'backend/client/brand/matrixcloud.ico')
    assert (256,256) in ico.info['sizes'] and (16,16) in ico.info['sizes']
    assert Image.open(root/'backend/client/brand/matrixcloud.icns').format=='ICNS'
