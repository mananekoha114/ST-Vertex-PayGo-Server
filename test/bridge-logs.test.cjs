'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { BridgeLogStore, MAX_CAPTURE_BYTES, redact } = require('../src/bridge-log-store.cjs');
const { createOpenAIBridge } = require('../src/openai-bridge.cjs');
const manager = () => ({ status(code) { this.code = code; return this; }, set() {}, json(value) { this.body = value; return this; } });
async function waitLogs(store, user, count) { for (let i=0;i<100;i++) { const entries = await store.read(user); if (entries.length === count) return entries; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Logs did not settle'); }
test('dedicated store isolates users, persists, redacts, bounds and recovers corruption', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-logs-')); t.after(() => fs.rm(root,{recursive:true,force:true}));
    const alice = {root:path.join(root,'alice')}, bob = {root:path.join(root,'bob')};
    const store = new BridgeLogStore({maxEntries:2});
    await store.append(alice,{id:'1',responseBody:'raw\ndata: secret\n\n'},['secret']);
    assert.equal((await new BridgeLogStore().read(alice))[0].responseBody,'raw\ndata: [redacted]\n\n');
    assert.deepEqual(await store.read(bob),[]);
    await store.append(alice,{id:'2',requestBody:'x'.repeat(MAX_CAPTURE_BYTES+5)});
    await store.append(alice,{id:'3'});
    assert.deepEqual((await store.read(alice)).map(x=>x.id),['3','2']);
    assert.equal((await store.read(alice))[1].truncated,true);
    await fs.mkdir(path.dirname(store.file(bob)),{recursive:true}); await fs.writeFile(store.file(bob),'broken'); await store.append(bob,{id:'bob'});
    await store.clear(alice); assert.deepEqual(await store.read(alice),[]); assert.equal((await store.read(bob))[0].id,'bob');
    const bounded = new BridgeLogStore({maxBytes:1024}); await bounded.append(alice,{responseBody:'x'.repeat(2000)}); assert.ok((await fs.stat(bounded.file(alice))).size<=1024);
});
test('bridge records raw JSON/SSE/errors, authenticated isolation, interruption and tolerates logging failure', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(),'bridge-api-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const directories = {root}; const store = new BridgeLogStore(); let pending;
    const stRuntime = { resolveOpenAIConnection(_req,connection){return {connection};}, async getOpenAIConfig(){return {target:'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',headers:{Authorization:'Bearer google-secret'}};} };
    const bridge = createOpenAIBridge({stRuntime,bridgeLogStore:store,upstreamRequest(_url,_options,callback){const upstream=new PassThrough(); upstream.on('finish',()=>{if (_options.method === 'GET') { const catalog=new PassThrough();catalog.statusCode=200;catalog.headers={'content-type':'application/json'};callback(catalog);catalog.end(' {"data":[{"id":"gemini-2.5-flash"}]} ');return; } pending=new PassThrough();pending.statusCode=200;pending.headers={'content-type':'text/event-stream'};callback(pending);pending.write('data: google-secret\n\n');});return upstream;}});
    const server=http.createServer((req,res)=>bridge.route(req,res)); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>{bridge.close();server.close();});
    const base=`http://127.0.0.1:${server.address().port}`; bridge.setBaseUrl(base);
    const configured=manager(); await bridge.update({user:{directories},body:{enabled:true,connection:{source:'makersuite',model:'gemini-2.5-flash'}}},configured); const apiKey=configured.body.apiKey;
    const headers={Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'};
    const malformed=' {broken'; const bad=await fetch(`${base}/openai/v1/chat/completions`,{method:'POST',headers,body:malformed}); assert.equal(bad.status,400);await bad.text();
    let logs=await waitLogs(store,directories,1);assert.equal(logs[0].requestBody,malformed);assert.match(logs[0].error,/INVALID_JSON/);
    const payload=' {"messages":[{"role":"user","content":"hello"}],"model":"st-current"} ';
    const response=await fetch(`${base}/openai/v1/chat/completions`,{method:'POST',headers,body:payload});pending.end('data: [DONE]\n\n');assert.equal(await response.text(),'data: google-secret\n\ndata: [DONE]\n\n');
    logs=await waitLogs(store,directories,2);assert.equal(logs[0].requestBody,payload);assert.equal(JSON.parse(logs[0].forwardedBody).model,'gemini-2.5-flash');assert.equal(logs[0].responseBody,'data: [redacted]\n\ndata: [DONE]\n\n');assert.equal(logs[0].interrupted,false);
    const other=manager();await bridge.getLogs({user:{directories:{root:path.join(root,'other')}}},other);assert.deepEqual(other.body.entries,[]);
    const unfinished=await fetch(`${base}/openai/v1/chat/completions`,{method:'POST',headers,body:payload});await unfinished.body.cancel();logs=await waitLogs(store,directories,3);assert.equal(logs[0].interrupted,true);assert.match(logs[0].error,/CANCELLED/);
    const early=await fetch(`${base}/openai/v1/models`,{method:'POST',headers,body:' {"wrong":"method"} '});assert.equal(early.status,405);await early.text();logs=await waitLogs(store,directories,4);assert.match(logs[0].error,/METHOD_NOT_ALLOWED/);assert.equal(logs[0].requestBody,' {"wrong":"method"} ');assert.equal(logs[0].requestIncomplete,false);
    const catalogResponse=await fetch(`${base}/openai/v1/models`,{headers});assert.equal(catalogResponse.status,200);await catalogResponse.text();logs=await waitLogs(store,directories,5);assert.equal(logs[0].upstreamResponseBody,' {"data":[{"id":"gemini-2.5-flash"}]} ');assert.ok(JSON.parse(logs[0].responseBody).data.some(item=>item.id==='st-current'));
    store.append=()=>{throw new Error('Disk unavailable');}; const failure=await fetch(`${base}/openai/v1/chat/completions`,{method:'POST',headers,body:'oops'});assert.equal(failure.status,400);await failure.text();
    store.append=async()=>{throw new Error('Disk unavailable');}; const asyncFailure=await fetch(`${base}/openai/v1/chat/completions`,{method:'POST',headers,body:'oops'});assert.equal(asyncFailure.status,400);await asyncFailure.text();
    const cleared=manager();await bridge.clearLogs({user:{directories}},cleared);assert.deepEqual(cleared.body,{ok:true,entries:[]});
});

test('bridge logs timeout before authentication completes', async t => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-timeout-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const directories={root};const store=new BridgeLogStore();
    const bridge=createOpenAIBridge({bridgeLogStore:store,timeoutMs:15,stRuntime:{resolveOpenAIConnection(_req,connection){return {connection};},getOpenAIConfig(_req,_connection,authenticate){return authenticate ? new Promise(()=>{}) : Promise.resolve({headers:{}});}}});
    const server=http.createServer((req,res)=>bridge.route(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{bridge.close();server.close();});
    const base=`http://127.0.0.1:${server.address().port}`;bridge.setBaseUrl(base);const config=manager();await bridge.update({user:{directories},body:{enabled:true,connection:{source:'makersuite',model:'gemini-2.5-flash'}}},config);
    const response=await fetch(`${base}/openai/v1/models`,{headers:{Authorization:`Bearer ${config.body.apiKey}`}});assert.equal(response.status,504);await response.text();const entries=await waitLogs(store,directories,1);assert.match(entries[0].error,/GOOGLE_TIMEOUT/);assert.equal(entries[0].status,504);
});

test('pending disk writes and partial credential capture remain bounded', async () => {
    const store=new BridgeLogStore();let release;
    store.load=async()=>[];store.save=()=>new Promise(resolve=>{release=resolve;});
    const user={root:'pending-test'};const writes=Array.from({length:4},(_,id)=>store.append(user,{id}));await store.append(user,{id:'dropped'});
    assert.equal(store.pendingWrites,4);assert.equal(store.pendingUsers.get(store.file(user)),4);
    for (const write of writes) { await new Promise(resolve=>setImmediate(resolve));release();await write; } assert.equal(store.pendingWrites,0);
    assert.equal(redact('body long-credential-prefix',['long-credential-prefix-secret']),'body [redacted]');
});
