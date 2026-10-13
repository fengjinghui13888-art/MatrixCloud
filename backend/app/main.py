"""ASGI factory for deployment tools that load app.main:create_app."""
from app.settings import Settings, load_env_file


def create_app():
    load_env_file()
    from app.api import create_app as api_factory
    return api_factory(settings=Settings.from_env())
