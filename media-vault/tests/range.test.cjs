const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {webcrypto}=require("node:crypto");
const {MessageChannel}=require("node:worker_threads");
const SOURCE=fs.readFileSync(path.join(__dirname,"../sw.js"),"utf8");
const CHUNK_SIZE=4*1024*1024;
const encoder=new TextEncoder();

// A deterministic file spanning three real AES-GCM blocks catches truncation,
// wrong offsets, incorrect AAD and accidental use of another tab's key.
async function fixture(id="movie",size=2*CHUNK_SIZE+137){
  const key=await webcrypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  const plain=Uint8Array.from({length:size},(_,i)=>(i*31+Math.floor(i/CHUNK_SIZE))%251);
  const remote=new Map(),chunks=[];
  for(let offset=0,n=0;offset<size;offset+=CHUNK_SIZE,n++){
    const iv=webcrypto.getRandomValues(new Uint8Array(12));
    const fileId=id+"-part-"+n;
    const ciphertext=await webcrypto.subtle.encrypt({name:"AES-GCM",iv,
      additionalData:encoder.encode(id+":"+n)},key,plain.subarray(offset,offset+CHUNK_SIZE));
    remote.set(fileId,new Uint8Array(ciphertext));
    chunks.push({fileId,iv:Buffer.from(iv).toString("base64")});
  }
  const item={id,size,mime:"video/mp4",chunks};
  return {plain,remote,key,item,session:{type:"SESSION",token:"token-"+id,key,items:[item]}};
}
function worker(remote,clients=new Map(),status=200){
  const handlers={},downloads=[];
  const context=vm.createContext({console,TextEncoder,TextDecoder,URL,Request,Response,
    Uint8Array,ReadableStream,AbortController,DOMException,MessageChannel,Map,crypto:webcrypto,atob,
    setTimeout,clearTimeout,caches:{open:async()=>{throw Error("Cache unavailable in this test");}},
    fetch:async(url,options)=>{
      const id=decodeURIComponent(new URL(url).pathname.split("/").pop());
      downloads.push({id,authorization:options.headers.Authorization});
      if(status!==200)return new Response("failure",{status});
      const bytes=remote.get(id);
      return bytes?new Response(bytes.slice()):new Response("missing",{status:404});
    },
    self:{location:{origin:"https://example.test"},registration:{scope:"https://example.test/media-vault/"},
      addEventListener:(name,fn)=>handlers[name]=fn,clients:{get:async id=>clients.get(id)}}});
  vm.runInContext(SOURCE,context);
  return {
    downloads,
    session(id,data){let ack;handlers.message({source:{id},data,ports:[{postMessage:value=>ack=value}]});return ack;},
    clear(id){handlers.message({source:{id},data:{type:"CLEAR_SESSION"}});},
    request(range,clientId="tab-a",method="GET",id="movie"){
      let response;
      const request=new Request("https://example.test/media-vault/__media__/"+id,
        {method,headers:range?{Range:range}:{}});
      handlers.fetch({request,clientId,respondWith:value=>response=Promise.resolve(value)});
      return response;
    }
  };
}
let media;
test.before(async()=>{media=await fixture();});
function unlocked(){const w=worker(media.remote);assert.equal(w.session("tab-a",media.session).ready,true);return w;}
async function assertBytes(response,expected,status,range){
  assert.equal(response.status,status);
  assert.equal(response.headers.get("Content-Range"),range??null);
  assert.equal(Number(response.headers.get("Content-Length")),expected.length);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),expected);
}
function contentRange(start,end){return "bytes "+start+"-"+end+"/"+media.plain.length;}
test("GET without Range streams the entire file with 200, including all three blocks",async()=>{
  const w=unlocked();
  const response=await w.request();
  assert.equal(w.downloads.length,0,"response headers do not eagerly download the full file");
  await assertBytes(response,media.plain,200);
  assert.equal(w.downloads.length,3);
});
test("explicit range longer than one block is not truncated",async()=>{
  const w=unlocked(),start=CHUNK_SIZE-19,end=2*CHUNK_SIZE+20;
  await assertBytes(await w.request("bytes="+start+"-"+end),media.plain.slice(start,end+1),206,
    contentRange(start,end));
});
test("suffix, open-ended, oversized end and Safari two-byte probe return exact bytes",async()=>{
  for(const [header,start,end] of [
    ["bytes=-100",media.plain.length-100,media.plain.length-1],
    ["bytes="+(CHUNK_SIZE+17)+"-",CHUNK_SIZE+17,media.plain.length-1],
    ["bytes=17-999999999",17,media.plain.length-1],
    ["bytes=0-1",0,1],
    ["bytes=-999999999",0,media.plain.length-1]
  ]){
    const w=unlocked();
    await assertBytes(await w.request(header),media.plain.slice(start,end+1),206,contentRange(start,end));
  }
});
test("HEAD returns the full length without downloading or decrypting blocks",async()=>{
  const w=unlocked(),response=await w.request("bytes=0-1","tab-a","HEAD");
  assert.equal(response.status,200);
  assert.equal(response.headers.get("Content-Length"),String(media.plain.length));
  assert.equal(response.headers.get("Content-Range"),null);
  assert.equal((await response.arrayBuffer()).byteLength,0);
  assert.equal(w.downloads.length,0);
});
test("unsatisfiable ranges return 416 without downloading blocks",async()=>{
  for(const header of ["bytes="+media.plain.length+"-","bytes=20-10","bytes=-0"]){
    const w=unlocked(),response=await w.request(header);
    assert.equal(response.status,416);
    assert.equal(response.headers.get("Content-Range"),"bytes */"+media.plain.length);
    assert.equal(w.downloads.length,0);
  }
});
test("unsupported or malformed ranges are ignored with a complete 200 response",async()=>{
  for(const header of ["bytes=0-1,5-6","items=0-1","bytes=oops"]){
    const w=unlocked();await assertBytes(await w.request(header),media.plain,200);
  }
});
test("a restarted worker recovers only the requesting tab's in-memory session",async()=>{
  let requests=0;
  const clients=new Map([["tab-a",{postMessage(message,ports){
    assert.equal(message.type,"SESSION_REQUIRED");requests++;
    ports[0].postMessage(media.session);ports[0].close();
  }}]]);
  const w=worker(media.remote,clients);
  const responses=await Promise.all([w.request("bytes=0-1"),w.request("bytes=-1")]);
  assert.equal(requests,1,"concurrent requests share one session recovery");
  await assertBytes(responses[0],media.plain.slice(0,2),206,contentRange(0,1));
  await assertBytes(responses[1],media.plain.slice(-1),206,contentRange(media.plain.length-1,media.plain.length-1));
  assert.equal((await w.request("bytes=0-1","unknown-tab")).status,503);
});
test("tabs use independent keys and logout clears only its own tab",async()=>{
  const other=await fixture("other",321);
  const w=worker(new Map([...media.remote,...other.remote]));
  w.session("tab-a",media.session);w.session("tab-b",other.session);
  const active=await w.request("bytes=0-1");
  w.clear("tab-a");
  await assertBytes(active,media.plain.slice(0,2),206,contentRange(0,1));
  assert.equal((await w.request("bytes=0-1")).status,503);
  await assertBytes(await w.request(null,"tab-b","GET","other"),other.plain,200);
  assert.equal(w.downloads.at(-1).authorization,"Bearer token-other");
  assert.equal((await w.request(null,"tab-b","GET","movie")).status,404);
});
test("tampering with actual ciphertext fails authentication",async()=>{
  const damaged=new Map(media.remote);
  const bytes=damaged.get("movie-part-0").slice();bytes[0]^=1;damaged.set("movie-part-0",bytes);
  const w=worker(damaged);w.session("tab-a",media.session);
  const response=await w.request("bytes=0-1");
  await assert.rejects(response.arrayBuffer(),/operation|decrypt|specific reason/i);
});
test("Drive 401 asks only the originating tab to reconnect",async()=>{
  const notificationsA=[],notificationsB=[];
  const clients=new Map([["tab-a",{postMessage:m=>notificationsA.push(m)}],
    ["tab-b",{postMessage:m=>notificationsB.push(m)}]]);
  const w=worker(media.remote,clients,401);
  w.session("tab-a",media.session);w.session("tab-b",media.session);
  const response=await w.request("bytes=0-1");
  await assert.rejects(response.arrayBuffer(),/сеанс Drive истёк/);
  assert.equal(notificationsA.length,1);
  assert.equal(notificationsA[0].type,"DRIVE_AUTH_REQUIRED");
  assert.equal(notificationsB.length,0);
});
