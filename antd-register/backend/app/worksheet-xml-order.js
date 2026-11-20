// ISO29500 CT_SheetPr is a sequence: tabColor, outlinePr, pageSetUpPr.
// ExcelJS4's loaded-sheet writer emits pageSetUpPr before outlinePr. Excel
// may replace that entire worksheet while repairing it. Reorder only these
// known leaf elements; preserve every original attribute/value and all other
// worksheet bytes. This is not a general XML validator.
export function canonicalWorksheetProperties(xml){
  return xml.replace(/(<sheetPr\b[^>]*>)([\s\S]*?)(<\/sheetPr>)/, (whole,start,body,end)=>{
    const pattern=/<(tabColor|outlinePr|pageSetUpPr)\b[^>]*\/>/g;
    const children=[...body.matchAll(pattern)];
    if(!children.length||body.replace(pattern,'').trim()||new Set(children.map(item=>item[1])).size!==children.length)return whole;
    const order={tabColor:0,outlinePr:1,pageSetUpPr:2};
    if(children.every((item,index)=>!index||order[children[index-1][1]]<=order[item[1]]))return whole;
    return start+children.sort((a,b)=>order[a[1]]-order[b[1]]).map(item=>item[0]).join('')+end;
  });
}
