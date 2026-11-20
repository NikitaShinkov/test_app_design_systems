import {classifyProposal,createHistoryIndex,historyFor} from './domain.js';
import {cleanText,productPairKey,recordKey} from './normalization.js';
import {validateDecision} from './validation.js';

/** Source Database.bas M10 traversal, including evidence-before-duplicate order.
 * Pure: owns its history index/key set and never modifies rows or ledger records.
 * The caller remains responsible for atomic append/audit/persistence. */
export function planDecisionRecording(proposals,replacements) {
  const history=createHistoryIndex(replacements),keys=new Set(replacements.map(recordKey).filter(Boolean));
  const plan={approvedAdded:0,rejectedAdded:0,doNotPurchaseSkipped:0,duplicateCount:0,missingDecisionDataCount:0,additions:[],dispositions:[],details:[]};
  const finding=(item,code,field,message)=>({recordId:item.proposalId,sheet:item.sourceSheet||'Check',row:item.sourceRow??null,code,field,message});
  for(const item of proposals){
    const disposition={proposalId:item.proposalId,sheet:item.sourceSheet||'Check',row:item.sourceRow??null};
    const finish=(status,more={})=>{Object.assign(disposition,{disposition:status},more);plan.dispositions.push(disposition);};
    if(item.archived){finish('ARCHIVED_SKIPPED');continue;}
    const kind=classifyProposal(item);
    if(kind==='DO NOT PURCHASE'){plan.doNotPurchaseSkipped++;finish('DO_NOT_PURCHASE_SKIPPED');continue;}
    const inferred=!kind&&historyFor(item,history).hasApproval;
    const decision=inferred?'APPROVED':kind;
    if(!['APPROVED','REJECTED'].includes(decision)){
      finish(kind==='UNKNOWN'?'UNRECOGNIZED_REPLY':'NO_FINAL_DECISION');
      if(kind==='UNKNOWN')plan.details.push(finding(item,'M10_UNRECOGNIZED_REPLY','clientDecision','Client reply is not recognized; no reusable decision was recorded.'));
      continue;
    }
    const validation=validateDecision({...item,clientDecision:decision}),errors=Object.entries(validation.errors);
    if(errors.length){
      plan.missingDecisionDataCount++;
      finish('MISSING_DECISION_DATA',{decisionStatus:decision,inferredFromHistory:inferred,fields:errors.map(([field])=>field)});
      for(const [field,message] of errors)plan.details.push(finding(item,'M10_DECISION_EVIDENCE',field,message));
      continue;
    }
    if(!productPairKey(item)){
      const fields=['productDecimalNo','origPn','altPn'].filter(field=>!cleanText(item[field]));
      finish('INVALID_REPLACEMENT_IDENTITY',{decisionStatus:decision,inferredFromHistory:inferred});
      plan.details.push(finding(item,'M10_REPLACEMENT_IDENTITY',fields.join(', ')||'productPairKey','A product decimal number and canonical original/alternative part numbers are required before recording a replacement.'));
      continue;
    }
    const proposal={...item,...validation.value,decisionStatus:decision},key=recordKey(proposal);
    if(keys.has(key)){plan.duplicateCount++;finish('DUPLICATE_SKIPPED',{decisionStatus:decision,inferredFromHistory:inferred,recordKey:key});continue;}
    const dispositionIndex=plan.dispositions.length;
    finish(`${decision}_ADDED`,{decisionStatus:decision,inferredFromHistory:inferred,recordKey:key});
    plan.additions.push({proposal,dispositionIndex});
    if(decision==='APPROVED')plan.approvedAdded++;else plan.rejectedAdded++;
    keys.add(key);history.add(proposal);
  }
  return plan;
}

export function decisionRecordingResult(plan,databaseCount) {
  const {approvedAdded,rejectedAdded,doNotPurchaseSkipped,duplicateCount,missingDecisionDataCount,dispositions,details}=plan;
  const recorded=approvedAdded+rejectedAdded;
  return {
    recorded,duplicatesSkipped:duplicateCount,databaseCount,affected:recorded,
    blocked:dispositions.filter(item=>['MISSING_DECISION_DATA','INVALID_REPLACEMENT_IDENTITY'].includes(item.disposition)).length,
    approvedAdded,rejectedAdded,doNotPurchaseSkipped,duplicateCount,missingDecisionDataCount,
    dispositions,details,
    message:`Database update complete. APPROVED added: ${approvedAdded}; REJECTED added: ${rejectedAdded}; DO NOT PURCHASE skipped (not stored): ${doNotPurchaseSkipped}; Duplicates skipped: ${duplicateCount}; Missing required decision data: ${missingDecisionDataCount}.`
  };
}
