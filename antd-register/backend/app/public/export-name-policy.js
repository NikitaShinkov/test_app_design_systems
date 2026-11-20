// Version remains part of the retained export identity even when the first
// M01 template omits its suffix from the visible filename.
export function exportVersionSuffix(version,moduleId){return moduleId==='M01'&&version===1?'':`_v${version}`;}
export function canonicalExportFilename(name,version,moduleId){
  const base=String(name).replace(/_v\d+(?=\.[^.]+$)/i,'');
  return base.replace(/(\.[^.]+)$/,`${exportVersionSuffix(version,moduleId)}$1`);
}
