import {randomUUID} from 'node:crypto';
import {snapshotDigest} from './export-jobs.js';
import {normalize,cleanText,workflowKey} from './normalization.js';
import {sourceMetadata} from './demo-data.js';
import {httpError} from './auth.js';

export const archiveReviewTtlMs=15*60*1000;
export function archiveAdministrator(context){if(context.role!=='ADMINISTRATOR')throw httpError(403,'Only an administrator can review or change an archived workspace.');if(context.authenticated&&!context.userId)throw httpError(401,'Sign in with your administrator account.');}
export function archiveOwner(context){archiveAdministrator(context);return context.authenticated?`USER:${context.userId}`:`PREVIEW:${snapshotDigest({role:context.role,actor:context.actor||'Local administrator'})}`;}
export function archiveRequest(body){
  if(!body||typeof body!=='object'||Array.isArray(body)||!['ARCHIVE','RESTORE'].includes(body.action))throw httpError(422,'Choose ARCHIVE or RESTORE for the workspace review.',{code:'M11_ACTION_REQUIRED'});
  const scope=body.scope;if(!scope||!['ORDER','ALL_ORDERS'].includes(scope.type))throw httpError(422,'Explicitly select one order or all orders before reviewing the workspace.',{code:'M11_SCOPE_REQUIRED'});
  if((scope.type==='ORDER'&&typeof scope.orderNo!=='string')||(body.reason!==undefined&&typeof body.reason!=='string'))throw httpError(422,'Workspace order and reason must be text.');
  const orderNo=cleanText(scope.orderNo),reason=cleanText(body.reason).trim();if(reason.length>2000)throw httpError(422,'The workspace change reason must not exceed 2,000 characters.');
  if(scope.type==='ORDER'&&!orderNo)throw httpError(422,'Select an order before reviewing its workspace.',{code:'M11_ORDER_REQUIRED'});
  if(scope.type==='ALL_ORDERS'&&orderNo)throw httpError(422,'An all-orders review cannot also identify a single order.',{code:'M11_SCOPE_INVALID'});
  if(body.action==='RESTORE'&&(scope.type!=='ORDER'||!reason))throw httpError(422,'Select one order and provide the reason for restoring its workspace.',{code:'M11_RESTORE_REASON_REQUIRED'});
  if(body.orderNo!==undefined&&normalize(body.orderNo)!==normalize(orderNo))throw httpError(409,'The submitted order differs from the reviewed workspace scope.',{code:'M11_SCOPE_CHANGED'});
  return {action:body.action,scope:scope.type==='ORDER'?{type:'ORDER',orderNo}:{type:'ALL_ORDERS'},reason};
}
export const archiveScopeRows=(rows,scope)=>scope.type==='ALL_ORDERS'?rows:rows.filter(row=>normalize(row.orderNo)===normalize(scope.orderNo));
function rowSnapshot(rows,scope){return archiveScopeRows(rows,scope).map(row=>({proposalId:row.proposalId,rowVersion:Number(row.rowVersion||1),archived:Boolean(row.archived),identity:workflowKey(row),rowHash:snapshotDigest(row)})).sort((a,b)=>String(a.proposalId).localeCompare(String(b.proposalId)));}
const sealed=review=>Object.fromEntries(Object.entries(review).filter(([key])=>!['digest','receipt'].includes(key)));
export const archiveReviewIntegrity=review=>Boolean(review&&snapshotDigest(sealed(review))===review.digest);
export const archiveReceiptIntegrity=(review,receipt)=>Boolean(receipt?.moduleId==='M11'&&receipt.result?.status==='COMPLETED'&&receipt.result.reviewId===review.reviewId&&receipt.result.reviewDigest===review.digest&&receipt.result.action===review.action&&receipt.result.affected===review.count&&receipt.result[review.action==='RESTORE'?'restored':'archived']===review.count&&receipt.result.reason===review.reason&&snapshotDigest(receipt.result.scope)===snapshotDigest(review.scope));
export function createArchiveReview(rows,catalog,context,body,{now=Date.now(),reviewId=randomUUID()}={}){
  const request=archiveRequest(body),ownerKey=archiveOwner(context),selected=archiveScopeRows(rows,request.scope),restore=request.action==='RESTORE';
  const targets=selected.filter(row=>Boolean(row.archived)===restore).map(row=>({proposalId:row.proposalId,rowVersion:Number(row.rowVersion||1),archived:Boolean(row.archived),orderNo:row.orderNo||'',supplier:row.supplier||'',product:row.product||'',productDecimalNo:row.productDecimalNo||'',origPn:row.origPn||'',altPn:row.altPn||''})).sort((a,b)=>String(a.proposalId).localeCompare(String(b.proposalId)));
  const review={reviewId,moduleId:'M11',ownerKey,actor:context.actor||'Local administrator',...request,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+archiveReviewTtlMs).toISOString(),reference:{revision:catalog.revision,hash:catalog.hash},sourceSha256:sourceMetadata.sourceSha256,snapshot:rowSnapshot(rows,request.scope),targets,count:targets.length,orderNos:[...new Set(selected.map(row=>row.orderNo||''))].sort()};
  return {...review,digest:snapshotDigest(review),receipt:null};
}
export function archiveReviewSummary(review){const {snapshot,ownerKey,receipt,...visible}=review;return {...visible,status:receipt?'COMMITTED':'READY',...(receipt?{result:receipt.result}:{})};}
export function validateArchiveConfirmation(review,rows,catalog,context,body,{now=Date.now()}={}){
  archiveAdministrator(context);if(!review||review.ownerKey!==archiveOwner(context))throw httpError(404,'Workspace review not found.',{code:'M11_REVIEW_NOT_FOUND'});
  if(!archiveReviewIntegrity(review))throw httpError(409,'The workspace review failed its integrity check. Create a new review.',{code:'M11_REVIEW_INVALID'});
  const request=archiveRequest(body);
  if(body.reviewId!==review.reviewId||body.digest!==review.digest||snapshotDigest(request)!==snapshotDigest({action:review.action,scope:review.scope,reason:review.reason}))throw httpError(409,'The action, scope or reason differs from the saved workspace review.',{code:'M11_REVIEW_CHANGED'});
  if(body.confirmation!==review.action)throw httpError(409,'Explicitly confirm the reviewed workspace action.',{code:'M11_CONFIRMATION_REQUIRED'});
  if(review.receipt){if(!archiveReceiptIntegrity(review,review.receipt))throw httpError(409,'The retained workspace receipt does not match its review.',{code:'M11_REVIEW_INVALID'});return structuredClone(review.receipt);}
  if(!Number.isFinite(Date.parse(review.expiresAt))||now>=Date.parse(review.expiresAt))throw httpError(409,'The workspace review expired. Review the current rows before confirming.',{code:'M11_REVIEW_EXPIRED'});
  if(review.sourceSha256!==sourceMetadata.sourceSha256||review.reference.revision!==catalog.revision||review.reference.hash!==catalog.hash)throw httpError(409,'Source or reference data changed after this review. Create a new workspace review.',{code:'M11_REFERENCE_CHANGED'});
  if(snapshotDigest(rowSnapshot(rows,review.scope))!==snapshotDigest(review.snapshot))throw httpError(409,'Workspace rows changed after this review. Review the current rows before confirming.',{code:'M11_ROWS_CHANGED'});
  return null;
}
export function requireArchiveReviewId(body){if(typeof body?.reviewId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.reviewId))throw httpError(428,'Prepare and explicitly confirm a current M11 workspace review before changing archive state.',{code:'M11_REVIEW_REQUIRED'});}
