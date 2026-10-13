import {existsSync} from 'node:fs';

export function browserBridgePath(env=process.env){
  const candidates=[env.BROWSER_BRIDGE_NODE,env.OPENCLI_NODE].filter(Boolean);
  const path=candidates.find(value=>existsSync(value));
  if(path)return path;
  throw new Error('未找到浏览器连接器运行时，请在连接设置中选择已安装的浏览器桥接，或设置 BROWSER_BRIDGE_NODE。');
}
