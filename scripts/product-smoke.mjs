/** No external calls: exercise durable authenticated product API and SSRF refusal in running container. */
import assert from 'node:assert/strict';
const base=process.env.BASE_URL??'http://127.0.0.1:3000';
let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(base+'/readyz')).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready,'product backend readiness');
const made=await fetch(base+'/api/workspaces',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(made.status,201);const {token}=await made.json();assert.match(token,/^[0-9a-f]{64}$/);
const headers={authorization:'Bearer '+token,'content-type':'application/json'};
assert.equal((await fetch(base+'/api/profile-runs',{headers})).status,200);
const denied=await fetch(base+'/api/profile-runs',{method:'POST',headers,body:JSON.stringify({mode:'get',endpoint:'https://127.0.0.1/',policy:'propagate',cancelAfterChunks:1,cancelAfterMs:null})});assert.equal(denied.status,400);
assert.equal((await fetch(base+'/api/workspaces/current',{method:'DELETE',headers})).status,204);
assert.equal((await fetch(base+'/api/profile-runs',{headers})).status,401);
console.log(JSON.stringify({productApi:'pass',ssrfLoopback:'refused',workspaceDeletion:'pass',externalCalls:0}));
