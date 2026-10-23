/* Local per-device streaming proxy: no VPS. Private OAuth token + CryptoKey live in worker RAM. */
const STORAGE_CACHE="mediavault-ciphertext-v1";
const SHELL_CACHE="mediavault-app-v1";
const CHUNK_LIMIT=160;
let session=null;
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
    for (const name of await caches.keys())
      if(name.startsWith("mediavault-app-") && name!==SHELL_CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener("message",event=>{
  if(event.data?.type==="SESSION"){
    session={token:event.data.token,key:event.data.key,
      items:new Map((event.data.items||[]).map(item=>[item.id,item]))};
    event.ports?.[0]?.postMessage({ready:true});
  }
  if(event.data?.type==="CLEAR_SESSION") session=null;
});
self.addEventListener("fetch",event=>{
  const url=new URL(event.request.url);
  const prefix=new URL("./__media__/",self.registration.scope).pathname;
  if(url.origin===self.location.origin && url.pathname.startsWith(prefix)){
    const id=decodeURIComponent(url.pathname.slice(prefix.length));
    event.respondWith(serveRange(event.request,id));
  }
});
async function encryptedBlock(fileId){
  const cache=await caches.open(STORAGE_CACHE);
  const cacheKey="https://mediavault.invalid/cipher/"+encodeURIComponent(fileId);
  const cached=await cache.match(cacheKey);
  if(cached) return cached.arrayBuffer();
  if(!session?.token) throw Error("Авторизуйтесь заново — сеанс Drive истёк.");
  const resp=await fetch("https://www.googleapis.com/drive/v3/files/"+
      encodeURIComponent(fileId)+"?alt=media",
      {headers:{Authorization:"Bearer "+session.token}});
  if(!resp.ok) throw Error("Google Drive вернул HTTP "+resp.status);
  const data=await resp.arrayBuffer();
  await cache.put(cacheKey,new Response(data,{headers:{"Content-Type":"application/octet-stream"}}));
  const keys=await cache.keys();
  if(keys.length>CHUNK_LIMIT) for(const key of keys.slice(0,keys.length-CHUNK_LIMIT))
    await cache.delete(key);
  return data;
}
async function chunkPlain(item,n){
  const chunk=item.chunks[n];
  if(!chunk) throw Error("Не найден зашифрованный блок");
  const encrypted=await encryptedBlock(chunk.fileId);
  return crypto.subtle.decrypt({name:"AES-GCM",iv:b64(chunk.iv),
    additionalData:encoder.encode(item.id+":"+n)},session.key,encrypted);
}
async function serveRange(request,id){
  try{
    if(!session?.key) return new Response("Сначала откройте библиотеку",{status:503});
    const item=session.items.get(id);
    if(!item) return new Response("Медиа не найдено",{status:404});
    const size=item.size;
    if(!size) return new Response("Пустой файл",{status:404});
    const hdr=request.headers.get("Range")||"";
    const match=/^bytes=(\d+)-(\d*)$/.exec(hdr);
    let start=match?Number(match[1]):0;
    if(!Number.isSafeInteger(start)||start>=size || start<0)
      return new Response("",{status:416,headers:{"Content-Range":"bytes */"+size}});
    const requestEnd=match?.[2] ? Number(match[2]) : size-1;
    const end=Math.min(size-1,requestEnd,start+4*1024*1024-1);
    if(end<start) return new Response("",{status:416,headers:{"Content-Range":"bytes */"+size}});
    const first=Math.floor(start/(4*1024*1024));
    const last=Math.floor(end/(4*1024*1024));
    const segments=[];
    for(let n=first;n<=last;n++) {
      const raw=new Uint8Array(await chunkPlain(item,n));
      const left=n===first ? start-n*4*1024*1024 : 0;
      const right=n===last ? end-n*4*1024*1024+1 : raw.length;
      segments.push(raw.subarray(left,right));
    }
    const combined=new Uint8Array(end-start+1);
    let p=0;for(const segment of segments){combined.set(segment,p);p+=segment.length;}
    return new Response(combined,{status:206,headers:{
      "Content-Type":item.mime||"application/octet-stream",
      "Accept-Ranges":"bytes",
      "Content-Range":"bytes "+start+"-"+end+"/"+size,
      "Content-Length":String(combined.byteLength),
      "Cache-Control":"no-store"
    }});
  }catch(error){
    return new Response("Ошибка расшифровки или Google Drive: "+error.message,{status:503,
      headers:{"Content-Type":"text/plain;charset=utf-8"}});
  }
}
