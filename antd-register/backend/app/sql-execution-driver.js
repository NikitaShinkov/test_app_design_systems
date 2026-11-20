import net from 'node:net';
import tls from 'node:tls';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {readFileSync} from 'node:fs';
import path from 'node:path';

const require=createRequire(import.meta.url);
const requireFromPg=createRequire(require.resolve('pg'));
function dependencyVersion(name){let directory=path.dirname(requireFromPg.resolve(name));for(let depth=0;depth<5;depth++,directory=path.dirname(directory)){try{const value=JSON.parse(readFileSync(path.join(directory,'package.json'),'utf8'));if(value.name===name)return value.version;}catch{}}return 'UNAVAILABLE';}
export const sqlDriverVersion=require('pg/package.json').version;
export const supportedSqlDriverVersion='8.23.1';
export const sqlProtocolVersion=dependencyVersion('pg-protocol');
export const supportedSqlProtocolVersion='1.16.1';
export const sqlPoolVersion=dependencyVersion('pg-pool');
export const supportedSqlPoolVersion='3.14.0';
const failure=()=>Object.assign(Error('SQL execution could not be verified. Check the saved result before retrying.'),{status:503,code:'SQL_EXECUTION_UNCERTAIN',outcome:'UNKNOWN',retryable:false});
const unsupported=()=>Object.assign(Error('This SQL query or transport is unsupported by the execution policy.'),{status:500,code:'SQL_EXECUTION_UNSUPPORTED',outcome:'NOT_STARTED',retryable:false});
export function assertSqlDriverCompatibility(){if(sqlDriverVersion!==supportedSqlDriverVersion||sqlProtocolVersion!==supportedSqlProtocolVersion||sqlPoolVersion!==supportedSqlPoolVersion)throw unsupported();return true;}

// Version-reviewed pg8.23.1 / pg-protocol1.16.1: startup is protocol3.0,
// BackendKeyData and CancelRequest use signed int32 PID/key. No activeQuery,
// query_timeout or promise rejection is used as server settlement evidence.
export function assertSqlClient(client){
  assertSqlDriverCompatibility();
  if(!client?.connection?.on||typeof client.getTransactionStatus!=='function'||client.pipeline||client.connectionParameters?.query_timeout||!Number.isInteger(client.processID)||!Number.isInteger(client.secretKey)||!['I','T','E'].includes(client.getTransactionStatus()))throw unsupported();
  const p=client.connectionParameters;
  if(!p||typeof p.host!=='string'||!Number.isInteger(Number(p.port))||!['postgres','direct'].includes(client.sslNegotiation||p.sslnegotiation||'postgres')||p.ssl&&typeof p.ssl!=='boolean'&&typeof p.ssl!=='object')throw unsupported();
}

/** Callback ErrorResponse precedes ReadyForQuery. Await BOTH; a broken wire
 * is UNKNOWN, and invokes the fatal hook synchronously before rejection. */
export function sqlWireQuery(client,text,values,{timeoutMs,onUncertain}){
  return new Promise((resolve,reject)=>{
    let callback=false,ready=false,result,error,finished=false;
    const connection=client.connection;
    const clean=()=>{clearTimeout(timer);connection.removeListener('readyForQuery',onReady);client.removeListener('error',onBroken);client.removeListener('end',onBroken);};
    const finish=()=>{if(finished||!callback||!ready)return;finished=true;clean();if(error)reject(error);else resolve({result,status:client.getTransactionStatus()});};
    const unknown=()=>{if(finished)return;finished=true;clean();const value=failure();onUncertain(value);reject(value);};
    const onReady=message=>{if(!['I','T','E'].includes(message?.status))return unknown();ready=true;finish();};
    const onBroken=()=>unknown();
    const timer=setTimeout(unknown,Math.max(1,Math.ceil(timeoutMs)));
    connection.once('readyForQuery',onReady);client.once('error',onBroken);client.once('end',onBroken);
    try{client.query(text,values,(err,value)=>{callback=true;error=err;result=value;finish();});}catch{unknown();}
  });
}

let cancelTail=Promise.resolve();
/** At most ONE transient cancellation socket in this module/process. Queue
 * wait consumes the transport budget. The protocol key defeats PID reuse;
 * the target lease is never reused even if cancellation races completion. */
export function sqlProtocolCancel(client,{timeoutMs}){
  const deadline=performance.now()+timeoutMs;
  const task=cancelTail.then(()=>cancelSocket(client,deadline));
  cancelTail=task.catch(()=>{});return task;
}

function cancelSocket(client,deadline){
  return new Promise((resolve,reject)=>{
    if(performance.now()>=deadline)return reject(failure());
    const p=client.connectionParameters,original=client.connection.stream,negotiation=client.sslNegotiation||p.sslnegotiation||'postgres';
    const packet=Buffer.alloc(16);packet.writeInt32BE(16,0);packet.writeInt32BE(80877102,4);packet.writeInt32BE(client.processID,8);packet.writeInt32BE(client.secretKey,12);
    let socket,finished=false,written=false;
    const timer=setTimeout(()=>finish(false),Math.max(1,Math.ceil(deadline-performance.now())));
    const finish=ok=>{if(finished)return;finished=true;clearTimeout(timer);packet.fill(0);const complete=()=>ok?resolve():reject(failure());if(!socket||socket.closed)return complete();socket.once('close',complete);socket.destroy();};
    // Consume any rejection bytes too. A paused readable can otherwise retain
    // the peer's FIN and falsely turn a rejected stale-key request into a hang.
    const monitor=stream=>{stream.once('error',()=>finish(false));stream.once('end',()=>finish(written));stream.once('close',()=>finish(written));stream.resume();};
    const send=()=>{socket.end(packet,()=>{written=true;packet.fill(0);});};
    const encrypt=()=>{
      // pg hides ssl.key as non-enumerable; spreading the object would silently
      // drop a mutual-TLS private key. Copy its own named options explicitly.
      // Mirror pg's upgradeToSSL: retain host for IP certificate verification;
      // DNS SNI verifies the original hostname. Without host, tls.connect on
      // an existing socket silently checks an IP connection as 'localhost'.
      const options={host:p.host,...(typeof p.ssl==='object'?Object.fromEntries(Object.getOwnPropertyNames(p.ssl).map(key=>[key,p.ssl[key]])):{}),socket};
      if(!net.isIP(p.host))options.servername=p.host;
      if(negotiation==='direct')options.ALPNProtocols=['postgresql'];
      try{socket=tls.connect(options,send);monitor(socket);}catch{finish(false);}
    };
    try{
      // Connect to the actual peer, keeping the original hostname for TLS
      // verification; a DNS change cannot redirect this backend's cancel key.
      const local=p.host.startsWith('/');
      socket=net.createConnection(local?{path:p.host+'/.s.PGSQL.'+p.port}:{host:original.remoteAddress||p.host,port:original.remotePort||Number(p.port)});
      monitor(socket);socket.once('connect',()=>{
        if(!p.ssl)return send();
        if(negotiation==='direct')return encrypt();
        const request=Buffer.alloc(8);request.writeInt32BE(8,0);request.writeInt32BE(80877103,4);
        socket.once('data',bytes=>{if(bytes.length!==1||bytes[0]!==83)return finish(false);encrypt();});socket.write(request);
      });
    }catch{finish(false);}
  });
}
