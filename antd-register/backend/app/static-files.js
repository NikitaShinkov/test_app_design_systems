import fs from 'node:fs/promises';
import path from 'node:path';

export const applicationCsp=["default-src 'self'","script-src 'self'","worker-src 'self'","connect-src 'self'","img-src 'self' blob: data:","font-src 'self' data:","style-src 'self' 'unsafe-inline'","object-src 'none'","base-uri 'none'","frame-ancestors 'none'"].join('; ');
export const staticMimeTypes=Object.freeze({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon','.wasm':'application/wasm','.bcmap':'application/octet-stream','.ttf':'font/ttf','.otf':'font/otf','.woff':'font/woff','.woff2':'font/woff2','.pfb':'application/x-font-type1','.icc':'application/octet-stream','.icm':'application/octet-stream','.txt':'text/plain; charset=utf-8'});
const securityHeaders=()=>({'Content-Security-Policy':applicationCsp,'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin'});
export async function serveStaticFile(request,response,pathname,{root}){
  const error=(status,text,headers={})=>{const bytes=Buffer.from(text);response.writeHead(status,{...securityHeaders(),'Content-Type':'text/plain; charset=utf-8','Content-Length':bytes.length,'Cache-Control':'no-store',...headers});response.end(request.method==='HEAD'?undefined:bytes);};
  if(!['GET','HEAD'].includes(request.method))return error(405,'Method not allowed.',{Allow:'GET, HEAD'});
  let decoded;try{decoded=decodeURIComponent(pathname);}catch{return error(400,'Invalid static asset path.');}
  if(/[\\:\x00-\x1f\x7f]/.test(decoded))return error(404,'Static asset not found.');
  const directory=path.resolve(root),relative=decoded==='/'?'index.html':decoded.replace(/^\/+/,''),filename=path.resolve(directory,relative),within=path.relative(directory,filename);
  if(!within||within==='..'||within.startsWith('..'+path.sep)||path.isAbsolute(within))return error(403,'Static asset unavailable.');
  try{
    // Reject symlinked path components, including directory links. Static files
    // are trusted release assets; uploaded/private objects have separate APIs.
    let current=directory;for(const segment of within.split(path.sep)){current=path.join(current,segment);const stat=await fs.lstat(current);if(stat.isSymbolicLink())return error(403,'Static asset unavailable.');}
    const stat=await fs.lstat(filename);if(!stat.isFile())return error(404,'Static asset not found.');
    const content=request.method==='HEAD'?null:await fs.readFile(filename),versioned=relative.startsWith('vendor/pdfjs/6.5.438/');
    response.writeHead(200,{...securityHeaders(),'Content-Type':staticMimeTypes[path.extname(filename).toLowerCase()]||'application/octet-stream','Content-Length':content?.length??stat.size,'Cache-Control':versioned?'public, max-age=31536000, immutable':'no-cache'});response.end(content||undefined);
  }catch(errorValue){if(['ENOENT','ENOTDIR'].includes(errorValue.code))return error(404,'Static asset not found.');throw errorValue;}
}
