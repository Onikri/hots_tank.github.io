const test=require("node:test");
const assert=require("node:assert/strict");
const {webcrypto}=require("node:crypto");
const {File}=require("node:buffer");
const CHUNK=4*1024*1024;
let createUploadService,openIndex,openChunk;
test.before(async()=>{
  ({createUploadService}=await import("../src/upload.js"));
  ({openIndex,openChunk}=await import("../crypto.js"));
});
function response(body,status=200){return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});}
async function fixture(){
  const key=await webcrypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  const legacy={id:"old",category:"book",name:"legacy.txt",size:7,chunks:[{fileId:"old-part",iv:"old"}]};
  const original={version:1,folderId:"vault-root",items:[legacy],
    entries:[{id:52991,title:"Saved private metadata"}],custom:{retained:true}};
  const state={admin:true,user:{sub:"owner"},token:"private-token",tokenExpiresAt:Date.now()+3600000,
    key,salt:webcrypto.getRandomValues(new Uint8Array(16)),libraryId:"catalog-file",catalog:original,generation:0};
  const remote=new Map(),folders=[],parts=[],progress=[],catalogWrites=[];
  let next=0,failPatch=false;
  const previousFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{
    if(options.signal?.aborted)throw new DOMException("Aborted","AbortError");
    assert.equal(options.headers.Authorization,"Bearer private-token");
    const parsed=new URL(url);
    if(parsed.pathname==="/drive/v3/files"&&options.method==="POST"){
      const metadata=JSON.parse(options.body),id="folder-"+(++next);
      folders.push({...metadata,id});return response({id,name:metadata.name});
    }
    if(parsed.pathname==="/upload/drive/v3/files"&&options.method==="POST"){
      const bytes=Buffer.from(await options.body.arrayBuffer());
      const boundary=options.headers["Content-Type"].match(/boundary=(.+)$/)[1];
      const first=bytes.indexOf("\r\n\r\n")+4;
      const divider=bytes.indexOf("\r\n--"+boundary,first);
      const metadata=JSON.parse(bytes.subarray(first,divider).toString());
      const start=bytes.indexOf("\r\n\r\n",divider)+4,end=bytes.lastIndexOf("\r\n--"+boundary+"--");
      const data=bytes.subarray(start,end),id="part-"+(++next);
      remote.set(id,Buffer.from(data));parts.push({...metadata,id,data});return response({id,name:metadata.name});
    }
    if(parsed.pathname==="/upload/drive/v3/files/catalog-file"&&options.method==="PATCH"){
      if(failPatch)return response({error:{message:"failure"}},500);
      const encrypted=JSON.parse(await options.body.text());catalogWrites.push(encrypted);
      return response({id:"catalog-file"});
    }
    throw Error("Unexpected remote call: "+options.method+" "+parsed.pathname);
  };
  const service=createUploadService({
    getSession:()=>state,onCatalog:catalog=>{state.catalog=catalog;},
    onProgress:entry=>progress.push(entry),onAuthExpired:()=>{state.token=null;}
  });
  return {state,original,legacy,key,remote,folders,parts,progress,catalogWrites,service,
    failPatch:()=>{failPatch=true;},restore:()=>{service.cancel();globalThis.fetch=previousFetch;}};
}
function namedFile(name,bytes,type="video/mp4",relativePath=""){
  const file=new File([bytes],name,{type});
  if(relativePath)Object.defineProperty(file,"webkitRelativePath",{value:relativePath});
  return file;
}
test("empty collection field falls back to folder path or the default collection",async()=>{
  const f=await fixture();
  try{
    const first=await f.service.uploadFiles([namedFile('note.txt',Buffer.from('one'),'text/plain')],{collection:''});
    const second=await f.service.uploadFiles([namedFile('other.txt',Buffer.from('two'),'text/plain','Season/other.txt')],{collection:'   '});
    assert.equal(first[0].ok,true);assert.equal(second[0].ok,true);
    assert.deepEqual(f.state.catalog.storage.collections.map(entry=>entry.name),['Без коллекции','Season']);
  }finally{f.restore();}
});
test("real AES-GCM upload makes bounded 4 MiB chunks and opaque Drive collections",async()=>{
  const f=await fixture();
  try{
    const bytes=Buffer.alloc(2*CHUNK+123);for(let i=0;i<bytes.length;i++)bytes[i]=(i*31+17)%251;
    const file=namedFile("Private episode.mp4",bytes,"video/mp4","Private series/Season 1/Private episode.mp4");
    const results=await f.service.uploadFiles([file],{episode:3,metadataId:52991});
    assert.equal(results[0].ok,true);
    const item=results[0].item;
    assert.deepEqual(item.chunks.map(chunk=>f.remote.get(chunk.fileId).length),[CHUNK+16,CHUNK+16,123+16]);
    const restored=[];
    for(let i=0;i<item.chunks.length;i++){
      const chunk=item.chunks[i];
      restored.push(Buffer.from(await openChunk(f.remote.get(chunk.fileId),f.key,item.id,i,chunk.iv)));
    }
    assert.deepEqual(Buffer.concat(restored),bytes);
    const [media,collection,asset]=f.folders;
    assert.equal(media.name,"video");assert.deepEqual(media.parents,["vault-root"]);
    assert.match(collection.name,/^collection-[0-9a-f-]{36}$/);assert.deepEqual(collection.parents,[media.id]);
    assert.match(asset.name,/^asset-[0-9a-f-]{36}$/);assert.deepEqual(asset.parents,[collection.id]);
    assert.ok(f.parts.every(part=>/^part-\d{6}\.enc$/.test(part.name)&&part.parents[0]===asset.id));
    assert.ok(!JSON.stringify(f.folders).includes("Private"));
    assert.ok(!JSON.stringify(f.catalogWrites).includes("Private"));
    const opened=await openIndex(f.catalogWrites.at(-1),f.key);
    assert.equal(opened.items[0].name,"legacy.txt");assert.equal(opened.entries[0].id,52991);
    assert.equal(opened.custom.retained,true);
    assert.equal(opened.storage.collections[0].name,"Private series/Season 1");
    assert.equal(item.sourcePath,"Private series/Season 1/Private episode.mp4");
    assert.equal(item.collectionId,opened.storage.collections[0].id);
    assert.equal(item.episode,3);assert.equal(item.metadataId,52991);
    assert.equal(f.progress.at(-1).status,"done");assert.equal(f.progress.at(-1).percent,100);
    assert.ok(f.progress.some(entry=>entry.phase==="encrypting"));
    assert.ok(f.progress.some(entry=>entry.phase==="saving"));
    assert.equal(f.key.extractable,false);
    assert.ok(!("token" in f.service.getState()));assert.ok(!("key" in f.service.getState()));
  }finally{f.restore();}
});
test("same collection reuses its folders; separate media categories have separate trees",async()=>{
  const f=await fixture();
  try{
    await f.service.uploadFiles([namedFile("one.mp4","one"),namedFile("two.mp4","two")],{collection:"Same series"});
    await f.service.uploadFiles([namedFile("song.mp3","music","audio/mpeg")],{collection:"Same series"});
    assert.equal(f.folders.filter(folder=>folder.name==="video").length,1);
    assert.equal(f.folders.filter(folder=>folder.name==="audio").length,1);
    assert.equal(f.folders.filter(folder=>folder.name.startsWith("collection-")).length,2);
    assert.equal(f.state.catalog.items.length,4);
    assert.equal(f.state.catalog.items[1].collectionId,f.state.catalog.items[2].collectionId);
    assert.notEqual(f.state.catalog.items[1].collectionId,f.state.catalog.items[3].collectionId);
  }finally{f.restore();}
});
test("failed catalog save publishes no phantom item, and unsupported files create no folders",async()=>{
  const f=await fixture();
  try{
    const unsupported=await f.service.uploadFiles([namedFile("secret.exe","nope")]);
    assert.equal(unsupported[0].ok,false);assert.equal(f.folders.length,0);
    f.failPatch();
    const result=await f.service.uploadFiles([namedFile("valid.mp4","payload")]);
    assert.equal(result[0].ok,false);
    assert.equal(f.state.catalog,f.original);assert.equal(f.original.items.length,1);
    assert.equal(f.original.storage,undefined);assert.equal(f.catalogWrites.length,0);
    assert.equal(f.progress.filter(entry=>entry.name==="valid.mp4"&&entry.status==="error").length,1);
  }finally{f.restore();}
});
test("unknown-length streams rechunk irregular network buffers without losing bytes",async()=>{
  const f=await fixture();
  try{
    const input=Buffer.alloc(CHUNK+91,77),sizes=[1,17,CHUNK-7,80];let position=0;
    async function* source(){
      for(const count of sizes){yield input.subarray(position,Math.min(input.length,position+count));position+=count;}
      if(position<input.length)yield input.subarray(position);
    }
    const item=await f.service.importStream({name:"stream.mp4",mime:"video/mp4",stream:source(),collection:"Stream"});
    assert.equal(item.size,input.length);assert.equal(item.chunks.length,2);
    const buffers=[];
    for(let n=0;n<item.chunks.length;n++)buffers.push(Buffer.from(await openChunk(
      f.remote.get(item.chunks[n].fileId),f.key,item.id,n,item.chunks[n].iv)));
    assert.deepEqual(Buffer.concat(buffers),input);
  }finally{f.restore();}
});
test("serialized uploads and metadata changes preserve both catalog branches",async()=>{
  const f=await fixture();
  try{
    await Promise.all([
      f.service.uploadFiles([namedFile("first.mp4","one")]),
      f.service.mutateCatalog(catalog=>({...catalog,entries:[...catalog.entries,{id:2,title:"New metadata"}]})),
      f.service.uploadFiles([namedFile("second.mp4","two")])
    ]);
    const opened=await openIndex(f.catalogWrites.at(-1),f.key);
    assert.deepEqual(opened.items.map(item=>item.name),["legacy.txt","first.mp4","second.mp4"]);
    assert.deepEqual(opened.entries.map(entry=>entry.id),[52991,2]);
  }finally{f.restore();}
});
test("source HTML/HLS and truncated media never become playable catalog items",async()=>{
  const f=await fixture();
  try{
    for(const type of ["text/html","application/vnd.apple.mpegurl","application/json"]){
      await assert.rejects(f.service.importVideo({name:"source.mp4",sourceUrl:"https://example.test/file"},
        async()=>new Response("invalid",{headers:{"Content-Type":type}})),/MP4/);
    }
    assert.equal(f.folders.length,0);
    await assert.rejects(f.service.importVideo({name:"short.mp4",sourceUrl:"https://example.test/file"},
      async()=>new Response("short",{headers:{"Content-Type":"video/mp4","Content-Length":"100"}})),/неполный/);
    assert.equal(f.state.catalog.items.length,1);assert.equal(f.catalogWrites.length,0);
  }finally{f.restore();}
});
test("public MP4 fetch imports bytes but never stores a signed source URL",async()=>{
  const f=await fixture();
  try{
    const sourceUrl="https://example.test/video.mp4?private=source-secret";
    const item=await f.service.importVideo({name:"public.mp4",sourceUrl,collection:"Imported"},
      async(url,{signal})=>{assert.equal(url,sourceUrl);assert.ok(signal);return new Response("movie",{headers:{"Content-Type":"video/mp4","Content-Length":"5"}});});
    assert.equal(item.size,5);
    const opened=await openIndex(f.catalogWrites.at(-1),f.key);
    assert.ok(!JSON.stringify(opened).includes("source-secret"));
  }finally{f.restore();}
});
test("logout cancels an in-flight source fetch before it can write media",async()=>{
  const f=await fixture();
  try{
    let announce;const started=new Promise(resolve=>announce=resolve);
    const pending=f.service.importVideo({name:"waiting.mp4",sourceUrl:"https://example.test/video"},
      (url,{signal})=>new Promise((resolve,reject)=>{
        signal.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError")),{once:true});announce();
      }));
    await started;
    f.state.generation++;f.state.token=null;f.state.key=null;f.state.catalog=null;f.service.cancel();
    await assert.rejects(pending,{name:"AbortError"});
    assert.equal(f.folders.length,0);assert.equal(f.catalogWrites.length,0);assert.equal(f.state.catalog,null);
  }finally{f.restore();}
});
test("cancel also releases a stream reader waiting for its next network block",async()=>{
  const f=await fixture();
  try{
    let reached,canceled=false;const reading=new Promise(resolve=>reached=resolve);
    const stream=new ReadableStream({pull(){reached();return new Promise(()=>{});},cancel(){canceled=true;}});
    const pending=f.service.importStream({name:"waiting.mp4",mime:"video/mp4",stream});
    await reading;f.service.cancel();
    await assert.rejects(pending,{name:"AbortError"});
    assert.equal(canceled,true);assert.equal(f.catalogWrites.length,0);
  }finally{f.restore();}
});
