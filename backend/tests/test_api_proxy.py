from starlette.requests import Request
from app.api import ApiRuntime
from app.settings import Settings


def runtime(settings):
    instance = ApiRuntime.__new__(ApiRuntime)
    instance.settings = settings
    return instance


def request(peer='127.0.0.1', host='public.example', proto='https', forwarded='198.51.100.7'):
    headers = [(b'host', host.encode()), (b'x-forwarded-proto', proto.encode()), (b'x-forwarded-for', forwarded.encode())]
    return Request({'type': 'http', 'scheme': 'http', 'method': 'GET', 'path': '/api/connector/register', 'root_path': '', 'query_string': b'', 'headers': headers, 'client': (peer, 50000), 'server': ('127.0.0.1', 4174)})


def test_only_explicit_loopback_ingress_may_forward_https(tmp_path):
    direct = runtime(Settings(data_dir=tmp_path, public_origin='https://public.example'))
    assert direct.secure(request()) is False
    proxied = runtime(Settings(data_dir=tmp_path, public_origin='https://public.example', trust_loopback_proxy=True))
    assert proxied.secure(request()) is True
    assert proxied.client_ip(request()) == '198.51.100.7'
    assert proxied.secure(request(peer='198.51.100.8')) is False


def test_http_development_proxy_requires_all_original_guards(tmp_path):
    def configured(environment='development', origin='http://localhost:5173'):
        return runtime(Settings(data_dir=tmp_path, environment=environment, public_origin=origin, trusted_proxy_ips=('10.0.0.10',), trust_local_proxy_http=True))
    valid = request(peer='10.0.0.10', host='localhost:5173', proto='http')
    assert configured().secure(valid) is True
    assert configured('production').secure(valid) is False
    assert configured(origin='https://localhost:5173').secure(valid) is False
    assert configured(origin='http://public.example').secure(request(peer='10.0.0.10', proto='http')) is False
    assert configured().secure(request(peer='10.0.0.10', host='localhost:9999', proto='http')) is False
    assert configured().secure(request(peer='10.0.0.10', host='localhost:5173', proto='garbage')) is False


def test_forwarded_client_is_not_treated_as_local_setup(tmp_path):
    instance = runtime(Settings(data_dir=tmp_path, public_origin='http://localhost', trust_loopback_proxy=True))
    assert instance.client_ip(request(host='localhost')) == '198.51.100.7'
    assert instance.local_setup(request(host='localhost')) is False
