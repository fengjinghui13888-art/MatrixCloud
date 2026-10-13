type RecoveryTask={status:string;message:string;executionStartedAt?:string;executionRunId?:string};

export function canRetryStudio(task:RecoveryTask){
 if(task.status!=='blocked')return false;
 if(!task.executionStartedAt)return true;
 // Legacy executors did not attach retrySafe/run IDs. These specific failures
 // occurred before download/upload; never infer safety from a generic timeout
 // or from a failure after upload, filling or saving.
 return !task.executionRunId && /^连接\/页面检查失败：(当前创作页已有未保存内容，已保留原页面；请核对后再同步|当前页面缺少图片上传控件|未找到唯一可点击的上传图文入口|Runtime\.evaluate 超时)$/.test(task.message);
}
