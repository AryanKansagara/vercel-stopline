import test from 'node:test';
import assert from 'node:assert/strict';

import {validToken,bytes,milliseconds,rate,endpointError,checkedRunLinks,thresholdReached,cleanResources,safeReport,outcomeFor} from './model.js';

const id='12345678-1234-1234-1234-123456789012';

test('workspace tokens are constrained and never accepted from arbitrary strings',()=>{assert.ok(validToken('a'.repeat(64)));for(const value of ['',null,'a'.repeat(63),'A'.repeat(64)])assert.equal(validToken(value),false);});

test('GET URLs allow ordinary parameters but refuse secret parameters and URL credentials',()=>{assert.equal(endpointError('https://example.com/stream?count=20'),'');for(const url of ['http://example.com','https://example.com:444','https://user:pass@example.com','https://example.com#frag','https://example.com?api_key=private'])assert.ok(endpointError(url));});

test('returned stream links cannot forward workspace credentials to another origin or route',()=>{const value={id,streamUrl:`/api/profile-runs/${id}/stream`,statusUrl:`/api/profile-runs/${id}`};assert.equal(checkedRunLinks(value,'https://app.example').id,id);for(const streamUrl of ['https://evil.example/stream',value.streamUrl+'?token=x','/api/workspaces',value.streamUrl+'#fragment'])assert.throws(()=>checkedRunLinks({...value,streamUrl},'https://app.example'));});

test('chunk/time thresholds respect first threshold and disabled thresholds',()=>{assert.equal(thresholdReached({cancelAfterChunks:5,cancelAfterMs:null},4,99999),false);assert.ok(thresholdReached({cancelAfterChunks:5,cancelAfterMs:null},5,0));assert.ok(thresholdReached({cancelAfterChunks:5,cancelAfterMs:500},1,500));assert.equal(thresholdReached({cancelAfterChunks:null,cancelAfterMs:500},100,499),false);});

test('unknown metrics are not zero and overflow cannot become displayed Infinity',()=>{assert.equal(bytes(null),'—');assert.equal(bytes(Infinity),'—');assert.equal(milliseconds(undefined),'—');assert.equal(rate({bytesReceived:1e308,durationMs:1e-300}),'—');assert.equal(rate({bytesReceived:12,durationMs:0}),'—');});

test('exports project only metadata, remove URL credentials/query and omit secret fields',()=>{const result=safeReport({id,status:'completed',terminal:true,configuration:{endpoint:'https://user:password@example.com/path?secret=key',mode:'openai',prompt:'SECRET',apiKey:'SECRET',model:'small'},apiKey:'SECRET',responseBody:'SECRET',metrics:{bytesReceived:4,apiKey:'SECRET'},events:[{sequence:1,atMs:1,kind:'upstream_open',prompt:'SECRET'}]});const text=JSON.stringify(result);assert.ok(!text.includes('SECRET'));assert.ok(!text.includes('password'));assert.ok(!text.includes('?'));assert.equal(result.configuration.endpoint,'https://example.com/path');assert.equal(result.metrics.ttfbMs,null);});

test('client-only cancellation never asserts upstream or provider stopped',()=>{const result=outcomeFor({cancelRequested:true,latest:{metrics:{clientCancelledAtMs:null}}});assert.equal(result.title,'Client stream closed');assert.ok(!result.title.includes('Upstream abort'));});

test('upstream abort evidence explains provider computation remains unobservable',()=>{const result=outcomeFor({latest:{metrics:{clientCancelledAtMs:10,upstreamAborted:true}}});assert.equal(result.title,'Upstream abort observed');assert.match(result.description,/billing remain unobservable/);});

test('observe policy reports real bytes after cancel, not savings',()=>{const result=outcomeFor({latest:{terminal:true,metrics:{clientCancelledAtMs:10,bytesAfterCancel:1024,upstreamAborted:false}}});assert.match(result.description,/1.0 KB/);assert.match(result.description,/not provider computation/);});

test('cleanup requires terminal owner evidence rather than missing values',()=>{assert.equal(cleanResources(null),false);assert.equal(cleanResources({activeRequest:false,activeTimers:1}),false);assert.equal(cleanResources({activeRequest:false,activeTimers:0}),true);});
