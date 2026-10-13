export function customerMessage(value:unknown,fallback='操作暂未完成，请检查当前页面和执行电脑'){
 const raw=value instanceof Error?value.message:String(value??'');
 if(!raw)return fallback;
 if(/Unexpected end of JSON input|JSON\.parse|同步状态暂不可用/i.test(raw))return '同步状态暂未准备好，请保持执行电脑在线后重试。此前内容未重复写入。';
 if(/Invalid ISO datetime|invalid_format|ZodError|Runtime\.|CDP|Profile|ECONN|ETIMEDOUT|SQL|stack|localhost|127\.0\.0\.1|接口兼容|Traceback/i.test(raw))return /Invalid ISO datetime|invalid_format|ZodError/i.test(raw)?'同步数据暂未准备好，请保持执行电脑在线后重试。此前内容未重复写入。':/timeout|超时|ETIMEDOUT/i.test(raw)?'小红书页面暂未响应，请检查已打开的窗口。结果核对前请勿重复保存草稿。':fallback+'。需要帮助时请联系管理员查看任务记录。';
 return raw.replace(/^Error:\s*/, '');
}
