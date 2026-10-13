import {gzipSync} from 'node:zlib';
export function materialArchive(files:{name:string;data:Buffer}[]){
 const chunks:Buffer[]=[];
 for(const {name,data} of files){if(!/^[\w.-]{1,99}$/.test(name)||name.includes('..'))throw Error('素材文件名无效');const h=Buffer.alloc(512);h.write(name);h.write('0000600\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(data.length.toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.fill(32,148,156);h.write('0',156);h.write('ustar\0',257);h.write('00',263);h.write([...h].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);chunks.push(h,data,Buffer.alloc((512-data.length%512)%512));}
 return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));
}
