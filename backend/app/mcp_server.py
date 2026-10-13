"""Native MCP SDK 2 server with stdio and stateless Streamable HTTP transports."""
import asyncio
import json
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.types import Tool, TextContent, CallToolResult, ListToolsResult, ToolAnnotations
from .settings import Settings
from . import workbuddy


def schema(properties=None, required=None):
    return {'type': 'object', 'properties': properties or {}, 'required': required or [], 'additionalProperties': False}


def string():
    return {'type': 'string', 'minLength': 1}


class HttpTransport:
    """ASGI callable keeps the original endpoint without a slash redirect."""
    def __init__(self, manager):
        self.manager = manager

    async def __call__(self, scope, receive, send):
        await self.manager.handle_request(scope, receive, send)


def text_result(value, error=False):
    return CallToolResult(content=[TextContent(type='text', text=json.dumps(value, ensure_ascii=False, default=str))], isError=error)


def create_business_server(scope, legacy=False):
    properties = {'taskId': string()}
    tools = {
        'get_xhs_operations_overview': ('查询真实账号与内容。空数组表示尚未同步，不得填充演示数据。', schema(), True),
        'list_xhs_publish_tasks': ('列出用户已确认的草稿或发布任务。queued 才能领取。', schema(), True),
        'claim_xhs_publish_task': ('领取指定任务，防止重复发布。核对账号身份；结果不确定时保持 running，禁止再次点击发布。', schema(properties, ['taskId']), False),
        'complete_xhs_publish_task': ('保存真实页面结果。published 必须有真实链接和成功证据，draft_saved 必须有保存证据。', schema({'taskId': string(), 'status': {'enum': ['published', 'draft_saved', 'failed']}, 'url': {'type': 'string'}, 'evidence': string(), 'message': {'type': 'string'}}, ['taskId', 'status', 'message']), False),
        'list_xhs_creation_tasks': ('查询图文创作任务和要求；queued 等待领取。', schema(), True),
        'claim_xhs_creation_task': ('领取图文创作。只使用已授权生图能力，不得虚构事实或图片；生成不授权发布。', schema(properties, ['taskId']), False),
        'complete_xhs_creation_task': ('保存实际文案和 HTTPS 图片。能力不足用 partial；不得编造图片地址。', schema({'taskId': string(), 'status': {'enum': ['completed', 'partial', 'failed']}, 'titles': {'type': 'array', 'items': string()}, 'body': {'type': 'string'}, 'images': {'type': 'array', 'items': string()}, 'imageProvider': {'type': 'string'}, 'message': {'type': 'string'}}, ['taskId', 'status', 'message']), False),
        'import_xhs_snapshot': ('只导入已授权正常账号真实读取的内容，不得猜测指标或创建演示数据。', {'type': 'object', 'properties': {'account': {'type': 'object'}, 'notes': {'type': 'array'}, 'comments': {'type': 'array'}, 'messages': {'type': 'array'}}, 'required': ['account', 'notes', 'comments']}, False),
    }
    if legacy:
        tools = {name: tools[name] for name in ('get_xhs_operations_overview', 'list_xhs_publish_tasks')}
        tools['create_xhs_publish_task'] = ('创建保存草稿或发布任务。发布必须明确 confirm_publish=true。', schema({'account_id': string(), 'title': {'type': 'string', 'minLength': 1, 'maxLength': 20}, 'body': string(), 'delivery': {'enum': ['draft', 'publish']}, 'confirm_publish': {'type': 'boolean'}}, ['account_id', 'title', 'body', 'delivery']), False)
    async def listing(context, params):
        return ListToolsResult(tools=[Tool(name=name, description=description, inputSchema=input_schema, annotations=ToolAnnotations(readOnlyHint=read_only, destructiveHint=not read_only, idempotentHint=read_only, openWorldHint=False)) for name, (description, input_schema, read_only) in tools.items()])
    async def calling(context, params):
        name, args = params.name, params.arguments or {}
        try:
            if name not in tools:
                raise ValueError('工具不存在')
            if name == 'get_xhs_operations_overview':
                value = workbuddy.overview(scope) if legacy else dict(accounts=scope.store.list_accounts(), notes=scope.store.list_notes(), comments=scope.store.list_comments(), messages=scope.store.list_messages(), leads=[lead | {'followUps': scope.store.list_follow_ups(lead['id'])} for lead in scope.store.list_leads()])
            elif name == 'create_xhs_publish_task':
                value = workbuddy.create_task(scope, args)
            elif name == 'list_xhs_publish_tasks':
                value = {'tasks': scope.workbuddy.list()} if legacy else scope.publish.list()
            elif name == 'claim_xhs_publish_task':
                value = scope.publish.claim(args['taskId'])
                value = value | {'account': next((a for a in scope.store.list_accounts() if a['id'] == value['accountId']), None)}
            elif name == 'complete_xhs_publish_task':
                value = scope.publish.complete(args)
            elif name == 'list_xhs_creation_tasks':
                value = scope.creation.list()
            elif name == 'claim_xhs_creation_task':
                value = scope.creation.claim(args['taskId'])
            elif name == 'complete_xhs_creation_task':
                value = scope.creation.complete(args)
            else:
                from .snapshots import validate_snapshot
                scope.store.import_snapshot(validate_snapshot(args))
                value = dict(ok=True, accounts=len(scope.store.list_accounts()), notes=len(scope.store.list_notes()))
            return text_result(value)
        except Exception as error:
            return text_result({'error': str(error)}, True)
    return Server('zhixu-xhs-operations' if legacy else 'zhixu-grey', version='1.0.0', on_list_tools=listing, on_call_tool=calling, get_tool_input_schema=lambda name: tools.get(name, (None, None, None))[1])


def install_mcp(app, runtime):
    # HTTP credential is the explicitly provisioned service token and owns only owner scope.
    manager = StreamableHTTPSessionManager(create_business_server(runtime.services.for_workspace('owner')), stateless=True, json_response=True)
    legacy = StreamableHTTPSessionManager(create_business_server(runtime.services.for_workspace('owner'), True), stateless=True, json_response=True)
    app.state.mcp_managers = getattr(app.state, 'mcp_managers', []) + [manager, legacy]
    app.add_route('/mcp/workbuddy', HttpTransport(legacy), methods=['GET', 'POST', 'DELETE'])
    app.add_route('/mcp', HttpTransport(manager), methods=['GET', 'POST', 'DELETE'])


def run_stdio(settings=None, workspace='owner', legacy=False):
    from .services import Services
    settings = settings or Settings.from_env()
    services = Services(settings)
    server = create_business_server(services.for_workspace(workspace), legacy)
    async def run():
        async with stdio_server() as (reader, writer):
            await server.run(reader, writer, server.create_initialization_options())
    try:
        asyncio.run(run())
    finally:
        services.close()
