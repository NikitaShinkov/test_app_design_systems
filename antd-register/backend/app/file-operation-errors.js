const failures=Object.freeze({
  WORKING_ORDER_UNKNOWN:Object.freeze({status:409,code:'WORKING_ORDER_UNKNOWN',message:'The selected source rows have no verified working order. Restore a complete verified legacy order before preparing this operation.',details:[]}),
  WORKING_ORDER_UNAVAILABLE:Object.freeze({status:503,code:'WORKING_ORDER_UNAVAILABLE',message:'Proposal working order could not be verified. Apply and verify migration040 before retrying this operation.',details:[]}),
  WORKING_ORDER_REVIEW_REFRESH_REQUIRED:Object.freeze({status:409,code:'WORKING_ORDER_REVIEW_REFRESH_REQUIRED',message:'This saved review predates verified proposal working order. Prepare a new review before issuing it.',details:[]}),
  FILE_STORAGE_RESERVE:Object.freeze({status:507,code:'FILE_STORAGE_RESERVE',message:'The controlled file store has insufficient free space. Ask an administrator to free or expand it, then retry the saved operation.',details:[]}),
  FILE_STORAGE_UNAVAILABLE:Object.freeze({status:503,code:'FILE_STORAGE_UNAVAILABLE',message:'The controlled file store is unavailable. Ask an administrator to check its location and permissions, then retry the saved operation.',details:[]})
});
/** Never copy a message, detail, path or stack from an operational exception. */
export function safeFileOperationFailure(error){const value=failures[error?.code];return value?{...value,details:[]}:null;}
