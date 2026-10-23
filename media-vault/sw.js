/* Local per-device streaming proxy. OAuth tokens and CryptoKeys stay in worker RAM. */
const STORAGE_CACHE="mediavault-ciphertext-v1";
const SHELL_CACHE="mediavault-app-v2";
const CHUNK_SIZE=4*1024*1024;
const CHUNK_LIMIT=160;
// A worker may control several tabs with different libraries or accounts.
const sessions=new Map();
const pendingSessions=new Map();
const encoder=new TextEncoder();
function b64(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
self.addEventListener("install",event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(SHELL_CACHE);
    await cache.addAll(["./","./index.html","./style.css","./app.js","./crypto.js","./drive.js","./config.js"]);
    await self.skipWaiting();
  })());
});
self.addEventListener("activate",event=>{
  event.waitUntil((async()=>{
    for(const name of await caches.keys())
      if(name.startsWith("mediavault-app-")&&name!==SHELL_CACHE)await caches.delete(name);
    await self.clients.claim();
  })());
});
function readSession(data){
  if(data?.type!=="SESSION"||!data.key||typeof data.token!=="string"||!Array.isArray(data.items))return null;
  return {token:data.token,key:data.key,items:new Map(data.items.map(item=>[item.id,item]))};
}
self.addEventListener("message",event=>{
  const clientId=event.source?.id;
  if(!clientId)return;
  if(event.data?.type==="SESSION"){
    const session=readSession(event.data);
    if(session){
      sessions.set(clientId,session);
      pendingSessions.get(clientId)?.finish(session);
    }
    event.ports?.[0]?.postMessage({ready:!!session});
  }
  if(event.data?.type==="CLEAR_SESSION"){
    sessions.delete(clientId);
    pendingSessions.get(clientId)?.finish(null);
  }
});
async function sessionFor(clientId){
  if(!clientId)return null;
  if(sessions.has(clientId))return sessions.get(clientId);
  if(pendingSessions.has(clientId))return pendingSessions.get(clientId).promise;
  const client=await self.clients.get(clientId);
  if(!client)return null;
  // Another request may have restored the session while clients.get was pending.
  if(sessions.has(clientId))return sessions.get(clientId);
  if(pendingSessions.has(clientId))return pendingSessions.get(clientId).promise;
  const channel=new MessageChannel();
  let finish,timer,finished=false;
  const promise=new Promise(resolve=>{
    finish=session=>{
      if(finished)return;
      finished=true;
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      pendingSessions.delete(clientId);
      resolve(session);
    };
  });
  pendingSessions.set(clientId,{promise,finish});
  channel.port1.onmessage=event=>{
    if(finished)return;
    const session=readSession(event.data);
    if(session)sessions.set(clientId,session);
    finish(session);
  };
  timer=setTimeout(()=>finish(null),8000);
  try{client.postMessage({type:"SESSION_REQUIRED"},[channel.port2]);}
  catch{finish(null);}
  return promise;
}
self.addEventListener("fetch",event=>{
  const url=new URL(event.request.url);
  const prefix=new URL("./__media__/",self.registration.scope).pathname;
  if(url.origin===self.location.origin&&url.pathname.startsWith(prefix)){
    let id;
    try{id=decodeURIComponent(url.pathname.slice(prefix.length));}
    catch{event.respondWith(new Response("Некорректный адрес",{status:400}));return;}
    event.respondWith(serveRange(event.request,id,event.clientId));
  }
});
async function encryptedBlock(session,fileId,signal,clientId){
  let cache=null;
  try{cache=await caches.open(STORAGE_CACHE);}catch{}
  const cacheKey="https://mediavault.invalid/cipher/"+encodeURIComponent(fileId);
  if(cache){
    try{const hit=await cache.match(cacheKey);if(hit)return hit.arrayBuffer();}catch{}
  }
  if(!session.token)throw Error("Авторизуйтесь заново — сеанс Drive истёк.");
  const url="https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(fileId)+"?alt=media";
  let data=null;
  for(let attempt=0;attempt<5;attempt++){
    const resp=await fetch(url,{signal,headers:{Authorization:"Bearer "+session.token}});
    if(resp.ok){data=await resp.arrayBuffer();break;}
    if(resp.status===401){
      // The page must request a fresh token from a user gesture.
      const client=await self.clients.get(clientId);
      client?.postMessage({type:"DRIVE_AUTH_REQUIRED"});
      throw Error("Авторизуйтесь заново — сеанс Drive истёк.");
    }
    const errorBody=await resp.text();
    const transient=[429,500,502,503,504].includes(resp.status)||
      (resp.status===403&&/rateLimitExceeded|userRateLimitExceeded/i.test(errorBody));
    if(!transient||attempt===4)throw Error("Google Drive: HTTP "+resp.status);
    await new Promise(resolve=>setTimeout(resolve,400*2**attempt+Math.random()*300));
  }
  if(!data)throw Error("Google Drive не прислал данные");
  // Cache failures, including an exhausted iOS quota, must not break playback.
  if(cache)try{
    await cache.put(cacheKey,new Response(data,{headers:{"Content-Type":"application/octet-stream"}}));
    const keys=await cache.keys();
    if(keys.length>CHUNK_LIMIT)for(const key of keys.slice(0,keys.length-CHUNK_LIMIT))await cache.delete(key);
  }catch(error){console.debug("CacheStorage unavailable",error);}
  return data;
}
async function chunkPlain(session,item,n,signal,clientId){
  const chunk=item.chunks[n];
  if(!chunk)throw Error("Не найден зашифрованный блок");
  const encrypted=await encryptedBlock(session,chunk.fileId,signal,clientId);
  return crypto.subtle.decrypt({name:"AES-GCM",iv:b64(chunk.iv),
    additionalData:encoder.encode(item.id+":"+n)},session.key,encrypted);
}
function parseRange(header,size){
  // Unsupported units, malformed syntax and multipart ranges are ignored per HTTP.
  if(!header)return null;
  const match=/^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if(!match||(!match[1]&&!match[2]))return null;
  let start,end;
  if(!match[1]){
    const suffix=Number(match[2]);
    if(!Number.isSafeInteger(suffix)||suffix<=0)return false;
    start=Math.max(0,size-suffix);end=size-1;
  }else{
    start=Number(match[1]);
    end=match[2]?Number(match[2]):size-1;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start)return false;
    end=Math.min(end,size-1);
  }
  return {start,end};
}
function decryptedStream(session,item,start,end,request,clientId){
  let n=Math.floor(start/CHUNK_SIZE),cancelled=false;
  const last=Math.floor(end/CHUNK_SIZE);
  const aborter=new AbortController();
  const abort=()=>aborter.abort();
  request.signal.addEventListener("abort",abort,{once:true});
  if(request.signal.aborted)abort();
  function cleanup(){request.signal.removeEventListener("abort",abort);}
  return new ReadableStream({
    async pull(controller){
      try{
        const raw=new Uint8Array(await chunkPlain(session,item,n,aborter.signal,clientId));
        if(cancelled)return;
        if(aborter.signal.aborted)throw new DOMException("Запрос отменён","AbortError");
        const offset=n*CHUNK_SIZE;
        const left=Math.max(0,start-offset),right=Math.min(raw.length,end-offset+1);
        if(right<=left||raw.length!==Math.min(CHUNK_SIZE,item.size-offset))
          throw Error("Повреждённый размер блока");
        controller.enqueue(raw.subarray(left,right));
        if(n++===last){cleanup();controller.close();}
      }catch(error){cleanup();if(!cancelled)controller.error(error);}
    },
    cancel(){cancelled=true;abort();cleanup();}
  },{highWaterMark:0});
}
async function serveRange(request,id,clientId){
  try{
    if(request.method!=="GET"&&request.method!=="HEAD")
      return new Response(null,{status:405,headers:{Allow:"GET, HEAD"}});
    const session=await sessionFor(clientId);
    if(!session)return new Response("Сначала откройте библиотеку",{status:503});
    const item=session.items.get(id);
    if(!item)return new Response("Медиа не найдено",{status:404});
    const size=item.size;
    if(!Number.isSafeInteger(size)||size<=0)return new Response("Пустой или повреждённый файл",{status:404});
    // Range applies to GET only; HEAD returns metadata without decrypting a block.
    const range=request.method==="GET"?parseRange(request.headers.get("Range"),size):null;
    if(range===false)return new Response(null,{status:416,headers:{"Content-Range":"bytes */"+size}});
    const start=range?range.start:0,end=range?range.end:size-1;
    const headers={"Content-Type":item.mime||"application/octet-stream",
      "Accept-Ranges":"bytes","Content-Length":String(end-start+1),"Cache-Control":"no-store"};
    if(range)headers["Content-Range"]="bytes "+start+"-"+end+"/"+size;
    const body=request.method==="HEAD"?null:decryptedStream(session,item,start,end,request,clientId);
    return new Response(body,{status:range?206:200,headers});
  }catch(error){
    return new Response("Ошибка расшифровки или Google Drive: "+error.message,{status:503,
      headers:{"Content-Type":"text/plain;charset=utf-8"}});
  }
}

