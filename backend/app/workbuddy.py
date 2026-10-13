"""The original WorkBuddy task tools, backed by the authenticated workspace."""
def overview(scope):
    return {'accounts': [{'id': account['id'], 'name': account['name'], 'handle': account['handle'], 'syncState': account['state']} for account in scope.store.list_accounts()], 'pendingComments': [{key: comment[key] for key in ('id', 'accountId', 'author', 'body', 'tags')} for comment in scope.store.list_comments() if comment['status'] == 'pending'], 'leads': len(scope.store.list_leads())}


def create_task(scope, arguments):
    account = next((a for a in scope.store.list_accounts() if a['id'] == arguments['account_id']), None)
    if not account:
        return {'error': '未找到账号', 'next_action': '先调用 get_xhs_operations_overview 获取合法账号 ID。'}
    if arguments['delivery'] == 'publish' and arguments.get('confirm_publish') is not True:
        raise ValueError('发布任务需要明确确认')
    if not 1 <= len(arguments['title']) <= 20 or not arguments['body']:
        raise ValueError('标题或正文无效')
    task = scope.workbuddy.create(dict(accountId=arguments['account_id'], title=arguments['title'], body=arguments['body'], delivery=arguments['delivery'], confirmPublish=arguments.get('confirm_publish')))
    return {'task': task, 'next_action': '请在目标账号已登录的 Chrome Profile 中连接已授权浏览器桥接后执行。'}
