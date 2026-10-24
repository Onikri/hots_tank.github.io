import {useEffect,useRef,useState} from "react";
import {newSalt,deriveVaultKey,openChunk,sealIndex,openIndex,base64ToBytes} from "../crypto.js";
import {driveDownload,readEnvelope,createFolder,folderExists,uploadSmall,
  inviteReader} from "../drive.js";
import {createUploadService} from "./upload.js";

export const labels={all:"Все материалы",video:"Видео",audio:"Музыка",manga:"Манга",
  book:"Книги",image:"Изображения"};
export const categories=Object.entries(labels).map(([id,label])=>({id,label}));
export function formatSize(n){
  return n>=1024**3?(n/1024**3).toFixed(2)+" ГБ":
    n>=1024**2?(n/1024**2).toFixed(1)+" МБ":Math.ceil(n/1024)+" КБ";
}
const configuration=()=>window.MEDIA_VAULT_CONFIG||{};
const isConfigured=()=>!!configuration().googleClientId&&!configuration().googleClientId.startsWith("REPLACE_");
const baseUrl=()=>new URL(import.meta.env?.BASE_URL||"./",window.location.href);
function storedLibrary(){
  const fromUrl=new URLSearchParams(window.location.search).get("library");
  if(fromUrl)return fromUrl;
  try{return localStorage.getItem("mediavault_library")||"";}catch{return "";}
}
function setupNotice(){
  return isConfigured()?{title:"Библиотека закрыта",text:"Войди через Google, подключи Drive и введи секретную фразу библиотеки."}:
    {title:"Требуется Google OAuth Client ID",text:"Для входа владелец должен добавить публичный Google OAuth Client ID в config.js. Порядок настройки есть в README."};
}
function initialState(){
  return {user:null,admin:false,token:null,tokenExpiresAt:0,key:null,catalog:null,
    libraryId:storedLibrary(),status:"Не подключено",notice:setupNotice(),toast:null,
    busy:"",uploadProgress:[],driveConnected:false,workerReady:false,authConfigured:isConfigured()};
}
function cancelled(){return new DOMException("Операция отменена","AbortError");}
async function hashEmail(email){
  const bytes=new TextEncoder().encode(email.trim().toLowerCase());
  const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
  return Array.from(hash,x=>x.toString(16).padStart(2,"0")).join("");
}
async function googleReady(){
  for(let attempt=0;attempt<75;attempt++){
    if(window.google?.accounts?.oauth2)return window.google.accounts.oauth2;
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw Error("Google Identity Services не загрузился. Проверь блокировщики рекламы и сеть.");
}
async function userFromToken(token){
  const response=await fetch("https://www.googleapis.com/oauth2/v3/userinfo",
    {headers:{Authorization:"Bearer "+token}});
  if(!response.ok)throw Object.assign(Error("Не удалось проверить личность через Google."),{status:response.status});
  const user=await response.json();
  if(!user.email_verified||!user.email||!user.sub)throw Error("Google не подтвердил email.");
  return user;
}

function createController(get,patch){
  let mounted=false,epoch=0,tokenTimer=null,toastTimer=null,worker=null,registration=null,salt=null;
  const tokenAlive=()=>!!get().token&&Date.now()<get().tokenExpiresAt;
  const libraryStatus=()=>get().catalog?
    (get().admin?"Администратор":"Зритель")+" · библиотека открыта":
    get().token?"Drive подключён":get().user?"Вход выполнен":"Не подключено";
  function assertEpoch(expected){if(expected!==epoch||!mounted)throw cancelled();}
  function clearToast(){clearTimeout(toastTimer);patch({toast:null});}
  function toast(message,bad=false){
    clearTimeout(toastTimer);
    patch({toast:{id:crypto.randomUUID(),message,bad}});
    toastTimer=setTimeout(clearToast,6500);
  }
  function clearWorkerSession(){
    navigator.serviceWorker?.controller?.postMessage({type:"CLEAR_SESSION"});
  }
  function expireDrive(expectedToken){
    if(!get().user||(expectedToken&&get().token!==expectedToken))return;
    clearTimeout(tokenTimer);
    const wasConnected=!!get().token;
    patch({token:null,tokenExpiresAt:0,driveConnected:false,workerReady:false,status:"Обнови доступ к Drive",
      notice:{title:"Обнови доступ к Drive",text:"Срок доступа истёк. Нажми «Подключить Drive заново», чтобы продолжить."}});
    clearWorkerSession();
    if(wasConnected)toast("Срок доступа к Drive истёк. Подключи Drive заново.",true);
  }
  function error(cause){
    if(cause?.name==="AbortError")return;
    if(cause?.status===401)expireDrive();
    toast(cause?.message||String(cause),true);
    console.error(cause);
  }
  function scheduleExpiry(){
    clearTimeout(tokenTimer);
    const current=get();
    if(!current.token)return;
    tokenTimer=setTimeout(()=>expireDrive(current.token),Math.max(0,current.tokenExpiresAt-Date.now()-15000));
  }
  function driveToken(){
    if(!tokenAlive()){
      if(get().token)expireDrive();
      throw Error("Подключи Google Drive заново.");
    }
    return get().token;
  }
  function workerSession(){
    const current=get();
    if(!tokenAlive()||!current.key||!current.catalog)return null;
    return {type:"SESSION",token:current.token,key:current.key,items:current.catalog.items};
  }
  function matchingWorker(){
    const controller=navigator.serviceWorker?.controller;
    return controller&&controller.scriptURL===new URL("sw.js",baseUrl()).href?controller:null;
  }
  async function registerWorker(){
    if(!("serviceWorker" in navigator))return null;
    if(matchingWorker()){worker=matchingWorker();return worker;}
    if(registration)return registration;
    registration=(async()=>{
      await navigator.serviceWorker.register(new URL("sw.js",baseUrl()).href,{scope:baseUrl().pathname});
      worker=await new Promise((resolve,reject)=>{
        let timer;
        const check=()=>{
          const active=matchingWorker();
          if(active){clearTimeout(timer);navigator.serviceWorker.removeEventListener("controllerchange",check);resolve(active);}
        };
        timer=setTimeout(()=>{
          navigator.serviceWorker.removeEventListener("controllerchange",check);
          reject(Error("Потоковый обработчик не активировался. Обнови страницу или используй резервный режим."));
        },7500);
        navigator.serviceWorker.addEventListener("controllerchange",check);
        check();
      });
      return worker;
    })();
    try{return await registration;}finally{registration=null;}
  }
  async function syncWorker(required=false){
    const payload=workerSession();
    if(!payload){if(required)throw Error("Подключи Drive и открой библиотеку.");return null;}
    const expected=epoch;
    try{
      worker=matchingWorker()||await registerWorker();
      assertEpoch(expected);
      if(!worker)throw Error("Потоковое воспроизведение недоступно. Используй резервный режим.");
      await new Promise((resolve,reject)=>{
        const channel=new MessageChannel();
        const finish=(cause)=>{
          clearTimeout(timer);channel.port1.close();channel.port2.close();
          cause?reject(cause):resolve();
        };
        const timer=setTimeout(()=>finish(Error("Потоковый обработчик не ответил. Обнови страницу.")),5000);
        channel.port1.onmessage=event=>finish(event.data?.ready?null:Error("Потоковый обработчик отклонил сеанс."));
        try{worker.postMessage(payload,[channel.port2]);}catch(cause){finish(cause);}
      });
      assertEpoch(expected);
      patch({workerReady:true});
      return worker;
    }catch(cause){
      if(expected===epoch)patch({workerReady:false});
      if(required||cause?.name==="AbortError")throw cause;
      console.warn("Потоковый обработчик недоступен:",cause);
      return null;
    }
  }
  async function askToken(scope){
    const oauth=await googleReady(),current=get();
    return new Promise((resolve,reject)=>{
      const client=oauth.initTokenClient({
        client_id:configuration().googleClientId,scope,
        prompt:current.user?"":"select_account",
        ...(current.user?{login_hint:current.user.email}:{}),
        callback:result=>result.error?reject(Error(result.error_description||result.error)):
          result.access_token?resolve(result):reject(Error("Google не выдал токен доступа.")),
        error_callback:()=>reject(Error("Окно авторизации Google закрыто или заблокировано."))
      });
      client.requestAccessToken();
    });
  }
  async function run(name,operation){
    if(get().busy){toast("Дождись завершения текущей операции.",true);return false;}
    const expected=epoch,previousStatus=get().status;
    patch({busy:name});
    try{return await operation(expected);}
    catch(cause){
      if(cause?.name!=="AbortError"&&expected===epoch){
        if(cause?.status!==401)patch({status:previousStatus});
        error(cause);
      }
      return false;
    }finally{if(expected===epoch)patch({busy:""});}
  }
  function saveLibraryId(id){
    try{localStorage.setItem("mediavault_library",id);}catch{}
    patch({libraryId:id});
  }
  function enterLibrary(){
    patch({notice:null,status:(get().admin?"Администратор":"Зритель")+" · библиотека открыта"});
  }
  async function login(){
    return run("login",async expected=>{
      if(!isConfigured())throw Error("Сначала добавь Google OAuth Client ID в config.js. Инструкция — в README.");
      const {access_token:token}=await askToken("openid email profile");
      const user=await userFromToken(token);
      const admin=(await hashEmail(user.email))===configuration().adminEmailSha256;
      assertEpoch(expected);
      patch({user,admin,status:admin?"Администратор · Google":"Пользователь · Google",
        notice:{title:"Подключи Google Drive",text:"Личность подтверждена. Теперь предоставь доступ к Drive для своей роли."}});
      toast("Вход выполнен. Теперь подключи Google Drive.");
      return true;
    });
  }
  async function connectDrive(){
    return run("connect",async expected=>{
      const originalUser=get().user;
      if(!originalUser)throw Error("Сначала войди в Google.");
      const scope="openid email profile https://www.googleapis.com/auth/"+(get().admin?"drive":"drive.readonly");
      const result=await askToken(scope);
      const actual=await userFromToken(result.access_token);
      if(actual.sub!==originalUser.sub)throw Error("Для Drive выбери тот же Google-аккаунт, что и при входе.");
      assertEpoch(expected);
      patch({token:result.access_token,tokenExpiresAt:Date.now()+Number(result.expires_in||3600)*1000,
        driveConnected:true,status:"Drive подключён",
        notice:get().catalog?null:{title:"Google Drive подключён",
          text:"Введи ID библиотеки из приглашения и секретную фразу. Администратор может создать новую библиотеку."}});
      scheduleExpiry();
      await syncWorker();
      assertEpoch(expected);
      if(get().catalog)enterLibrary();
      toast("Drive подключён. Токен хранится только в памяти браузера.");
      return true;
    });
  }
  async function unlock(libraryId,passphrase){
    return run("unlock",async expected=>{
      const token=driveToken(),id=(libraryId||get().libraryId||"").trim();
      if(!id)throw Error("Введи ID зашифрованного каталога из приглашения.");
      if(!passphrase)throw Error("Введи секретную фразу.");
      patch({status:"Открываем каталог…"});
      const envelope=await readEnvelope(token,id);
      const nextSalt=base64ToBytes(envelope.salt);
      const key=await deriveVaultKey(passphrase,nextSalt);
      let catalog;
      try{catalog=await openIndex(envelope,key);}
      catch(cause){if(cause?.name==="OperationError")throw Error("Неверная секретная фраза или повреждённый каталог.");throw cause;}
      assertEpoch(expected);
      salt=nextSalt;
      patch({key,catalog});
      saveLibraryId(id);
      await syncWorker();
      assertEpoch(expected);
      enterLibrary();toast("Каталог расшифрован на устройстве.");
      return true;
    });
  }
  async function createLibrary(passphrase,again){
    return run("create",async expected=>{
      if(!get().admin)throw Error("Создавать библиотеку может только администратор.");
      const token=driveToken();
      if(passphrase!==again)throw Error("Секретные фразы не совпадают.");
      const nextSalt=newSalt(),key=await deriveVaultKey(passphrase,nextSalt);
      assertEpoch(expected);
      patch({status:"Создаём библиотеку…"});
      let folderId=configuration().storageFolderId||"";
      if(!(await folderExists(token,folderId))){
        assertEpoch(expected);
        const folder=await createFolder(token,"MediaVault — encrypted media library",null);
        folderId=folder.id;
      }
      assertEpoch(expected);
      const catalog={version:1,folderId,createdAt:new Date().toISOString(),items:[]};
      const sealed=await sealIndex(catalog,key,nextSalt);
      const file=await uploadSmall(token,"vault-catalog.enc.json",
        new Blob([JSON.stringify(sealed)],{type:"application/octet-stream"}),folderId);
      assertEpoch(expected);
      salt=nextSalt;
      patch({key,catalog});
      saveLibraryId(file.id);
      await syncWorker();
      assertEpoch(expected);
      enterLibrary();toast("Библиотека создана. Сохрани секретную фразу и ссылку-приглашение.");
      return true;
    });
  }
  const uploads=createUploadService({
    getSession:()=>({...get(),salt,generation:epoch}),
    onCatalog:async catalog=>{patch({catalog});await syncWorker();},
    onProgress:entry=>{
      const previous=get().uploadProgress;
      const found=previous.some(value=>value.id===entry.id);
      patch({uploadProgress:found?previous.map(value=>value.id===entry.id?entry:value):[...previous,entry]});
    },
    onAuthExpired:()=>expireDrive()
  });
  async function uploadFiles(files,options={}){
    return run("upload",async expected=>{
      patch({uploadProgress:[]});
      const results=await uploads.uploadFiles(files,options);
      assertEpoch(expected);
      patch({status:tokenAlive()?libraryStatus():"Обнови доступ к Drive"});
      const count=results.filter(result=>result.ok).length;
      toast("Загружено файлов: "+count+" из "+Array.from(files||[]).length,
        results.some(result=>!result.ok));
      return results;
    });
  }
  async function importStream(options){
    return run("upload",async expected=>{
      patch({uploadProgress:[]});
      const item=await uploads.importStream(options);
      assertEpoch(expected);
      patch({status:libraryStatus()});
      toast("Видео зашифровано и добавлено в библиотеку.");
      return item;
    });
  }
  async function importVideo(options,fetcher){
    return run("upload",async expected=>{
      patch({uploadProgress:[]});
      const item=await uploads.importVideo(options,fetcher);
      assertEpoch(expected);
      patch({status:libraryStatus()});
      toast("Видео зашифровано и добавлено в библиотеку.");
      return item;
    });
  }
  async function invite(email){
    return run("invite",async expected=>{
      if(!get().admin||!get().catalog)throw Error("Только администратор может приглашать.");
      const address=(email||"").trim();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))throw Error("Проверь адрес email.");
      await inviteReader(driveToken(),get().catalog.folderId,address);
      assertEpoch(expected);
      toast("Приглашение отправлено. Передай ссылку и секретную фразу отдельно.");
      return true;
    });
  }
  function inviteUrl(){
    if(!get().libraryId)throw Error("Сначала открой библиотеку.");
    const link=baseUrl();
    link.searchParams.set("library",get().libraryId);
    return link.href;
  }
  async function copyInvite(){
    try{
      const link=inviteUrl();
      try{await navigator.clipboard.writeText(link);toast("Ссылка-приглашение скопирована.");}
      catch{toast("Скопируй ссылку: "+link);}
      return link;
    }catch(cause){error(cause);return false;}
  }
  async function readWhole(item,{silent=false,signal}={}){
    const expected=epoch,key=get().key;
    if(!key||!get().catalog)throw Error("Сначала открой библиотеку.");
    driveToken();
    if(item.size>700*1024*1024)toast("Большой файл: загрузка целиком может превысить память устройства.");
    const buffers=[];
    try{
      for(let index=0;index<item.chunks.length;index++){
        assertEpoch(expected);
        if(signal?.aborted)throw cancelled();
        const chunk=item.chunks[index];
        const encrypted=await driveDownload(driveToken(),chunk.fileId,{signal});
        assertEpoch(expected);
        if(signal?.aborted)throw cancelled();
        buffers.push(await openChunk(encrypted,key,item.id,index,chunk.iv));
        if(!silent)patch({status:"Скачано "+Math.round((index+1)/item.chunks.length*100)+"%"});
      }
      assertEpoch(expected);
      if(signal?.aborted)throw cancelled();
      return new Blob(buffers,{type:item.mime});
    }finally{if(expected===epoch&&!silent)patch({status:tokenAlive()?libraryStatus():"Обнови доступ к Drive"});}
  }
  async function refreshCatalog(){
    return run("refresh",async expected=>{
      if(!get().catalog||!get().key)throw Error("Сначала открой библиотеку.");
      const envelope=await readEnvelope(driveToken(),get().libraryId);
      assertEpoch(expected);
      const catalog=await openIndex(envelope,get().key);
      assertEpoch(expected);
      salt=base64ToBytes(envelope.salt);
      patch({catalog});
      await syncWorker();
      enterLibrary();toast("Библиотека обновлена.");
      return true;
    });
  }
  async function prepareStream(item){
    const expected=epoch;
    driveToken();
    if(!get().catalog?.items.some(entry=>entry.id===item.id))throw Error("Медиа отсутствует в открытой библиотеке.");
    try{await syncWorker(true);}
    catch(cause){
      if(cause?.name==="AbortError")throw cause;
      return null;
    }
    assertEpoch(expected);
    return new URL("__media__/"+encodeURIComponent(item.id),baseUrl()).href;
  }
  function logout(){
    uploads.cancel();
    epoch++;salt=null;
    clearTimeout(tokenTimer);clearTimeout(toastTimer);
    clearWorkerSession();
    patch({user:null,admin:false,token:null,tokenExpiresAt:0,key:null,catalog:null,driveConnected:false,
      workerReady:false,status:"Не подключено",notice:setupNotice(),toast:null,busy:"",uploadProgress:[]});
  }
  function onMessage(event){
    if(event.data?.type==="SESSION_REQUIRED"){
      const payload=workerSession();
      event.ports?.[0]?.postMessage(payload||{type:"SESSION_UNAVAILABLE"});
      if(!payload&&get().token&&!tokenAlive())expireDrive();
    }
    if(event.data?.type==="DRIVE_AUTH_REQUIRED")expireDrive();
  }
  function onControllerChange(){
    worker=matchingWorker();
    patch({workerReady:false});
    if(workerSession())syncWorker().catch(error);
  }
  function onFocus(){if(get().token&&!tokenAlive())expireDrive();}
  function mount(){
    mounted=true;
    navigator.serviceWorker?.addEventListener("message",onMessage);
    navigator.serviceWorker?.addEventListener("controllerchange",onControllerChange);
    window.addEventListener("focus",onFocus);
    scheduleExpiry();
    registerWorker().catch(cause=>console.warn("Service Worker недоступен:",cause));
  }
  function unmount(){
    uploads.cancel();
    mounted=false;epoch++;
    clearTimeout(tokenTimer);clearTimeout(toastTimer);
    navigator.serviceWorker?.removeEventListener("message",onMessage);
    navigator.serviceWorker?.removeEventListener("controllerchange",onControllerChange);
    window.removeEventListener("focus",onFocus);
    clearWorkerSession();
  }
  return {mount,unmount,actions:{login,connectDrive,logout,unlock,createLibrary,uploadFiles,importStream,importVideo,
    getState:uploads.getState,refreshCatalog,invite,copyInvite,inviteUrl,readWhole,prepareStream,error,clearToast}};
}

export function useVault(){
  const [state,setState]=useState(initialState);
  const stateRef=useRef(state),controllerRef=useRef(null);
  if(!controllerRef.current){
    const patch=change=>{
      stateRef.current={...stateRef.current,...change};
      setState(stateRef.current);
    };
    controllerRef.current=createController(()=>stateRef.current,patch);
  }
  useEffect(()=>{
    const controller=controllerRef.current;
    controller.mount();
    return ()=>controller.unmount();
  },[]);
  return {state,actions:controllerRef.current.actions};
}
