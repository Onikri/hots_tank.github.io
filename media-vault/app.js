import {CHUNK_SIZE,newSalt,deriveVaultKey,sealChunk,openChunk,sealIndex,openIndex,
  base64ToBytes,guessCategory,mimeFor} from "./crypto.js";
import {driveRequest,driveDownload,readEnvelope,createFolder,folderExists,uploadSmall,
  replaceSmall,inviteReader,trashFolder} from "./drive.js";

const cfg=window.MEDIA_VAULT_CONFIG;
const $=id=>document.getElementById(id);
const labels={all:"Все материалы",video:"Видео",audio:"Музыка",manga:"Манга",
  book:"Книги",image:"Изображения"};
const icons={video:"▶",audio:"♫",manga:"▤",book:"▧",image:"▧"};
const state={user:null,admin:false,token:null,key:null,salt:null,catalog:null,
  libraryId:new URLSearchParams(location.search).get("library")||
    localStorage.getItem("mediavault_library")||"",
  category:"all",query:"",worker:null,openUrls:[],book:null};
let noticeTimer=null;
function show(id,yes=true){$(id).classList.toggle("hidden",!yes);}
function toast(message,bad=false){
  const node=$("toast");node.textContent=message;node.style.borderColor=bad?"#a45f66":"#496a68";
  show("toast");clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>show("toast",false),5500);
}
function explain(e){toast(e?.message||String(e),true);console.error(e);}
function updateStatus(text){$("status").textContent=text;}
function saveLibraryId(id){state.libraryId=id;localStorage.setItem("mediavault_library",id);$("libraryId").value=id;}
async function hashEmail(email){
  const bytes=new TextEncoder().encode(email.trim().toLowerCase());
  const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
  return Array.from(hash,x=>x.toString(16).padStart(2,"0")).join("");
}
function validConfig(){
  return cfg.googleClientId && !cfg.googleClientId.startsWith("REPLACE_");
}
async function googleReady(){
  for(let i=0;i<75;i++){
    if(window.google?.accounts?.oauth2) return;
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw Error("Google Identity Services не загрузился. Проверь блокировщики рекламы и сеть.");
}
async function askToken(scope){
  await googleReady();
  return new Promise((resolve,reject)=>{
    const client=google.accounts.oauth2.initTokenClient({
      client_id:cfg.googleClientId,scope,prompt:"select_account",
      callback:r=>r.error?reject(Error(r.error_description||r.error)):resolve(r.access_token),
      error_callback:()=>reject(Error("Окно авторизации Google закрыто или заблокировано."))
    });
    client.requestAccessToken();
  });
}
async function userFromToken(token){
  const r=await fetch("https://www.googleapis.com/oauth2/v3/userinfo",
    {headers:{Authorization:"Bearer "+token}});
  if(!r.ok) throw Error("Не удалось проверить личность через Google.");
  const u=await r.json();
  if(!u.email_verified) throw Error("Google не подтвердил email.");
  return u;
}
async function login(){
  try {
    if(!validConfig()) throw Error("Сначала укажи Google OAuth Client ID в config.js. Инструкция — в README.");
    const token=await askToken("openid email profile");
    const user=await userFromToken(token);
    state.user=user;
    state.admin=(await hashEmail(user.email))===cfg.adminEmailSha256;
    $("loginBtn").textContent="✓ "+(user.given_name||user.email);
    $("loginBtn").disabled=true;
    show("driveBtn");show("logoutBtn");
    updateStatus(state.admin?"Администратор · Google":"Пользователь · Google");
    toast("Вход выполнен. Теперь подключи Google Drive.");
  }catch(e){explain(e);}
}
async function connectDrive(){
  try{
    if(!state.user) throw Error("Сначала войди в Google.");
    const scope="openid email profile https://www.googleapis.com/auth/"+(state.admin?"drive":"drive.readonly");
    const token=await askToken(scope);
    const actual=await userFromToken(token);
    if(actual.sub!==state.user.sub) throw Error("Для Drive нужно выбрать тот же Google-аккаунт, что и при входе.");
    state.token=token;
    show("driveBtn",false);
    show("setupPanel");
    show("createRow",state.admin);
    show("createBtn",state.admin);
    $("libraryId").value=state.libraryId;
    updateStatus("Drive подключён"+(state.admin?" · админ":""));
    $("notice").querySelector("strong").textContent="Google Drive подключён";
    $("notice").querySelector("p").textContent="Введи ID библиотеки (или открой приглашение) и секретную фразу. Администратор может создать новую библиотеку.";
    toast("Drive подключён. Токен хранится только в памяти браузера.");
  }catch(e){explain(e);}
}
async function unlock(){
  try{
    if(!state.token) throw Error("Подключи Drive.");
    const id=$("libraryId").value.trim()||state.libraryId;
    const pass=$("passphrase").value;
    if(!id) throw Error("Введи ID каталога из ссылки-приглашения.");
    if(!pass) throw Error("Введи секретную фразу.");
    updateStatus("Открываем каталог…");
    const envelope=await readEnvelope(state.token,id);
    const salt=base64ToBytes(envelope.salt);
    const key=await deriveVaultKey(pass,salt);
    const catalog=await openIndex(envelope,key);
    state.salt=salt;state.key=key;state.catalog=catalog;
    saveLibraryId(id);
    $("passphrase").value="";$("passphraseAgain").value="";
    await sessionToWorker();
    enterLibrary();
    toast("Каталог расшифрован на устройстве.");
  }catch(e){updateStatus("Ошибка открытия");explain(e);}
}
async function createLibrary(){
  try{
    if(!state.admin||!state.token) throw Error("Создавать библиотеку может только администратор.");
    const pass=$("passphrase").value;
    if(pass!==$("passphraseAgain").value) throw Error("Секретные фразы не совпадают.");
    const salt=newSalt();
    const key=await deriveVaultKey(pass,salt);
    updateStatus("Создаём библиотеку…");
    let folderId=cfg.storageFolderId;
    if(!(await folderExists(state.token,folderId))) {
      const folder=await createFolder(state.token,"MediaVault — encrypted media library",null);
      folderId=folder.id;
    }
    // Catalog filenames and titles are encrypted. Only this encrypted envelope is saved.
    const catalog={version:1,folderId,createdAt:new Date().toISOString(),items:[]};
    const sealed=await sealIndex(catalog,key,salt);
    const file=await uploadSmall(state.token,"vault-catalog.enc.json",
      new Blob([JSON.stringify(sealed)],{type:"application/octet-stream"}),folderId);
    state.key=key;state.salt=salt;state.catalog=catalog;
    saveLibraryId(file.id);
    $("passphrase").value="";$("passphraseAgain").value="";
    await sessionToWorker();
    enterLibrary();
    toast("Библиотека создана. Сохрани секретную фразу и ссылку-приглашение!");
  }catch(e){explain(e);updateStatus("Ошибка создания");}
}
function enterLibrary(){
  show("setupPanel",false);show("notice",false);show("adminPanel",state.admin);
  show("uploadBtn",state.admin);
  updateStatus((state.admin?"Администратор":"Зритель")+" · библиотека открыта");
  renderLibrary();
}
async function registerWorker(){
  if(!("serviceWorker" in navigator))return;
  try{
    await navigator.serviceWorker.register("./sw.js",{scope:"./"});
    await navigator.serviceWorker.ready;
    if(navigator.serviceWorker.controller) state.worker=navigator.serviceWorker.controller;
    else {
      await new Promise(resolve=>{
        navigator.serviceWorker.addEventListener("controllerchange",resolve,{once:true});
        setTimeout(resolve,2200);
      });
      state.worker=navigator.serviceWorker.controller;
    }
  }catch(e){console.warn("Service Worker недоступен:",e);}
}
async function sessionToWorker(){
  if(!state.worker) await registerWorker();
  state.worker=navigator.serviceWorker?.controller||state.worker;
  if(state.worker && state.key && state.catalog) {
    const channel=new MessageChannel();
    const wait=new Promise(resolve=>{
      channel.port1.onmessage=resolve;
      setTimeout(resolve,1500);
    });
    state.worker.postMessage({type:"SESSION",token:state.token,key:state.key,
      items:state.catalog.items},[channel.port2]);
    await wait;
  }
}
function renderLibrary(){
  const grid=$("libraryGrid");grid.replaceChildren();
  const items=(state.catalog?.items||[]).filter(item=>
    (state.category==="all"||item.category===state.category) &&
    item.name.toLowerCase().includes(state.query.toLowerCase()));
  $("sectionTitle").textContent=labels[state.category];
  $("crumbCategory").textContent=labels[state.category];
  $("count").textContent=items.length+" файлов";
  if(!items.length){
    const empty=document.createElement("div");
    empty.className="empty";
    const h=document.createElement("h3");h.textContent=state.catalog?"Здесь пока нет материалов":"Библиотека закрыта";
    const p=document.createElement("p");p.textContent=state.catalog?
      "Добавь файлы или попробуй другой раздел.":"Войди через Google и открой каталог.";
    empty.innerHTML='<div class="empty-icon">◈</div>';
    empty.append(h,p);grid.append(empty);return;
  }
  for(const item of items.slice().reverse()){
    const card=document.createElement("button");card.className="media-card";
    const cover=document.createElement("div");cover.className="cover "+item.category;
    const symbol=document.createElement("b");symbol.textContent=icons[item.category];
    const badge=document.createElement("span");badge.className="media-type";badge.textContent=labels[item.category];
    cover.append(symbol,badge);
    const info=document.createElement("div");info.className="media-info";
    const name=document.createElement("strong");name.textContent=item.name;
    const meta=document.createElement("span");meta.textContent=formatSize(item.size)+" · "+new Date(item.addedAt).toLocaleDateString("ru");
    info.append(name,meta);card.append(cover,info);
    card.addEventListener("click",()=>openViewer(item));
    grid.append(card);
  }
}
function formatSize(n){return n>=1024*1024*1024?(n/1024**3).toFixed(2)+" ГБ":
  n>=1024*1024?(n/1024**2).toFixed(1)+" МБ":Math.ceil(n/1024)+" КБ";}
async function saveCatalog(){
  if(!state.admin)throw Error("Нет прав администратора");
  const sealed=await sealIndex(state.catalog,state.key,state.salt);
  await replaceSmall(state.token,state.libraryId,
    new Blob([JSON.stringify(sealed)],{type:"application/octet-stream"}));
  await sessionToWorker();
  renderLibrary();
}
async function uploadFiles(files){
  if(!state.admin||!state.key) return toast("Библиотека закрыта.",true);
  const queue=$("uploadQueue");queue.replaceChildren();
  $("selectFilesBtn").disabled=true;
  try{
    for(const file of files){
      const display=document.createElement("div");display.className="progress";
      const label=document.createElement("div");label.textContent=file.name+" — подготовка";
      const bar=document.createElement("progress");bar.max=file.size||1;bar.value=0;
      display.append(label,bar);queue.append(display);
      try{
        const category=guessCategory(file);
        const itemId=crypto.randomUUID();
        const directory=await createFolder(state.token,"asset-"+itemId,state.catalog.folderId);
        const chunks=[];
        for(let start=0,index=0;start<file.size;start+=CHUNK_SIZE,index++){
          const slice=await file.slice(start,Math.min(file.size,start+CHUNK_SIZE)).arrayBuffer();
          const sealed=await sealChunk(slice,state.key,itemId,index);
          const remote=await uploadSmall(state.token,
            "part-"+String(index).padStart(6,"0")+".enc",new Blob([sealed.ciphertext]),directory.id);
          chunks.push({fileId:remote.id,iv:sealed.iv});
          bar.value=Math.min(file.size,start+slice.byteLength);
          label.textContent=file.name+" — "+Math.round(bar.value/file.size*100)+"%";
        }
        if(chunks.length===0) throw Error("Пустой файл не поддерживается.");
        const item={id:itemId,folderId:directory.id,name:file.name,category,
          mime:mimeFor(file,category),size:file.size,addedAt:new Date().toISOString(),chunks};
        state.catalog.items.push(item);
        await saveCatalog();
        label.textContent="✓ "+file.name+" — зашифровано и загружено";
      }catch(e){label.textContent="✕ "+file.name+" — "+e.message;console.error(e);}
    }
    toast("Очередь загрузки обработана.");
  }finally{$("selectFilesBtn").disabled=false;$("filesInput").value="";}
}
async function invite(){
  try{
    if(!state.admin||!state.catalog)throw Error("Только администратор может приглашать.");
    const email=$("inviteEmail").value.trim();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error("Проверь адрес email.");
    await inviteReader(state.token,state.catalog.folderId,email);
    $("inviteEmail").value="";
    toast("Приглашение отправлено. Передай пользователю ссылку и секретную фразу отдельно.");
  }catch(e){explain(e);}
}
function inviteUrl(){
  const link=new URL(location.pathname,location.origin);
  link.searchParams.set("library",state.libraryId);
  return link.href;
}
async function copyInvite(){
  if(!state.libraryId)return explain(Error("Сначала открой библиотеку."));
  try{await navigator.clipboard.writeText(inviteUrl());toast("Ссылка-приглашение скопирована.");}
  catch{window.prompt("Скопируй ссылку",inviteUrl());}
}
async function readWhole(item){
  if(item.size>700*1024*1024)toast("Большой файл. Для видео и музыки используй потоковое воспроизведение.");
  const buffers=[];
  for(let i=0;i<item.chunks.length;i++){
    const chunk=item.chunks[i];
    const encrypted=await driveDownload(state.token,chunk.fileId);
    const plain=await openChunk(encrypted,state.key,item.id,i,chunk.iv);
    buffers.push(plain);
    updateStatus("Скачано "+Math.round((i+1)/item.chunks.length*100)+"%");
  }
  updateStatus((state.admin?"Администратор":"Зритель")+" · библиотека открыта");
  return new Blob(buffers,{type:item.mime});
}
function objectUrl(blob){const u=URL.createObjectURL(blob);state.openUrls.push(u);return u;}
function clearViewer(){
  if(state.book){try{state.book.destroy();}catch{} state.book=null;}
  $("viewerContent").replaceChildren();$("viewerTools").replaceChildren();
  for(const u of state.openUrls)URL.revokeObjectURL(u);
  state.openUrls=[];
}
function closeViewer(){show("viewer",false);clearViewer();}
function loading(){const p=document.createElement("p");p.textContent="Расшифровка на устройстве…";$("viewerContent").append(p);}
function addTool(label,click){
  const btn=document.createElement("button");btn.className="btn btn-outline";
  btn.textContent=label;btn.onclick=click;$("viewerTools").append(btn);return btn;
}
async function openViewer(item){
  clearViewer();show("viewer");
  $("viewerType").textContent=labels[item.category].toUpperCase();
  $("viewerTitle").textContent=item.name;
  try{
    if(item.category==="video"||item.category==="audio"){
      const media=document.createElement(item.category==="video"?"video":"audio");
      media.controls=true;media.playsInline=true;media.preload="metadata";
      const supported=["video/mp4","video/webm","audio/mpeg","audio/mp4",
        "audio/ogg","audio/wav","audio/aac"];
      if(!supported.includes(item.mime))toast("Этот формат может не поддерживаться браузером.",true);
      $("viewerContent").append(media);
      const fallback=async()=>{
        try{media.removeAttribute("src");media.load();
          media.src=objectUrl(await readWhole(item));await media.play().catch(()=>{});
        }catch(e){explain(e);}
      };
      addTool("Загрузить файл целиком (резервный режим)",fallback);
      if(state.worker){
        media.src=new URL("./__media__/"+encodeURIComponent(item.id),location.href).href;
        media.addEventListener("error",()=>toast("Поток недоступен. Попробуй резервный режим.",true),{once:true});
        media.play().catch(()=>{});
      }else{
        toast("Потоковый обработчик недоступен. Используй резервный режим.",true);
      }
    }else if(item.category==="image"){
      loading();
      const blob=await readWhole(item);
      $("viewerContent").replaceChildren();
      const img=document.createElement("img");img.src=objectUrl(blob);img.alt=item.name;
      $("viewerContent").append(img);
    }else if(item.category==="manga"){
      if(!window.JSZip)throw Error("Не удалось загрузить библиотеку JSZip.");
      loading();
      const zip=await JSZip.loadAsync(await readWhole(item));
      const entries=Object.values(zip.files).filter(x=>!x.dir&&/\.(jpe?g|png|webp|gif)$/i.test(x.name))
        .sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
      if(!entries.length)throw Error("В архиве CBZ/ZIP нет изображений.");
      let n=0;const img=document.createElement("img");img.className="manga-page";
      const box=document.createElement("div");box.className="manga-pages";box.append(img);
      $("viewerContent").replaceChildren(box);
      const info=document.createElement("span");
      let pageUrl="";
      async function page(){
        if(pageUrl)URL.revokeObjectURL(pageUrl);
        pageUrl=URL.createObjectURL(await entries[n].async("blob"));
        img.src=pageUrl;info.textContent=(n+1)+" / "+entries.length;
      }
      addTool("← Назад",async()=>{n=Math.max(0,n-1);await page();});
      $("viewerTools").append(info);
      addTool("Вперёд →",async()=>{n=Math.min(entries.length-1,n+1);await page();});
      state.openUrls.push({customCleanup:()=>URL.revokeObjectURL(pageUrl)});
      await page();
    }else if(item.category==="book"){
      loading();const blob=await readWhole(item);
      $("viewerContent").replaceChildren();
      const ext=item.name.toLowerCase().split(".").pop();
      if(ext==="pdf"){
        const frame=document.createElement("iframe");frame.title=item.name;frame.src=objectUrl(blob);
        $("viewerContent").append(frame);
      }else if(ext==="epub"){
        if(!window.ePub)throw Error("Не удалось загрузить библиотеку EPUB.js.");
        const host=document.createElement("div");host.style.cssText="width:100%;height:100%;min-height:400px;background:#f7f2e7;color:#111";
        $("viewerContent").append(host);
        const book=window.ePub(await blob.arrayBuffer());state.book=book;
        const rendition=book.renderTo(host,{width:"100%",height:"100%",flow:"paginated"});
        await rendition.display();
        addTool("← Назад",()=>rendition.prev());addTool("Вперёд →",()=>rendition.next());
      }else if(ext==="txt"){
        const pre=document.createElement("pre");pre.textContent=await blob.text();$("viewerContent").append(pre);
      }else throw Error("Поддерживаются PDF, EPUB и TXT.");
    }
  }catch(e){explain(e);$("viewerContent").textContent="Не удалось открыть: "+e.message;}
}
function logout(){
  navigator.serviceWorker?.controller?.postMessage({type:"CLEAR_SESSION"});
  state.user=null;state.admin=false;state.token=null;state.key=null;state.salt=null;state.catalog=null;
  closeViewer();show("setupPanel",false);show("adminPanel",false);show("uploadBtn",false);
  show("driveBtn",false);show("logoutBtn",false);show("notice");
  $("loginBtn").disabled=false;$("loginBtn").textContent="Войти через Google";
  updateStatus("Не подключено");renderLibrary();
}
function wireUI(){
  $("loginBtn").onclick=login;$("driveBtn").onclick=connectDrive;
  $("logoutBtn").onclick=logout;$("unlockBtn").onclick=unlock;$("createBtn").onclick=createLibrary;
  $("primaryBtn").onclick=()=>state.catalog?
    document.getElementById("librarySection").scrollIntoView({behavior:"smooth"}):
    (show("setupPanel",!!state.token),state.token?$("passphrase").focus():login());
  $("selectFilesBtn").onclick=()=>$("filesInput").click();
  $("uploadBtn").onclick=()=>document.getElementById("adminPanel").scrollIntoView({behavior:"smooth"});
  $("filesInput").onchange=e=>{if(e.target.files?.length)uploadFiles(Array.from(e.target.files)).catch(explain);};
  $("inviteBtn").onclick=invite;$("copyLinkBtn").onclick=copyInvite;
  $("closeViewer").onclick=closeViewer;
  window.addEventListener("keydown",e=>{if(e.key==="Escape")closeViewer();});
  $("viewer").addEventListener("click",e=>{if(e.target===$("viewer"))closeViewer();});
  $("searchInput").addEventListener("input",e=>{state.query=e.target.value;renderLibrary();});
  document.querySelectorAll("[data-category]").forEach(btn=>btn.onclick=()=>{
    document.querySelectorAll("[data-category]").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");state.category=btn.dataset.category;renderLibrary();
    document.querySelector(".sidebar").classList.remove("open");
  });
  $("mobileMenu").onclick=()=>document.querySelector(".sidebar").classList.toggle("open");
}
function checkSetup(){
  if(!validConfig()){
    $("notice").querySelector("strong").textContent="Требуется Google OAuth Client ID";
    $("notice").querySelector("p").textContent="Интерфейс опубликован, но для работы авторизации владелец должен создать Google OAuth Client ID и добавить его в config.js (см. README).";
  }
  $("libraryId").value=state.libraryId;
}
wireUI();checkSetup();registerWorker().catch(console.warn);
