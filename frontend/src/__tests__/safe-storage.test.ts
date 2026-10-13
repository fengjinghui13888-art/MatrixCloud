import {readSessionValue,writeSessionValue,removeSessionValue} from '../safe-storage';

test('pairing resume hint tolerates Safari storage restrictions',()=>{
 const original=Object.getOwnPropertyDescriptor(window,'sessionStorage');
 Object.defineProperty(window,'sessionStorage',{configurable:true,get(){throw new DOMException('blocked','SecurityError');}});
 try{
  expect(readSessionValue('matrix.pendingPairing')).toBeNull();
  expect(writeSessionValue('matrix.pendingPairing','{}')).toBe(false);
  expect(()=>removeSessionValue('matrix.pendingPairing')).not.toThrow();
 }finally{
  if(original)Object.defineProperty(window,'sessionStorage',original);
 }
});
