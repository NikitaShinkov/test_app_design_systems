export async function attachmentPreview(artifacts,id,context){
  return artifacts.download(id,context,{previewOnly:true});
}
