'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { buildNativeGeminiBody, createNativeGeminiHandler, wrapToolMetadata } = require('../src/native-gemini.cjs');
const fixture = { model: 'gemini-4-argon', chat_completion_source: 'makersuite', max_tokens: 1024, messages: [{role:'user',content:'Hello'}] };
const runtime = { async getNativeGeminiHelpers() { return { GEMINI_SAFETY: [{category:'safe'}], VERTEX_SAFETY: [], convertGooglePrompt(messages) { return { contents: messages.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: message.tool_calls ? message.tool_calls.map(call => ({functionCall:{name:call.function.name,args:{}},thoughtSignature:call.signature})) : message.tool_call_id ? [{functionResponse:{name:'test',response:{}}}] : [{text:message.content}] })), system_instruction:{parts:[]} }; } }; } };
test('Argon thinking configuration and continuation preserve requested cap', async () => {
    const body = await buildNativeGeminiBody({...fixture, reasoning_effort:'medium',include_reasoning:true,temperature:0.2,top_p:0.1, messages:[{role:'assistant',content:'Before'}]},runtime);
    assert.deepEqual(body.generationConfig,{maxOutputTokens:1024,thinkingConfig:{includeThoughts:true,thinkingLevel:'MEDIUM'}});
    assert.equal(body.contents[0].parts[0].text,'Before'); assert.equal(body.contents[1].role,'user');
    assert.deepEqual((await buildNativeGeminiBody({...fixture,reasoning_effort:'auto'},runtime)).generationConfig.thinkingConfig,{includeThoughts:false});
    await assert.rejects(buildNativeGeminiBody({...fixture,max_tokens:1048577},runtime),/token limit/);
});
test('tool signatures restore original IDs after host randomization', async () => {
    const wrapped = wrapToolMetadata({candidates:[{content:{parts:[{functionCall:{id:'original',name:'test',args:{}},thoughtSignature:'opaque'},{text:'text',thoughtSignature:'plain'}]}}]});
    const parts=wrapped.candidates[0].content.parts;
    assert.equal(parts[1].thoughtSignature,'plain');
    const body = await buildNativeGeminiBody({...fixture,messages:[{role:'assistant',tool_calls:[{id:'random',signature:parts[0].thoughtSignature,function:{name:'test',arguments:'{}'}}]},{role:'tool',tool_call_id:'random',content:'ok'}]},runtime);
    assert.equal(body.contents[0].parts[0].functionCall.id,'original'); assert.equal(body.contents[0].parts[0].thoughtSignature,'opaque'); assert.equal(body.contents[1].parts[0].functionResponse.id,'original');
});
function request(body,user={directories:{root:'test'}}) { return Object.assign(new EventEmitter(),{body,user}); }
function response() { return Object.assign(new EventEmitter(),{status(value){this.statusCode=value;return this;},json(value){this.data=value;return this;},setHeader(){}}); }
test('handler refuses unauthenticated and forged proxy destinations before fetch', async () => {
    let fetched=false; const handler=createNativeGeminiHandler({runtime,loopbackTransport:{baseUrl:'http://127.0.0.1:1234'},fetchImpl:()=>{fetched=true;}});
    for (const reverse_proxy of ['http://example.com/proxy/a','http://127.0.0.1:1234/proxy/a?x=1','http://127.0.0.1:1234/proxy/../a','http://127.0.0.1:1234/proxy/a/extra']) { const res=response(); await handler(request({...fixture,reverse_proxy,proxy_password:'private'}),res); assert.equal(res.statusCode,400); assert.doesNotMatch(JSON.stringify(res.data),/private|example/); }
    const res=response(); await handler(request(fixture,null),res); assert.equal(res.statusCode,401);assert.equal(fetched,false);
});
test('handler sends canonical private target and redacts upstream errors', async () => {
    let seen; const handler=createNativeGeminiHandler({runtime,loopbackTransport:{baseUrl:'http://127.0.0.1:1234'},fetchImpl:async(url,options)=>{seen={url,options};return {ok:false,status:429};}});
    const res=response();await handler(request({...fixture,reverse_proxy:'http://127.0.0.1:1234/proxy/ticket',proxy_password:'private'}),res);
    assert.equal(seen.url.pathname,'/proxy/ticket/v1beta/models/gemini-4-argon:generateContent');assert.equal(seen.url.searchParams.get('key'),'private');assert.equal(res.statusCode,429);assert.doesNotMatch(JSON.stringify(res.data),/private|127/);
});
test('nonstream retains tool-only response and reasoning metadata', async () => {
    const data={candidates:[{content:{role:'model',parts:[{thought:true,text:'think'},{functionCall:{id:'id',name:'test',args:{}}}]}}],usageMetadata:{totalTokenCount:4}};
    const handler=createNativeGeminiHandler({runtime,loopbackTransport:{baseUrl:'http://127.0.0.1:1234'},fetchImpl:async()=>({ok:true,json:async()=>data})});const res=response();
    await handler(request({...fixture,reverse_proxy:'http://127.0.0.1:1234/proxy/ticket',proxy_password:'private'}),res);assert.equal(res.data.choices[0].message.content,'');assert.equal(res.data.responseContent.parts[0].text,'think');assert.equal(res.data.usageMetadata.totalTokenCount,4);
});
test('actual host converter fixture preserves separate signed assistant parts and media', async t => {
    const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
    const filename=path.resolve(__dirname,'../../SillyTavern-1.18.0/src/prompt-converters.js');
    if (!fs.existsSync(filename)) return t.skip('Optional host source fixture is unavailable');
    const source=fs.readFileSync(filename,'utf8');
    const start=source.indexOf('export function convertGooglePrompt(');const end=source.indexOf('\n/**',start);
    assert.ok(start>=0 && end>start);
    const converter=vm.runInNewContext('('+source.slice(start,end).replace('export function','function')+')',{enableThoughtSignatures:true,GEMINI_MEDIA_RESOLUTION:{},tryParse:JSON.parse});
    const actual={async getNativeGeminiHelpers(){return {convertGooglePrompt:converter,GEMINI_SAFETY:[],VERTEX_SAFETY:[]};}};
    const body=await buildNativeGeminiBody({...fixture,messages:[{role:'user',content:'same'},{role:'assistant',content:'same',signature:'one'},{role:'assistant',content:[{type:'text',text:'same'},{type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}}],signature:'two'}]},actual);
    assert.equal(body.contents[0].parts[0].thoughtSignature,undefined);
    const signed=body.contents[1].parts.filter(part=>part.thoughtSignature);
    assert.deepEqual(JSON.parse(JSON.stringify(signed.map(part=>[part.text,part.thoughtSignature]))),[['same','one'],['same','two']]);
    assert.ok(body.contents[1].parts.some(part=>part.inlineData?.data==='AAAA'));
    assert.doesNotMatch(JSON.stringify(body),/STPG/);
});

test('stream wraps tool metadata, preserves text signatures and aborts on disconnect', async () => {
    const {Writable}=require('node:stream');
    const frames=[{candidates:[{content:{parts:[{text:'answer',thoughtSignature:'plain'}]}}]},{candidates:[{content:{parts:[{functionCall:{id:'original',name:'test',args:{}},thoughtSignature:'opaque'}]}}]}];
    const encoded=Buffer.from(frames.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join(''));
    let signal;const handler=createNativeGeminiHandler({runtime,loopbackTransport:{baseUrl:'http://127.0.0.1:1234'},fetchImpl:async(_url,options)=>{signal=options.signal;return {ok:true,body:new ReadableStream({start(controller){controller.enqueue(encoded.subarray(0,19));controller.enqueue(encoded.subarray(19));controller.close();}})};}});
    const chunks=[];const res=new Writable({write(chunk,_encoding,callback){chunks.push(chunk);callback();}});res.setHeader=()=>{};
    await handler(request({...fixture,stream:true,reverse_proxy:'http://127.0.0.1:1234/proxy/ticket',proxy_password:'private'}),res);
    const data=Buffer.concat(chunks).toString().trim().split('\n\n').map(frame=>JSON.parse(frame.replace(/^data: /,'')));
    assert.equal(data[0].candidates[0].content.parts[0].thoughtSignature,'plain');assert.match(data[1].candidates[0].content.parts[0].thoughtSignature,/^st-vertex-paygo-tool:v1:/);assert.equal(signal.aborted,false);
    let aborted=false; const disconnect=createNativeGeminiHandler({runtime,loopbackTransport:{baseUrl:'http://127.0.0.1:1234'},fetchImpl:async(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));}))});
    const req=request({...fixture,reverse_proxy:'http://127.0.0.1:1234/proxy/ticket',proxy_password:'private'}), disconnected=response();const pending=disconnect(req,disconnected);await new Promise(resolve=>setImmediate(resolve));disconnected.emit('close');await pending;assert.equal(aborted,true);assert.equal(disconnected.data,undefined);
});
test('default local HTTP transport parses JSON and never follows redirects', async () => {
    const http=require('node:http');const {requestLoopback}=require('../src/native-gemini.cjs');
    const server=http.createServer((req,res)=>{ if(req.url==='/redirect'){res.writeHead(302,{Location:'http://example.invalid'});res.end();}else {res.setHeader('Content-Type','application/json');res.end('{"ok":true}');} });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {const base=`http://127.0.0.1:${server.address().port}`;const result=await requestLoopback(new URL(base),{method:'POST',body:'{}'});assert.deepEqual(await result.json(),{ok:true});const redirect=await requestLoopback(new URL(base+'/redirect'),{method:'POST',body:'{}'});assert.equal(redirect.status,302);assert.equal(redirect.ok,false);await redirect.body.cancel();}finally {await new Promise(resolve=>server.close(resolve));}
});
function loadHostFixture(t) {
    const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
    const filename=path.resolve(__dirname,'../../SillyTavern-1.18.0/src/prompt-converters.js');
    if(!fs.existsSync(filename)){t.skip('Optional host source fixture unavailable');return null;}
    const source=fs.readFileSync(filename,'utf8');const extract=name=>{const start=source.indexOf('export function '+name+'(');return source.slice(start,source.indexOf('\n/**',start)).replace('export function','function');};
    const context={crypto:require('node:crypto'),enableThoughtSignatures:true,GEMINI_MEDIA_RESOLUTION:{},tryParse:JSON.parse,PROMPT_PLACEHOLDER:'placeholder',PROMPT_PROCESSING_TYPE:{MERGE:'merge',MERGE_TOOLS:'merge_tools',SEMI:'semi',SEMI_TOOLS:'semi_tools',STRICT:'strict',STRICT_TOOLS:'strict_tools',SINGLE:'single',CLAUDE:'claude'}};
    return vm.runInNewContext(extract('mergeMessages')+'\n'+extract('postProcessPrompt')+'\n'+extract('convertGooglePrompt')+'\n({convertGooglePrompt,postProcessPrompt,GEMINI_SAFETY:[],VERTEX_SAFETY:[]})',context);
}
test('text metadata restores every part signature and rejects edits or different roles',async t=>{
    const helpers=loadHostFixture(t);if(!helpers)return;const actual={async getNativeGeminiHelpers(){return helpers;}};
    const {packTextSignature}=require('../src/native-gemini.cjs');const signature=packTextSignature([{text:'first',thoughtSignature:'one'},{text:'second',thoughtSignature:'two'}]);
    const body=await buildNativeGeminiBody({...fixture,messages:[{role:'assistant',content:'firstsecond',signature}]},actual);
    assert.deepEqual(JSON.parse(JSON.stringify(body.contents[0].parts)),[{text:'first',thoughtSignature:'one'},{text:'second',thoughtSignature:'two'}]);
    for (const message of [{role:'assistant',content:'firstsecond edited',signature},{role:'user',content:'firstsecond',signature}]) {
        const changed=await buildNativeGeminiBody({...fixture,messages:[message]},actual);assert.equal(changed.contents[0].parts.some(part=>part.thoughtSignature),false);
    }
});
test('actual custom prompt postprocessing runs before Google conversion',async t=>{
    const helpers=loadHostFixture(t);if(!helpers)return;
    const actual={async getNativeGeminiHelpers(){return helpers;}};
    const body=await buildNativeGeminiBody({...fixture,custom_prompt_post_processing:'single',user_name:'User',char_name:'Char',messages:[{role:'user',content:'question'},{role:'assistant',content:'answer',signature:'signature'}]},actual);
    assert.equal(body.contents.length,1);assert.equal(body.contents[0].role,'user');
    assert.match(body.contents[0].parts.map(part=>part.text??'').join(''),/User: question\n\nChar: answer/);assert.equal(body.contents[0].parts.some(part=>part.thoughtSignature),false);
});
test('stream final metadata retains all nonthought text parts and nonstream exposes explicit signature',async()=>{
    const {Writable}=require('node:stream');const {unpackTextSignature}=require('../src/native-gemini.cjs');
    const frames=[{candidates:[{content:{parts:[{thought:true,text:'reason',thoughtSignature:'reasonSig'},{text:'one',thoughtSignature:'sig1'}]}}]},{candidates:[{content:{parts:[{text:'two',thoughtSignature:'sig2'}]}}]},{candidates:[{finishReason:'STOP'}]}];
    const chunks=[];const res=new Writable({write(chunk,_enc,cb){chunks.push(chunk);cb();}});res.setHeader=()=>{};
    const handler=createNativeGeminiHandler({runtime,loopbackTransport:{baseUrl:'http://127.0.0.1:1234'},fetchImpl:async()=>({ok:true,body:new ReadableStream({start(c){c.enqueue(Buffer.from(frames.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join('')));c.close();}})})});
    await handler(request({...fixture,stream:true,reverse_proxy:'http://127.0.0.1:1234/proxy/ticket',proxy_password:'private'}),res);
    const parsed=Buffer.concat(chunks).toString().trim().split('\n\n').map(frame=>JSON.parse(frame.replace(/^data: /,'')));
    const metadata=unpackTextSignature(parsed.at(-1).candidates[0].content.parts.at(-1).thoughtSignature);
    assert.deepEqual(metadata,{parts:[{text:'one',thoughtSignature:'sig1'},{text:'two',thoughtSignature:'sig2'}],text:'onetwo'});
    const output=response();const plain=createNativeGeminiHandler({runtime,loopbackTransport:{baseUrl:'http://127.0.0.1:1234'},fetchImpl:async()=>({ok:true,json:async()=>({candidates:[{content:{parts:structuredClone(metadata.parts)}}]})})});
    await plain(request({...fixture,reverse_proxy:'http://127.0.0.1:1234/proxy/ticket',proxy_password:'private'}),output);
    assert.deepEqual(unpackTextSignature(output.data.nativeGeminiSignature),metadata);assert.equal(output.data.responseContent.parts.at(-1).thoughtSignature,output.data.nativeGeminiSignature);
});
test('local HTTP nonstream reader handles delayed chunks without web-stream preconsumption',async()=>{
    const http=require('node:http');const {requestLoopback}=require('../src/native-gemini.cjs');
    const server=http.createServer((_req,res)=>{res.write('{"text":"');setTimeout(()=>{res.write('first');setTimeout(()=>res.end('second"}'),15);},15);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {const result=await requestLoopback(new URL(`http://127.0.0.1:${server.address().port}`),{method:'POST',body:'{}'});await new Promise(resolve=>setTimeout(resolve,60));assert.deepEqual(await result.json(),{text:'firstsecond'});}finally {await new Promise(resolve=>server.close(resolve));}
});
