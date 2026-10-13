from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from pathlib import Path
from .settings import Settings
from .store import Store, ServiceError
from .auth import Auth
from .queues import CreationQueue, PublishQueue
from .studio import Studio
from .templates import Templates
from .models import Models
from .billing import Billing, Workbuddy
from .assets import Assets
from .postgres import Postgres, PostgresStore


@dataclass
class Scope:
    workspace:str
    root:Path
    store:Store
    creation:CreationQueue
    publish:PublishQueue
    studio:Studio
    templates:Templates
    models:Models
    billing:Billing
    assets:Assets
    workbuddy:Workbuddy


class Services:
    def __init__(self,settings:Settings):
        self.settings=settings;self.root=Path(settings.data_dir);self.root.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.db=Postgres(settings.database_url) if settings.database_url else None
        self.auth=Auth(settings,self.db);self._scopes={};self.lock=threading.RLock()

    def for_workspace(self,workspace:str):
        if workspace!='owner' and (not isinstance(workspace,str) or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',workspace)):raise ServiceError('无效工作区',403)
        if not self.auth.active(workspace):raise ServiceError('客户已停用，请联系管理员',403)
        with self.lock:
            if workspace not in self._scopes:
                root=self.root if workspace=='owner' else self.root/'workspaces'/workspace
                # Resolve symlinks as well as traversal before creating scoped storage.
                if not root.resolve().is_relative_to(self.root.resolve()):raise ServiceError('无效工作区',403)
                root.mkdir(parents=True,exist_ok=True,mode=0o700)
                self._scopes[workspace]=Scope(workspace,root,PostgresStore(self.db,workspace) if self.db else Store(root/'operations.sqlite'),CreationQueue(root/'creation.sqlite',self.db,workspace),PublishQueue(root/'publish.sqlite',self.db,workspace),Studio(root/'studio.sqlite',self.db,workspace),Templates(root/'templates.sqlite',self.root,workspace,self.db),Models(root,self.db,workspace),Billing(root/'billing.json'),Assets(root),Workbuddy(root/'workbuddy-tasks.json'))
            return self._scopes[workspace]

    def close(self):
        if self.db:self.db.close()
