"""Backend configuration, resolved relative to this package rather than cwd."""
from dataclasses import dataclass, field
import ipaddress
import os
from pathlib import Path
import re
import secrets
from urllib.parse import urlsplit

BACKEND_DIR = Path(__file__).resolve().parents[1]


def _path(value, fallback):
    candidate = Path(value) if value else Path(fallback)
    return candidate.resolve() if candidate.is_absolute() else (BACKEND_DIR / candidate).resolve()


def _bool(value, default=False):
    return default if value is None or value == "" else value.lower() in {"1", "true", "yes"}


def load_env_file(path=None):
    """Read literal assignments; never execute shell text from configuration."""
    path = Path(path or BACKEND_DIR / ".env")
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key.strip()):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


@dataclass(frozen=True)
class Settings:
    data_dir: Path = field(default_factory=lambda: BACKEND_DIR / "data" / "work" / "grey")
    database_url: str | None = None
    public_origin: str = "http://127.0.0.1:5173"
    service_token: str | None = None
    platform_admin_username: str | None = None
    host: str = "127.0.0.1"
    port: int = 4174
    environment: str = "development"
    trusted_proxy_ips: tuple[str, ...] = ()
    trust_local_proxy_http: bool = False
    trust_loopback_proxy: bool = False
    require_auth: bool = True
    connector_packages_dir: Path | None = None
    deployment_hold_file: Path | None = None
    maintenance_config: Path | None = None
    tls_cert: Path | None = None
    tls_key: Path | None = None
    backend_dir: Path = field(default=BACKEND_DIR, init=False)

    def __post_init__(self):
        object.__setattr__(self, "data_dir", _path(self.data_dir, BACKEND_DIR / "data" / "work" / "grey"))
        owner = self.platform_admin_username
        marker = self.data_dir / 'platform-owner'
        if not owner and marker.is_file():
            owner = marker.read_text(encoding='utf-8').strip() or None
        if owner:
            owner = owner.strip().lower()
            if not re.fullmatch(r'[a-z0-9_.-]{3,40}', owner):
                raise ValueError('平台管理员标识无效，请核对原配置或备份')
            object.__setattr__(self, 'platform_admin_username', owner)
        origin = urlsplit(self.public_origin)
        if origin.scheme not in {"http", "https"} or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment or origin.path not in {"", "/"}:
            raise ValueError("PUBLIC_ORIGIN 必须是无凭证的 HTTP(S) 工作台地址")
        object.__setattr__(self, "public_origin", self.public_origin.rstrip("/"))
        if not 0 <= self.port <= 65535:
            raise ValueError("PORT 无效")
        for value in self.trusted_proxy_ips:
            try:
                ipaddress.ip_address(value)
            except ValueError as error:
                raise ValueError("TRUSTED_PROXY_IPS 只能包含明确的代理 IP 地址") from error

    @classmethod
    def from_env(cls):
        database_url = os.getenv("DATABASE_URL") or None
        database_file = os.getenv("DATABASE_URL_FILE")
        if database_file:
            database_url = _path(database_file, database_file).read_text(encoding="utf-8").strip()
        if _bool(os.getenv('DATABASE_REQUIRED'), False) and not database_url:
            raise ValueError('当前部署要求 PostgreSQL，请配置 DATABASE_URL 或 DATABASE_URL_FILE。')
        data = os.getenv("SYNC_DATA_DIR") or os.getenv("DATA_DIR")
        origin = os.getenv("CUSTOMER_PUBLIC_ORIGIN") or os.getenv("PUBLIC_ORIGIN") or "http://127.0.0.1:5173"
        optional = lambda name: _path(os.environ[name], os.environ[name]) if os.getenv(name) else None
        return cls(
            data_dir=_path(data, BACKEND_DIR / "data" / "work" / "grey"),
            database_url=database_url,
            public_origin=origin,
            service_token=os.getenv("MCP_SERVICE_TOKEN") or None,
            platform_admin_username=os.getenv("PLATFORM_ADMIN_USERNAME") or None,
            host=os.getenv("HOST") or "127.0.0.1",
            port=int(os.getenv("PORT") or "4174"),
            environment=os.getenv("NODE_ENV") or os.getenv("APP_ENV") or "development",
            trusted_proxy_ips=tuple(value.strip() for value in (os.getenv("TRUSTED_PROXY_IPS") or "").split(",") if value.strip()),
            trust_local_proxy_http=_bool(os.getenv("TRUST_LOCAL_PROXY_HTTP")),
            trust_loopback_proxy=_bool(os.getenv("TRUST_LOOPBACK_PROXY")),
            require_auth=_bool(os.getenv("MCP_REQUIRE_AUTH"), True),
            connector_packages_dir=optional("CONNECTOR_PACKAGES_DIR"),
            deployment_hold_file=optional("DEPLOYMENT_HOLD_FILE"),
            maintenance_config=optional("MAINTENANCE_CONFIG"),
            tls_cert=optional("TLS_CERT"), tls_key=optional("TLS_KEY"),
        )

    def get_service_token(self):
        if self.service_token:
            if len(self.service_token) < 32:
                raise ValueError("灰度访问令牌至少 32 位")
            return self.service_token
        self.data_dir.mkdir(parents=True, exist_ok=True)
        path = self.data_dir / "access-token"
        if not path.exists():
            try:
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                pass
            else:
                with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                    output.write(secrets.token_hex(32))
        token = path.read_text(encoding="utf-8").strip()
        if len(token) < 32:
            raise ValueError("本机服务凭证无效，请恢复备份")
        return token
