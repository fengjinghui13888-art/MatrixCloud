import type {Express} from 'express';
import type {IncomingMessage} from 'node:http';
export function configureTrustedProxy(app:Express){
 if(process.env.TRUST_LOOPBACK_PROXY==='1')app.set('trust proxy','loopback');
}
// The ingress replaces forwarded headers and connects only over loopback.
export function forwardedSecure(req:IncomingMessage){
 return process.env.TRUST_LOOPBACK_PROXY==='1'
  && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')
  && req.headers['x-forwarded-proto']==='https';
}
