/** Public operational readiness deliberately excludes process IDs, host/store
 * identities, database names, filesystem paths and reservation ownership. */
export async function executionReadiness(runtime){
  const mode=runtime.processRole,accepting=Boolean(runtime.started&&!runtime.closing&&!runtime.fatalError);
  let database=false,execution=false,worker=false;
  if(accepting){
    try{const health=await runtime.appStorage.health();database=Boolean(health&&typeof health==='object'&&health.ok!==false);}catch{}
    if(database){
      if(runtime.coordinator){
        try{execution=await runtime.coordinator.ready()===true;worker=execution&&await runtime.coordinator.ready({role:'worker'})===true;}catch{}
      }else execution=worker=mode==='combined';
    }
  }
  const requiresOperatorReview=[runtime.preparations,runtime.commandJobs,runtime.preparationRunner,runtime.commandRunner].some(source=>source?.originRefusalStatus?.requiresOperatorReview===true);
  const ready=accepting&&database&&execution&&worker&&!requiresOperatorReview;
  return {ok:ready,ready,mode,checks:{database,execution,worker},...(requiresOperatorReview?{requiresOperatorReview:true}:{})};
}
