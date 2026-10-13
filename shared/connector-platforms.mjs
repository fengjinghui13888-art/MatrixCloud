// Stable package identities shared by downloads and maintenance release exports.
export const CONNECTOR_PLATFORMS = Object.freeze([
  {id:'windows',label:'Windows x64（10/11）',filename:'matrix-cloud-windows-connector.zip',source:'windows-connector'},
  {id:'mac-arm64',label:'Mac Apple 芯片（macOS 11+）',filename:'matrix-cloud-mac-apple-silicon-connector.zip',source:'mac-connector-arm64'},
  {id:'mac-intel',label:'Mac Intel（macOS 11+）',filename:'matrix-cloud-mac-intel-connector.zip',source:'mac-connector-x64'},
  {id:'windows-arm64',label:'Windows ARM64（10/11）',filename:'matrix-cloud-windows-arm64-connector.zip',source:'windows-connector-arm64'},
  {id:'windows-x86',label:'Windows 32位（10）',filename:'matrix-cloud-windows-x86-connector.zip',source:'windows-connector-x86'},
  {id:'linux-x64',label:'Linux x64（glibc 2.28+）',filename:'matrix-cloud-linux-x64-connector.zip',source:'linux-connector-x64'},
  {id:'linux-arm64',label:'Linux ARM64（glibc 2.28+）',filename:'matrix-cloud-linux-arm64-connector.zip',source:'linux-connector-arm64'},
]);
