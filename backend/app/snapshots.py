"""Validate untrusted imports before any persistent state is changed."""
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, ValidationError, field_validator, model_validator
from .store import ServiceError

Text = Annotated[StrictStr, Field(min_length=1)]
Count = Annotated[StrictInt, Field(ge=0)]


def media_url(value):
    if value is not None:
        parsed = urlsplit(value)
        parsed.port  # urlsplit otherwise accepts invalid/non-numeric/out-of-range ports.
        if parsed.scheme.lower() not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or any(c.isspace() for c in parsed.netloc):
            raise ValueError('媒体地址必须为无凭证的 HTTP(S) 地址')
    return value


class Record(BaseModel):
    model_config = ConfigDict(strict=True, extra='ignore')


class Account(Record):
    id: Text
    name: Text
    handle: Text
    profile: Text
    avatar: StrictStr
    state: Literal['connected']
    followers: Count
    lastSyncedAt: StrictStr

    @field_validator('lastSyncedAt')
    @classmethod
    def timestamp(cls, value):
        if value and ('T' not in value or datetime.fromisoformat(value.replace('Z', '+00:00')).tzinfo is None):
            raise ValueError('同步时间必须包含时区')
        return value


class Metrics(Record):
    likes: Count | None
    collects: Count | None
    comments: Count | None
    shares: Count | None


class Asset(Record):
    id: Annotated[StrictStr, Field(pattern=r'^[a-f0-9]{32}$')]
    kind: Literal['image', 'video', 'cover']
    index: Count
    sourceUrl: StrictStr
    path: Annotated[StrictStr, Field(max_length=600)]
    bytes: Count
    sha256: Annotated[StrictStr, Field(pattern=r'^[a-f0-9]{64}$')]

    @field_validator('sourceUrl')
    @classmethod
    def source_url(cls, value):
        return media_url(value)

    @field_validator('path')
    @classmethod
    def relative_path(cls, value):
        if '\\' in value or ':' in value or any(part in ('', '.', '..') for part in value.split('/')):
            raise ValueError('媒体路径必须为安全相对路径')
        return value


class Note(Record):
    id: Text
    accountId: Text
    title: Text
    summary: StrictStr | None
    cover: StrictStr | None
    url: StrictStr | None
    publishedAt: StrictStr
    metrics: Metrics
    mediaType: Literal['image', 'video'] = 'image'
    images: list[StrictStr] = Field(default_factory=list, max_length=100)
    videoUrl: StrictStr | None = None
    mediaAssets: list[Asset] = Field(default_factory=list, max_length=150)

    @field_validator('url', 'videoUrl')
    @classmethod
    def urls(cls, value):
        return media_url(value)

    @field_validator('images')
    @classmethod
    def image_urls(cls, values):
        for value in values:
            media_url(value)
        return values


class Comment(Record):
    id: Text
    accountId: Text
    noteId: Text
    author: Text
    avatar: StrictStr
    body: Text
    createdAt: StrictStr
    status: Literal['pending']
    tags: list[StrictStr]
    direction: Literal['incoming', 'outgoing'] | None = None


class Message(Record):
    id: Text
    accountId: Text
    conversationId: Text
    author: Text
    body: Text
    createdAt: StrictStr
    direction: Literal['incoming', 'outgoing']


class Snapshot(Record):
    account: Account
    notes: list[Note]
    comments: list[Comment]
    messages: list[Message] = Field(default_factory=list)

    @model_validator(mode='after')
    def ownership(self):
        if any(row.accountId != self.account.id for row in [*self.notes, *self.comments, *self.messages]):
            raise ValueError('内容不属于当前账号')
        return self


def validate_snapshot(value):
    try:
        return Snapshot.model_validate(value).model_dump(exclude_unset=True)
    except (ValidationError, ValueError, TypeError) as error:
        raise ServiceError('同步数据格式不完整或无效，原有数据未更改', 400) from error
