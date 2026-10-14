export function customerMessage(value:unknown,fallback='操作暂未完成，请检查当前页面和执行电脑'){
 const raw=value instanceof Error?value.message:String(value??'');
 if(!raw)return fallback;
 if(/All connection attempts failed|Connection refused|connect_over_cdp/i.test(raw))return '执行电脑上的浏览器连接中断，请确认客户端仍在运行，并核对小红书专属窗口。';
 if(/HTTPS|公网地址|服务地址.*公网|接口协议/i.test(raw))return '服务地址无法使用。请重新选择常用服务，或检查你填写的自定义地址。';
 if(/Unexpected end of JSON input|JSON\.parse|同步状态暂不可用/i.test(raw))return '同步状态暂未准备好，请保持执行电脑在线后重试。此前内容未重复写入。';
 if(/Invalid ISO datetime|invalid_format|ZodError|Runtime\.|CDP|Profile|ECONN|ETIMEDOUT|SQL|stack|localhost|127\.0\.0\.1|接口兼容|Traceback/i.test(raw))return /Invalid ISO datetime|invalid_format|ZodError/i.test(raw)?'同步数据暂未准备好，请保持执行电脑在线后重试。此前内容未重复写入。':/timeout|超时|ETIMEDOUT/i.test(raw)?'小红书页面暂未响应，请检查已打开的窗口。结果核对前请勿重复保存草稿。':fallback+'。需要帮助时请联系管理员查看任务记录。';
 return raw.replace(/^Error:\s*/, '');
}
