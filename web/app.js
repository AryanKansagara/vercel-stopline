import {validToken,bytes,milliseconds,rate,endpointError,checkedRunLinks,cleanResources,safeReport,outcomeFor} from './model.js';

const $=id=>document.getElementById(id), el=(tag,text,cls)=>{const n=document.createElement(tag);
if(text!==undefined)n.textContent=text;
if(cls)n.className=cls;
return n;
};

const TOKEN_KEY='stopline.workspace.v1';
let token='',storageAvailable=true,current=null,history=[],selected=new Set(),busy=false,historyBusy=false,disposed=false,deletion=null;

try{const saved=localStorage.getItem(TOKEN_KEY);
if(validToken(saved))token=saved;
}catch{storageAvailable=false;
}
function announce(text){$('announcement').textContent=text;
}
function message(text=''){ $('workspace-message').hidden=!text;
$('workspace-message').textContent=text;
 }
function workspaceLabel(){ $('workspace-status').textContent=token?(storageAvailable?'Private workspace':'Session workspace'):'Browser workspace';
$('delete-workspace').disabled=!token||busy;
 }
async function request(path,{method='GET',body,signal}={}){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
const relay=()=>controller.abort();
signal?.addEventListener('abort',relay,{once:true});
try{const response=await fetch(path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:controller.signal,cache:'no-store'});
if(!response.ok){let error;
try{error=(await response.json()).error;
}catch{}throw Error(typeof error==='string'?error.slice(0,350):`Request failed (${response.status}).`);
}return response.status===204?null:await response.json();
}finally{clearTimeout(timer);
signal?.removeEventListener('abort',relay);
}}
async function ensureWorkspace(){if(token)return;
const result=await request('/api/workspaces',{method:'POST',body:{}});
if(!validToken(result.token))throw Error('The server returned an invalid workspace token.');
token=result.token;
try{localStorage.setItem(TOKEN_KEY,token);
}catch{storageAvailable=false;
message('Browser storage is unavailable. This session can access your reports until this page closes; export anything you want to keep.');
}workspaceLabel();
}
function setBusy(value){busy=value;
$('request-fields').disabled=value;
$('start-profile').disabled=value;
$('start-label').textContent=value?'Profiling endpoint…':'Profile endpoint';
$('load-example').disabled=value;
$('cancel-stream').disabled=!value||!current?.streamController||current.cancelRequested||current.streamDone;
workspaceLabel();
}
function switchView(view){if(!['profile','history','compare'].includes(view))view='profile';
for(const name of ['profile','history','compare'])$(name+'-view').hidden=name!==view;
document.querySelectorAll('.nav-item').forEach(button=>{button.classList.toggle('active',button.dataset.view===view);if(button.dataset.view===view)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
$('view-name').textContent={profile:'New profile',history:'Saved profiles',compare:'Compare runs'}[view];
if(location.hash!==`#${view}`)historyReplace(view);
if(view!=='profile'&&token)loadHistory();
}
function historyReplace(view){window.history.replaceState(null,'',`#${view}`);
}
document.addEventListener('click',event=>{const button=event.target.closest('[data-view]');if(button)switchView(button.dataset.view);});
window.addEventListener('hashchange',()=>switchView(location.hash.slice(1)));
$('open-history').onclick=()=>switchView('history');

function updateMode(){const open=document.querySelector('[name=mode]:checked').value==='openai';
$('openai-fields').hidden=!open;
$('openai-fields').disabled=!open;
}
function updateThreshold(){const value=$('cancel-trigger').value;
for(const [id,show]of[['chunks',value!=='time'],['time',value!=='chunks']]){ $(id+'-control').hidden=!show;
$(id==='chunks'?'cancel-chunks':'cancel-ms').disabled=!show;
}}
document.querySelectorAll('[name=mode]').forEach(n=>n.onchange=updateMode);
$('cancel-trigger').onchange=updateThreshold;

$('load-example').onclick=()=>{document.querySelector('[name=mode][value=get]').checked=true;
updateMode();
$('endpoint').value='https://httpbin.org/stream/20';
message('Example loaded, not started. This public endpoint streams 20 JSON lines and may finish before your cancellation threshold. You can replace it with your own endpoint.');
$('endpoint').focus();
};

function clearTimers(ctx){clearTimeout(ctx.cancelTimer);
clearTimeout(ctx.pollTimer);
}
function cancel(ctx,reason='manual'){if(current!==ctx||ctx.streamDone||ctx.cancelRequested)return;
ctx.cancelRequested=reason;
clearTimeout(ctx.cancelTimer);
ctx.streamController?.abort();
$('cancel-stream').disabled=true;
render();
announce('Browser stream cancellation requested. Waiting for proxy evidence.');
}
$('cancel-stream').onclick=()=>current&&cancel(current);

function render(){const ctx=current,s=ctx?.latest,m=s?.metrics,outcome=outcomeFor(ctx);
$('result-callout').className='result-callout '+outcome.tone;
$('result-title').textContent=outcome.title;
$('result-description').textContent=outcome.description;
$('result-icon').textContent={success:'✓',warning:'!',error:'!',active:'⌁',idle:'◌'}[outcome.tone];
$('metric-ttfb').textContent=milliseconds(m?.ttfbMs);
$('metric-bytes').textContent=bytes(m?.bytesReceived);
$('metric-after').textContent=bytes(m?.bytesAfterCancel);
$('metric-rate').textContent=rate(m);
$('report-status').textContent=s?.status??(busy?'Opening request':'Awaiting a profile');
const badge=$('stream-badge');
badge.textContent=ctx?(ctx.streamDone?(ctx.cancelRequested?'Client disconnected':ctx.reopened?'Saved report':'Client stream ended'):'Connecting / receiving'):'Not connected';
badge.className='stream-badge '+(ctx?.error?'error':ctx?.streamDone?'stopped':ctx?'active':'');
$('browser-counts').textContent=ctx?.reopened?'Browser counts not retained':`${ctx?.browserChunks??0} chunks · ${bytes(ctx?.browserBytes??0)}`;
const clean=s?.terminal&&cleanResources(s.cleanup);
$('cleanup-status').textContent=clean?'Proxy cleanup confirmed':ctx?(s?.terminal?'Cleanup not confirmed':'Observing connection lifecycle'):'No request in progress';
$('cleanup-status').parentElement.classList.toggle('clean',!!clean);
$('export-report').disabled=!s?.id;
$('report-identity').textContent=s?.id?`Report ${s.id.slice(0,8)} · ${s.terminal?'saved':'observing'}`:'Private reports are saved automatically.';

 const events=s?.events??[];
$('event-count').textContent=String(events.length);
const list=$('timeline');
list.replaceChildren();
if(!events.length)list.append(el('li',ctx?'Waiting for observed events…':"Your request’s lifecycle will appear here.",'timeline-empty'));
for(const event of events){const li=el('li',undefined,/cancel|abort/.test(event.kind)?'cancel':/clos|end|complete/.test(event.kind)?'complete':'');
li.append(el('span','', 'timeline-dot'),el('time',milliseconds(event.atMs)),el('span',String(event.kind).replaceAll('_',' ')),el('small',event.bytes===undefined?'':bytes(event.bytes)));
list.append(li);
}const details=$('report-details');
details.replaceChildren();
for(const [key,value]of Object.entries(s?.configuration??{})){const row=el('div');
row.append(el('dt',key.replace(/([A-Z])/g,' $1')),el('dd',value===null?'Not configured':String(value)));
details.append(row);
}if(!s)details.append(el('div','No report yet.'));
}
function resetPreview(saved=false){$('response-text').textContent='';
$('response-text').hidden=true;
$('response-placeholder').hidden=false;
$('response-placeholder').querySelector('h3').textContent=saved?'Response text is not retained.':'Your endpoint. Your evidence.';
$('response-placeholder').querySelector('p').textContent=saved?'This saved report contains actual timing, byte counts and connection events.':'Enter a public streaming URL to capture real timing, response bytes and connection events.';
$('preview-note').textContent=saved?'Saved reports contain metadata only; response previews are not retained.':'Response preview stays in this page only';
}
function appendPreview(ctx,text){if(current!==ctx)return;
const target=$('response-text');
$('response-placeholder').hidden=true;
target.hidden=false;
if(target.textContent.length<65536)target.textContent+=text.slice(0,65536-target.textContent.length);
if(ctx.browserBytes>65536)$('preview-note').textContent='Preview limited to 64 KB; byte accounting continues.';
}
async function stream(ctx,links,config){ctx.streamController=new AbortController();
const started=performance.now();
if(config.cancelAfterMs!==null)ctx.cancelTimer=setTimeout(()=>cancel(ctx,'time_threshold'),config.cancelAfterMs);
setBusy(true);
try{const response=await fetch(links.streamUrl,{headers:{Authorization:`Bearer ${token}`},signal:ctx.streamController.signal,cache:'no-store'});
if(!response.ok)throw Error(`Stream connection failed (${response.status}).`);
if(!response.body)throw Error('Streaming responses are unavailable in this browser.');
const reader=response.body.getReader(),decoder=new TextDecoder();
while(true){const {done,value}=await reader.read();
if(done)break;
if(current!==ctx)break;
ctx.browserChunks++;
ctx.browserBytes+=value.byteLength;
appendPreview(ctx,decoder.decode(value,{stream:true}));
render();
if(config.cancelAfterChunks!==null&&ctx.browserChunks>=config.cancelAfterChunks){cancel(ctx,'chunk_threshold');
break;
}}if(!ctx.cancelRequested)appendPreview(ctx,decoder.decode());
}catch(error){if(!ctx.cancelRequested&&!disposed)ctx.streamError=error.name==='AbortError'?'The stream was interrupted.':error.message;
}finally{ctx.streamDone=true;
clearTimeout(ctx.cancelTimer);
ctx.browserDuration=performance.now()-started;
if(current===ctx){$('cancel-stream').disabled=true;
render();
finishIfSettled(ctx);
}}}
function finishIfSettled(ctx){if(current===ctx&&ctx.streamDone&&(ctx.latest?.terminal||ctx.error)){setBusy(false);
loadHistory();
announce(ctx.error?'Profile observation interrupted.':'Profile finished. Saved proxy evidence is available.');
}}
async function poll(ctx,links){if(current!==ctx||disposed)return;
try{const result=await request(links.statusUrl,{signal:ctx.pollController.signal});
if(current!==ctx||disposed)return;
ctx.latest=safeReport(result);
ctx.failures=0;
render();
if(ctx.latest.terminal){clearTimeout(ctx.cancelTimer);
finishIfSettled(ctx);
return;
}}catch(error){if(current!==ctx||disposed)return;
ctx.failures=(ctx.failures??0)+1;
if(ctx.failures>=4){ctx.error=`Could not retrieve proxy evidence: ${error.message}`;
ctx.streamController?.abort();
ctx.streamDone=true;
render();
finishIfSettled(ctx);
return;
}}if(performance.now()-ctx.started>45000){ctx.error='The observation window expired. Refresh saved profiles to retrieve the latest server evidence.';
ctx.streamController?.abort();
ctx.streamDone=true;
render();
finishIfSettled(ctx);
return;
}ctx.pollTimer=setTimeout(()=>poll(ctx,links),400);
}
$('profile-form').onsubmit=async event=>{event.preventDefault();
if(busy)return;
const error=endpointError($('endpoint').value);
$('endpoint').setCustomValidity(error);
if(error){$('endpoint').reportValidity();
return;
}$('endpoint').setCustomValidity('');
const mode=document.querySelector('[name=mode]:checked').value,trigger=$('cancel-trigger').value;
const config={mode,endpoint:$('endpoint').value.trim(),policy:document.querySelector('[name=policy]:checked').value,cancelAfterChunks:trigger==='time'?null:Number($('cancel-chunks').value),cancelAfterMs:trigger==='chunks'?null:Number($('cancel-ms').value)};
if(mode==='openai')Object.assign(config,{model:$('model').value.trim(),prompt:$('prompt').value,maxTokens:Number($('max-tokens').value),apiKey:$('api-key').value});
if(current){clearTimers(current);
current.pollController?.abort();
}const ctx={browserChunks:0,browserBytes:0,streamDone:false,started:performance.now(),pollController:new AbortController()};
current=ctx;
resetPreview();
message();
setBusy(true);
render();
try{await ensureWorkspace();
const pending=request('/api/profile-runs',{method:'POST',body:config,signal:ctx.pollController.signal});
delete config.apiKey;
delete config.prompt;
$('api-key').value='';
$('prompt').value='';
const links=checkedRunLinks(await pending,location.origin);
if(disposed)return;
ctx.id=links.id;
stream(ctx,links,config);
poll(ctx,links);
}catch(error){ctx.error=error.message;
ctx.streamDone=true;
setBusy(false);
render();
announce('Profile could not start. '+error.message);
}};

$('endpoint').oninput=()=>$('endpoint').setCustomValidity('');

function labelRun(run){return `${run.configuration?.endpoint??'Endpoint'} · ${run.configuration?.policy??''} · ${run.id.slice(0,8)}`;
}
function date(value){const d=new Date(value);
return Number.isFinite(d.valueOf())?d.toLocaleString():String(value??'');
}
function emptyCard(icon,title,text,view){const box=el('div',undefined,'empty-card');
box.append(el('span',icon),el('h2',title),el('p',text));
if(view){const b=el('button','Create a profile','button button-primary');
b.dataset.view=view;
box.append(b);
}return box;
}
async function loadHistory(){if(historyBusy||!token)return;
historyBusy=true;
$('refresh-history').disabled=true;
try{const data=await request('/api/profile-runs');
history=(data.runs??[]).map(safeReport);
selected=new Set([...selected].filter(id=>history.some(r=>r.id===id)));
renderHistory();
}catch(error){message('Saved profiles could not be loaded: '+error.message);
}finally{historyBusy=false;
$('refresh-history').disabled=false;
}}
function renderHistory(){$('history-count').textContent=String(history.length);
$('history-summary').textContent=`${history.length} saved profile${history.length===1?'':'s'}`;
$('selected-count').textContent=`${selected.size} / 2`;
$('compare-selected').disabled=selected.size!==2;
const list=$('history-list');
list.replaceChildren();
if(!history.length)list.append(emptyCard('◷','A history of what actually happened.','Create your first profile to save real timing, byte counts and lifecycle events.','profile'));
for(const run of history){const row=el('article',undefined,'history-item'),check=el('input');
check.type='checkbox';
check.checked=selected.has(run.id);
check.setAttribute('aria-label',`Select ${labelRun(run)} for comparison`);
check.disabled=!check.checked&&selected.size>=2;
check.onchange=()=>{check.checked?selected.add(run.id):selected.delete(run.id);
renderHistory();
};
const info=el('div',undefined,'history-info');
info.append(el('strong',run.configuration.endpoint,'history-endpoint'),el('small',`${date(run.createdAt)} · ${run.configuration.mode?.toUpperCase()} · ${run.configuration.policy}`));
const measures=el('div',undefined,'history-measurements');
measures.append(el('strong',bytes(run.metrics.bytesReceived)),el('small',`${milliseconds(run.metrics.ttfbMs)} TTFB`));
const actions=el('div',undefined,'history-actions');
const chip=el('span',run.status,'status-chip '+(run.terminal?'complete':'')),open=el('button','Open report','button button-subtle'),remove=el('button','Delete','button button-danger-text history-delete');
open.onclick=()=>openReport(run.id);
remove.disabled=!run.terminal||busy;
remove.onclick=()=>confirmDelete(run);
actions.append(chip,open,remove);
row.append(check,info,measures,actions);
list.append(row);
}for(const id of ['compare-a','compare-b']){const select=$(id),value=select.value;
select.replaceChildren(new Option('Choose a saved profile',''));
for(const run of history)select.append(new Option(labelRun(run),run.id));
select.value=history.some(r=>r.id===value)?value:'';
}renderComparison();
workspaceLabel();
}
async function openReport(id){if(busy){message('Let the current profile settle before reopening another report.');
return;
}try{const run=safeReport(await request(`/api/profile-runs/${id}`));
if(current){clearTimers(current);
current.pollController?.abort();
}current={id,reopened:true,latest:run,streamDone:true,started:performance.now(),pollController:new AbortController()};
resetPreview(true);
switchView('profile');
render();
if(!run.terminal){setBusy(true);
poll(current,{statusUrl:`/api/profile-runs/${id}`});
}announce('Saved report opened. Response content is not retained.');
}catch(error){message('Could not open this report: '+error.message);
}}
$('refresh-history').onclick=loadHistory;
$('compare-selected').onclick=()=>{const [a,b]=[...selected];
$('compare-a').value=a;
$('compare-b').value=b;
switchView('compare');
renderComparison();
};

function renderComparison(){const a=history.find(r=>r.id===$('compare-a').value),b=history.find(r=>r.id===$('compare-b').value),box=$('comparison');
box.replaceChildren();
if(!a||!b||a.id===b.id){box.append(emptyCard('⇄','Two runs. A clearer picture.','Select two different saved profiles above.'));
return;
}const table=el('table',undefined,'comparison-table'),head=el('thead'),hr=el('tr');
hr.append(el('th','Observed evidence'),el('th',a.id.slice(0,8)),el('th',b.id.slice(0,8)));
head.append(hr);
const body=el('tbody');
for(const [name,fn]of[['Endpoint',r=>r.configuration.endpoint],['Mode',r=>r.configuration.mode],['Policy',r=>r.configuration.policy],['Status',r=>r.status],['First byte',r=>milliseconds(r.metrics.ttfbMs)],['Received bytes',r=>bytes(r.metrics.bytesReceived)],['After disconnect',r=>bytes(r.metrics.bytesAfterCancel)],['Average rate',r=>rate(r.metrics)],['Chunk threshold',r=>r.configuration.cancelAfterChunks??'Disabled'],['Time threshold',r=>milliseconds(r.configuration.cancelAfterMs)],['Upstream aborted',r=>String(r.metrics.upstreamAborted??'Unknown')],['Upstream closed',r=>String(r.metrics.upstreamClosed??'Unknown')],['Cleanup confirmed',r=>r.terminal&&cleanResources(r.cleanup)?'Yes':'Unconfirmed']]){const tr=el('tr'),th=el('th',name);
th.scope='row';
tr.append(th,el('td',String(fn(a))),el('td',String(fn(b))));
body.append(tr);
}table.append(head,body);
box.append(table);
if(JSON.stringify(a.configuration)!==JSON.stringify(b.configuration))box.append(el('p','These requests use different configurations. Differences in measurements are not attributable to cancellation policy alone.','compare-warning'));
}
$('compare-a').onchange=renderComparison;
$('compare-b').onchange=renderComparison;

$('export-report').onclick=async()=>{if(!current?.latest?.id)return;
const button=$('export-report');
button.disabled=true;
try{const report=await request(`/api/profile-runs/${current.latest.id}/export`);
const blob=new Blob([JSON.stringify(safeReport(report),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=el('a');
link.href=url;
link.download=`stopline-${current.latest.id}.json`;
link.click();
setTimeout(()=>URL.revokeObjectURL(url),1000);
announce('Private report exported without response content, prompt or API key.');
}catch(error){message('Export failed: '+error.message);
}finally{button.disabled=false;
}};

function confirmDelete(run){deletion=run??'workspace';
$('delete-title').textContent=run?'Delete this report?':'Delete this workspace?';
$('delete-description').textContent=run?'Its saved metadata and events will be permanently removed.':'All saved profiles and this browser’s workspace identity will be permanently removed. Export reports you want to keep first.';
$('confirm-delete').textContent=run?'Delete report':'Delete workspace';
$('delete-dialog').showModal();
}
$('delete-workspace').onclick=()=>confirmDelete();
$('confirm-delete').onclick=async()=>{const button=$('confirm-delete');
button.disabled=true;
try{if(deletion==='workspace'){await request('/api/workspaces/current',{method:'DELETE'});
token='';
try{localStorage.removeItem(TOKEN_KEY);
}catch{}history=[];
selected.clear();
current=null;
resetPreview();
render();
renderHistory();
workspaceLabel();
}else{await request(`/api/profile-runs/${deletion.id}`,{method:'DELETE'});
if(current?.id===deletion.id){clearTimers(current);
current=null;
resetPreview();
render();
}await loadHistory();
}$('delete-dialog').close();
announce('Deletion completed.');
}catch(error){$('delete-description').textContent='Deletion failed: '+error.message;
}finally{button.disabled=false;
}};

const tabs=[$('timeline-tab'),$('details-tab')];
function tabSelect(index){tabs.forEach((tab,i)=>{tab.setAttribute('aria-selected',String(i===index));tab.tabIndex=i===index?0:-1;$(tab.getAttribute('aria-controls')).hidden=i!==index;});
}tabs.forEach((tab,index)=>{tab.onclick=()=>tabSelect(index);tab.onkeydown=event=>{let next;if(['ArrowRight','ArrowLeft'].includes(event.key))next=1-index;if(event.key==='Home')next=0;if(event.key==='End')next=1;if(next!==undefined){event.preventDefault();tabSelect(next);tabs[next].focus();}};});

window.addEventListener('pagehide',()=>{disposed=true;if(current){clearTimers(current);current.pollController?.abort();current.streamController?.abort();}});

workspaceLabel();
updateMode();
updateThreshold();
switchView(location.hash.slice(1));
if(token)loadHistory();
