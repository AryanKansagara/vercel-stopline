/** Presentation uses observed proxy evidence, never inferred provider computation. */
export const nonnegative = value => Number.isFinite(value) && value >= 0 ? value : null;

export const validToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function bytes(value) { const n=nonnegative(value);
 if(n===null)return '—';
 if(n<1024)return `${n.toLocaleString()} B`;
 if(n<1048576)return `${(n/1024).toFixed(1)} KB`;
return `${(n/1048576).toFixed(2)} MB`;
 }
export const milliseconds = value => nonnegative(value)===null?'—':`${Math.round(value).toLocaleString()} ms`;

export function rate(metrics) { const b=nonnegative(metrics?.bytesReceived),d=nonnegative(metrics?.durationMs);
return b===null||!d||!Number.isFinite(b/d*1000)?'—':`${bytes(b/d*1000)}/s`;
 }
export function endpointError(value) { try { const u=new URL(value);
if(u.protocol!=='https:'||(u.port&&u.port!=='443'))return 'Use a public HTTPS URL on port 443.';
if(u.username||u.password||u.hash)return 'URL credentials and fragments are not supported.';
for(const key of u.searchParams.keys())if(/token|key|auth|password|secret|signature|credential/i.test(key))return 'Put credentials in the ephemeral API key field, not URL parameters.';
return '';
}catch{return 'Enter a complete HTTPS endpoint URL.';
} }
export function checkedRunLinks(value,origin) {if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value?.id??''))throw Error('Invalid report identifier returned.');
const base=`/api/profile-runs/${value.id}`;
for(const [key,path]of[['streamUrl',base+'/stream'],['statusUrl',base]]){const u=new URL(value[key],origin);
if(u.origin!==origin||u.pathname!==path||u.search||u.hash)throw Error('Unexpected report URL returned.');
}return{id:value.id,streamUrl:base+'/stream',statusUrl:base};
}
export function thresholdReached(config,chunks,elapsed) {return (Number.isInteger(config.cancelAfterChunks)&&chunks>=config.cancelAfterChunks)||(Number.isInteger(config.cancelAfterMs)&&elapsed>=config.cancelAfterMs);
}
export function cleanResources(value){return value?.activeRequest===false&&value.activeTimers===0;
}
const metricKeys=['ttfbMs','bytesReceived','chunksReceived','bytesAfterCancel','chunksAfterCancel','clientCancelledAtMs','upstreamAborted','upstreamClosed','upstreamEnded','durationMs','headersMs','upstreamStatus','upstreamAbortRequested'];

export function safeReport(report) {const c=report.configuration??{},configuration={};
for(const k of ['mode','policy','cancelAfterChunks','cancelAfterMs','model','maxTokens','promptLength'])if(['string','number','boolean'].includes(typeof c[k])||c[k]===null)configuration[k]=c[k];
try{const u=new URL(c.endpoint);
u.username='';
u.password='';
u.search='';
u.hash='';
configuration.endpoint=u.toString();
}catch{configuration.endpoint='Unavailable';
}const metrics={};
for(const k of metricKeys){const v=report.metrics?.[k];
metrics[k]=typeof v==='boolean'?v:nonnegative(v);
}return{id:String(report.id??''),status:String(report.status??'unknown'),terminal:report.terminal===true,createdAt:report.createdAt,startedAt:report.startedAt,observability:{providerCompute:'not observable',providerBilling:'not observable',responseBodiesPersisted:false},configuration,metrics,events:(Array.isArray(report.events)?report.events:[]).slice(0,1000).map(e=>({sequence:nonnegative(e.sequence),atMs:nonnegative(e.atMs),kind:String(e.kind??'event').slice(0,100),...(nonnegative(e.bytes)!==null?{bytes:e.bytes}:{})})),cleanup:report.cleanup?{activeRequest:report.cleanup.activeRequest,activeTimers:nonnegative(report.cleanup.activeTimers)}:null,error:report.error?String(report.error).slice(0,500):null};
}
export function outcomeFor(run) {if(!run)return{tone:'idle',title:'A useful profile starts with your endpoint.',description:'Nothing runs until you start a profile. Metrics and lifecycle events come from the actual request.'};
if(run.error)return{tone:'error',title:'Observation needs attention',description:run.error+' Provider work and cleanup cannot be inferred.'};
const s=run.latest,m=s?.metrics;
if(s&&['error','timeout','interrupted'].includes(s.status))return{tone:'warning',title:`Profile ${s.status}`,description:s.error||'The request ended at an operational limit. Inspect the recorded connection events.'};
if(m?.clientCancelledAtMs!==null&&nonnegative(m?.clientCancelledAtMs)!==null){if(m.upstreamAborted)return{tone:'success',title:'Upstream abort observed',description:'The proxy aborted its upstream connection. Internal provider computation and billing remain unobservable.'};
if(m.bytesAfterCancel>0)return{tone:s.terminal?'warning':'active',title:s.terminal?'Post-disconnect evidence saved':'Still observing upstream',description:`${bytes(m.bytesAfterCancel)} arrived at the proxy after the client disconnected. This measures received data, not provider computation.`};
return{tone:s?.terminal?'success':'active',title:s?.terminal?'Disconnected profile saved':'Following the upstream connection',description:'The proxy observed the client disconnect. Waiting for connection lifecycle evidence does not establish provider work stopped.'};
}if(s?.terminal)return{tone:'success',title:'Profile completed',description:'The connection ended before a cancellation was observed. Actual timings, bytes and events are saved.'};
if(run.streamError)return{tone:'warning',title:'Browser stream interrupted',description:run.streamError+' Proxy observations are shown separately; a stream error does not prove provider cancellation.'};
if(run.cancelRequested)return{tone:'active',title:'Client stream closed',description:'Waiting for the proxy to confirm the disconnect and upstream connection state.'};
return{tone:'active',title:run.browserChunks?'Receiving the actual response':'Connecting to your endpoint',description:'The browser preview is ephemeral. The proxy records timing and byte evidence in your private report.'};
}
