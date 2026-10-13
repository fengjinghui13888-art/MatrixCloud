import pytest

from tools.build_connector_packages import build


def test_refuses_missing_runtime_and_credentialed_cloud_url(tmp_path):
    with pytest.raises(ValueError, match='元数据'):
        build(tmp_path, tmp_path / 'output', 'windows', 'https://example.test')
    with pytest.raises(ValueError, match='无凭证'):
        build(tmp_path, tmp_path / 'output', 'windows', 'https://user:password@example.test')
    assert not (tmp_path / 'output').exists()
