/** Fixed-destination, authenticated metadata/body relay; never accepts an outbound destination. */
const ORIGIN='https://stopline-production-05c5.up.railway.app';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const safeHeaders={'cache-control':'no-store, no-transform','x-content-type-options':'nosniff'};
const error=(status,message)=>Response.json({error:message},{status,headers:safeHeaders});
export async function relay(request){
  const u=new URL(request.url),route=u.searchParams.get('route'),id=u.searchParams.get('runId');
  if([...u.searchParams.keys()].some(k=>!['route','runId'].includes(k))||u.searchParams.getAll('route').length!==1||u.searchParams.getAll('runId').length>1)return error(400,'Invalid API route');
  const paths={workspaces:'/api/workspaces','workspace-current':'/api/workspaces/current',runs:'/api/profile-runs',run:`/api/profile-runs/${id}`,export:`/api/profile-runs/${id}/export`};
  const methods={workspaces:['POST'],'workspace-current':['DELETE'],runs:['GET','POST'],run:['GET','DELETE'],export:['GET']};
  if(!Object.hasOwn(paths,route)||(['run','export'].includes(route)?!UUID.test(id??''):id!==null))return error(400,'Invalid API route');
  if(!methods[route].includes(request.method))return error(405,'Method not allowed');
  const authorization=request.headers.get('authorization');
  if(route!=='workspaces'&&!/^Bearer [0-9a-f]{64}$/.test(authorization??''))return error(401,'Private workspace token required');
  let body;
  try{
    if(request.method==='POST'){
      if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''))return error(415,'JSON required');
      if(Number(request.headers.get('content-length')??0)>32768)return error(413,'Request exceeds 32768 bytes');
      const reader=request.body?.getReader(),chunks=[];let size=0;
      if(reader)while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>32768){await reader.cancel();return error(413,'Request exceeds 32768 bytes');}chunks.push(part.value);}
      body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}
    }
    const upstream=await fetch(ORIGIN+paths[route],{method:request.method,signal:request.signal,redirect:'error',cache:'no-store',body,headers:{accept:'application/json',...(body?{'content-type':'application/json'}:{}),...(authorization?{authorization}:{}),...(request.headers.get('origin')?{origin:request.headers.get('origin')}:{})}});
    return new Response(upstream.body,{status:upstream.status,headers:{...safeHeaders,'content-type':'application/json; charset=utf-8',...(route==='export'?{'content-disposition':`attachment; filename="stopline-${id}.json"`}:{})}});
  }catch{return error(request.signal.aborted?499:502,request.signal.aborted?'Client disconnected':'Backend unavailable');}
}
export default {fetch:relay};
