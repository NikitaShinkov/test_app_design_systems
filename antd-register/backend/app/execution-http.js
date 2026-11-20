/** Retain an execution credit through both real work and response-buffer
 * settlement. A disconnected HTTP client does not stop an awaited SQL task. */
export function withResponseWorkload(admission,{ownerKey,response},operation){
  if(!admission||typeof admission.run!=='function'||typeof operation!=='function')throw TypeError('Execution admission and an operation are required.');
  return admission.run({ownerKey},async()=>{
    const result=await operation();
    if(response&&(response.headersSent||response.writableEnded||response.destroyed))await responseSettled(response);
    return result;
  });
}

export function responseSettled(response){
  if(response.writableFinished||response.destroyed)return Promise.resolve();
  return new Promise(resolve=>{
    const finish=()=>{response.removeListener('finish',finish);response.removeListener('close',finish);resolve();};
    response.once('finish',finish);response.once('close',finish);
    // Cover a stream already settled between its state check and subscription.
    if(response.writableFinished||response.destroyed)finish();
  });
}
