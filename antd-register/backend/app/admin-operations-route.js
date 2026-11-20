import {adminStatusError,requireStatusAdministrator} from './admin-operations-dto.js';
export async function adminOperationsStatusRoute({request,url,context,service}){
 if(url.pathname!=='/api/admin/operations/status')return null;requireStatusAdministrator(context);
 if(request.method!=='GET')return {status:405,headers:{Allow:'GET'},body:{error:'Status checks require GET.',code:'ADMIN_OPERATIONS_METHOD'}};
 if(url.searchParams.size)throw adminStatusError(422,'ADMIN_OPERATIONS_FILTER_INVALID','This status endpoint does not accept filters.');
 return {status:200,headers:{'Cache-Control':'no-store'},body:await service.status(context)};
}
