import React, {useEffect,useState,useRef} from "react";
import {motion} from "motion/react";
import {Search,CloudUpload,Film,BookOpen,ExternalLink,ArrowLeft,Info,ShieldCheck,RefreshCw,Import,FolderPlus,HardDrive,LockKeyhole,AlertTriangle,CheckCircle2,Images,ChevronRight,PlayCircle,MonitorPlay} from "lucide-react";
import {demoTitles,lookupTitles,animeDetails,episodeMetadata,validateSavedEntry,imageCandidates} from "./metadata.js";
import {searchAniLibria,getAniLibriaRelease} from "./streaming.js";
import "./pages.css";
import YummyPanel from "./yummy-panel.jsx";

const fallback=[
{id:52991,title:"Провожающая в последний путь Фрирен",originalTitle:"Frieren: Beyond Journey's End",image:"",description:"Популярное фэнтези-аниме. Подробные сведения загружаются из открытого каталога.",episodes:null,score:null},
{id:5114,title:"Стальной алхимик: Братство",image:"",description:"Фэнтези и приключения. Открой карточку для получения данных.",episodes:null,score:null},
{id:9253,title:"Врата Штейна",image:"",description:"Научная фантастика. Открой карточку для получения данных.",episodes:null,score:null},
{id:16498,title:"Атака титанов",image:"",description:"Приключенческое фэнтези. Открой карточку для получения данных.",episodes:null,score:null},
{id:32281,title:"Твоё имя",image:"",description:"Анимационный фильм. Открой карточку для получения данных.",episodes:null,score:null},
{id:38000,title:"Клинок, рассекающий демонов",image:"",description:"Фэнтези и приключения. Открой карточку для получения данных.",episodes:null,score:null}
];
function Poster({item}){
 const urls=imageCandidates(item);
 const [index,setIndex]=useState(0);
 useEffect(()=>setIndex(0),[item?.id,item?.image,item?.imageFallback,item?.shikiImage]);
 return <div className={"directory-poster"+(index>=urls.length?" poster-fallback":"")}>
   <div className="poster-placeholder" aria-hidden="true"><Film size={39}/><span>{(item?.title||"Аниме").slice(0,25)}</span></div>
   {index<urls.length&&<img key={urls[index]} src={urls[index]} alt={"Обложка: "+item.title}
     loading="lazy" referrerPolicy="no-referrer" onError={()=>setIndex(v=>v+1)}/>}
   <span className="poster-demo">{item?.sourceName&&item?.updatedAt?"МОЯ":"КАТАЛОГ"}</span>
   {item.score&&<span className="poster-score">★ {item.score}</span>}
 </div>;
}
function StreamPlayer({stream,onClose}){
 const video=useRef(null),[problem,setProblem]=useState("");
 useEffect(()=>{
  const el=video.current;
  if(!el||!stream?.url)return;
  let disposed=false,player=null;
  setProblem("");
  if(el.canPlayType("application/vnd.apple.mpegurl")){
   el.src=stream.url;
  }else{
   import("hls.js").then(({default:Hls})=>{
    if(disposed)return;
    if(!Hls.isSupported()){setProblem("Этот браузер не поддерживает HLS. Попробуй открыть источник напрямую.");return;}
    player=new Hls({enableWorker:true});
    player.loadSource(stream.url);player.attachMedia(el);
    player.on(Hls.Events.ERROR,(_,data)=>{if(data?.fatal)setProblem("Воспроизведение не удалось: поток может быть недоступен или заблокирован поставщиком.");});
   }).catch(()=>setProblem("Не удалось загрузить модуль HLS."));
  }
  return()=>{disposed=true;player?.destroy();el.pause();el.removeAttribute("src");el.load();};
 },[stream?.url]);
 return <div className="external-video">
  <div className="external-video-head"><strong>{stream.title||"Серия"} · {stream.quality}</strong>
    <button type="button" onClick={onClose} className="quiet-button">Закрыть</button></div>
  <video ref={video} controls playsInline preload="metadata" onError={()=>setProblem("Источник не поддерживает просмотр в этом браузере или блокирует межсайтовые запросы.")}/>
  {problem&&<p className="directory-notice" role="alert">{problem} <a href={stream.url} target="_blank" rel="noopener noreferrer">Открыть поток отдельно</a></p>}
 </div>;
}
function PublicReleasePanel({title}){
 const [results,setResults]=useState([]),[release,setRelease]=useState(null),[busy,setBusy]=useState(false);
 const [message,setMessage]=useState(""),[selected,setSelected]=useState(null);
 useEffect(()=>{setResults([]);setRelease(null);setMessage("");setSelected(null);},[title?.id]);
 if(!title)return null;
 async function search(){
  setBusy(true);setMessage("");setSelected(null);setRelease(null);
  try{
   const data=await searchAniLibria(title.originalTitle||title.title);
   setResults(data);
   if(!data.length)setMessage("Подтверждённых совпадений в AniLibria нет. Для этого тайтла источник потоков недоступен.");
  }catch(e){setMessage("Поиск AniLibria: "+e.message);}
  finally{setBusy(false);}
 }
 async function choose(id){
  setBusy(true);setMessage("");setSelected(null);
  try{
   const data=await getAniLibriaRelease(id);setRelease(data);
   if(!data.episodes.length)setMessage("Для выбранного релиза нет опубликованного списка серий.");
  }catch(e){setMessage("Не удалось получить серии: "+e.message);}
  finally{setBusy(false);}
 }
 return <section className="public-release" aria-label="Публичные релизы AniLibria">
  <div className="public-release-heading"><div><h2>Доступные серии с AniLibria</h2>
   <p>Публичный каталог другого сервиса: серии и русская озвучка могут отличаться от YummyAnime.</p></div>
   <button type="button" className="quiet-button" disabled={busy} onClick={search}><Search size={17}/>{busy?"Загрузка…":"Найти релизы"}</button>
  </div>
  {!!results.length&&!release&&<div className="release-list">{results.map(r=><button className="release-choice" type="button" key={r.id} onClick={()=>choose(r.id)} disabled={busy}>
    <strong>{r.title}</strong><span>{r.year||"Год не указан"}</span><ChevronRight size={18}/></button>)}</div>}
  {release&&<div className="release-detail"><div className="release-summary">
   <strong>{release.title}</strong><button className="quiet-button" type="button" onClick={()=>{setRelease(null);setSelected(null);}}>Другой релиз</button></div>
   <div className="release-episodes">{release.episodes.map((ep,i)=><div className="release-episode" key={ep.number||i}>
    <span>Серия {ep.number||i+1} — {ep.title}</span>
    <div>{ep.streams.length?ep.streams.map(st=><button type="button" key={st.quality}
      onClick={()=>setSelected({...st,title:"Серия "+(ep.number||i+1)})}><PlayCircle size={16}/>{st.quality}</button>):
      <small>Видео не предоставлено источником</small>}</div>
   </div>)}</div>
   {selected&&<StreamPlayer stream={selected} onClose={()=>setSelected(null)}/>}
  </div>}
  {message&&<p className="directory-notice" role="status">{message}</p>}
  <p className="directory-hint">Просмотр работает только с потоками, которые вернул публичный API AniLibria, если CDN разрешает воспроизведение из браузера. Ограничения доступа не обходятся.</p>
 </section>;
}
function MediaCard({item,onClick}){
 return <motion.button type="button" className="directory-card" whileTap={{scale:.965}} onClick={onClick}>
   <Poster item={item}/><span className="directory-title">{item.title}</span>
   <span className="directory-sub">{item.episodes==null?"Эпизоды уточняются":item.episodes+" эп."} · {item.type||"Аниме"}</span>
 </motion.button>;
}
function PageHeader({eyebrow,title,subtitle,back}){
 return <div className="directory-heading">
  {back&&<button type="button" onClick={back} className="directory-back"><ArrowLeft size={17}/> Назад</button>}
  <span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{subtitle&&<p>{subtitle}</p>}
 </div>;
}
export function LibraryPages({route,navigate,hasCatalog,isAdmin,signedIn,driveConnected}){
 const [demo,setDemo]=useState(fallback),[demoBusy,setDemoBusy]=useState(false),[demoError,setDemoError]=useState("");
 const [importInput,setImportInput]=useState(""),[matches,setMatches]=useState([]),[source,setSource]=useState(null);
 const [lookupBusy,setLookupBusy]=useState(false),[lookupError,setLookupError]=useState("");
 const [detail,setDetail]=useState(null),[detailBusy,setDetailBusy]=useState(false),[detailError,setDetailError]=useState("");
 const [episodes,setEpisodes]=useState([]),[episodePage,setEpisodePage]=useState(1),[moreEpisodes,setMoreEpisodes]=useState(false);
 const [saved,setSaved]=useState([]),[saving,setSaving]=useState(false),[saveMessage,setSaveMessage]=useState("");
 const [uploads,setUploads]=useState([]),[dragging,setDragging]=useState(false);
 const uploadRef=useRef(null);
 useEffect(()=>{
   const onEntries=e=>setSaved(Array.isArray(e.detail?.entries)?e.detail.entries:[]);
   const onUpload=e=>{
     const d=e.detail||{};
     setUploads(old=>{
       const index=old.findIndex(x=>x.name===d.name);
       const next={name:d.name,percent:d.percent||0,status:d.status||"pending",error:d.error||""};
       return index<0?[...old,next]:old.map((x,i)=>i===index?next:x);
     });
   };
   document.addEventListener("mediavault:metadata-updated",onEntries);
   document.addEventListener("mediavault:upload-progress",onUpload);
   return ()=>{document.removeEventListener("mediavault:metadata-updated",onEntries);document.removeEventListener("mediavault:upload-progress",onUpload);};
 },[]);
 useEffect(()=>{
   if(route!=="/discover"||demoBusy||demoError||demo!==fallback)return;
   const controller=new AbortController();
   setDemoBusy(true);
   demoTitles({signal:controller.signal}).then(items=>{if(items.length)setDemo(items);else setDemoError("Внешний каталог не вернул карточки — показаны примеры.");})
     .catch(e=>{if(e.name!=="AbortError")setDemoError("Показаны встроенные примеры: "+e.message);})
     .finally(()=>setDemoBusy(false));
   return ()=>controller.abort();
 },[route]);
 const titleId=route.match(/^\/title\/(\d+)$/)?.[1];
 useEffect(()=>{
   if(!titleId)return;
   const controller=new AbortController();
   setDetail(null);setEpisodes([]);setEpisodePage(1);setMoreEpisodes(false);setDetailError("");setSaveMessage("");setDetailBusy(true);
   animeDetails(titleId,{signal:controller.signal}).then(setDetail).catch(e=>{if(e.name!=="AbortError")setDetailError(e.message);}).finally(()=>setDetailBusy(false));
   episodeMetadata(titleId,1,{signal:controller.signal}).then(r=>{setEpisodes(r.episodes);setMoreEpisodes(r.hasNext);}).catch(()=>{});
   return ()=>controller.abort();
 },[titleId]);
 async function more(){
   const page=episodePage+1;
   try{const r=await episodeMetadata(titleId,page);setEpisodes(old=>[...old,...r.episodes]);setEpisodePage(page);setMoreEpisodes(r.hasNext);}
   catch(e){setDetailError(e.message);}
 }
 async function search(e){
   e.preventDefault();setLookupBusy(true);setLookupError("");setMatches([]);setSource(null);
   try{const r=await lookupTitles(importInput);setSource(r.source);setMatches(r.results);if(!r.results.length)setLookupError("Совпадений не найдено. Попробуй оригинальное название аниме.");}
   catch(e){setLookupError(e.message);}
   finally{setLookupBusy(false);}
 }
 function choose(item){
   setDetail(item);navigate("/title/"+item.id);
 }
 async function save(item){
   setSaveMessage("");
   if(!isAdmin||!hasCatalog){setSaveMessage("Чтобы сохранить карточку в Drive, войди как администратор и открой библиотеку.");return;}
   setSaving(true);
   const requestId=crypto.randomUUID();
   let entry;
   try{entry=validateSavedEntry({...item,sourceUrl:source?.sourceUrl||""});}
   catch(e){setSaveMessage(e.message);setSaving(false);return;}
   const onResult=e=>{
     if(e.detail?.requestId!==requestId)return;
     document.removeEventListener("mediavault:metadata-result",onResult);
     clearTimeout(timer);setSaving(false);setSaveMessage(e.detail.ok?"Карточка сохранена в зашифрованном каталоге Drive.":e.detail.error||"Ошибка сохранения.");
   };
   const timer=setTimeout(()=>{document.removeEventListener("mediavault:metadata-result",onResult);setSaving(false);setSaveMessage("Нет ответа от модуля Drive.");},20000);
   document.addEventListener("mediavault:metadata-result",onResult);
   document.dispatchEvent(new CustomEvent("mediavault:save-metadata",{detail:{entry,requestId}}));
 }
 function filesToDrive(fileList){
   if(!fileList?.length)return;
   if(!isAdmin||!hasCatalog){navigate("/settings");return;}
   const input=document.getElementById("filesInput");
   if(!input)return;
   const transfer=new DataTransfer();
   Array.from(fileList).forEach(f=>transfer.items.add(f));
   input.files=transfer.files;
   input.dispatchEvent(new Event("change",{bubbles:true}));
 }
 const triggerPicker=()=>{if(isAdmin&&hasCatalog)document.getElementById("filesInput")?.click();else navigate("/settings");};
 if(route==="/home"||route==="/catalog"||route==="/")return null;
 return <main className="main-content directory-page">
  {route==="/discover"&&<>
   <PageHeader eyebrow="ОТКРЫТЫЙ КАТАЛОГ" title="Найти новое" subtitle="Тестовые карточки с русскими названиями, обложками и данными каталогов Shikimori / MyAnimeList. Это не твои личные файлы."/>
   <div className="directory-toolbar"><button className="quiet-button" type="button" onClick={()=>navigate("/import")}><Search size={17}/> Поиск по ссылке или названию</button><span className="directory-caption">{demoBusy?"Загружаем обложки…":"Демо-режим"}</span></div>
   {demoError&&<p className="directory-notice">{demoError}</p>}
   <div className="directory-grid">{demo.map(item=><MediaCard key={item.id} item={item} onClick={()=>choose(item)}/>)}</div>
   <div className="directory-tip"><Info size={18}/> Каталог показывает метаданные, а не видеофайлы. Для просмотра своих файлов открой «Моя библиотека».</div>
   {!!saved.length&&<><h2 className="directory-subheading">Сохранено в твоём Drive</h2><div className="directory-grid">{saved.map(item=><MediaCard key={item.id} item={item} onClick={()=>choose(item)}/>)}</div></>}
  </>}
  {route==="/import"&&<>
   <PageHeader eyebrow="ПОИСК ПО ИСТОЧНИКАМ" title="Импорт карточки" subtitle="Введи название аниме или ссылку AnimeLIB / YummyAnime. Подберём русские названия и обложки из открытых каталогов." back={()=>navigate("/discover")}/>
   <form className="directory-import" onSubmit={search}>
     <label htmlFor="importValue">Название или HTTPS-ссылка</label>
     <input id="importValue" value={importInput} onChange={e=>setImportInput(e.target.value)} placeholder="Например, Frieren или ссылка с AnimeLIB" required/>
     <button className="solid-button" disabled={lookupBusy} type="submit"><Search size={18}/>{lookupBusy?"Ищем…":"Найти карточку"}</button>
   </form>
   <p className="directory-hint">Из сторонней ссылки берётся только название для поиска. Обложка, русское название и описание берутся из Shikimori/Jikan, а доступные для просмотра серии можно отдельно искать в AniLibria. YummyAnime требует собственный API-токен X-Application; без него видео с YummyAnime автоматически не извлекаются.</p>
   <YummyPanel initialUrl={source?.sourceName==="YummyAnime"?source.sourceUrl:""}/>
   {lookupError&&<div className="directory-notice" role="alert">{lookupError}</div>}
   {!!matches.length&&<><h2 className="directory-subheading">Результаты поиска · {matches.length}</h2><div className="directory-grid">{matches.map(x=><MediaCard key={x.id} item={x} onClick={()=>choose(x)}/>)}</div></>}
  </>}
  {titleId&&<>
   <PageHeader eyebrow="КАРТОЧКА ТАЙТЛА" title="Подробности" back={()=>navigate("/discover")}/>
   {detailBusy&&<p className="directory-hint">Загружаем описание и список эпизодов…</p>}
   {detailError&&<p className="directory-notice" role="alert">{detailError}</p>}
   {detail&&<>
    <div className="detail-hero"><Poster item={detail}/><div className="detail-body">
     <h2>{detail.title}</h2><p className="detail-original">{detail.originalTitle||"Данные каталога Jikan"}</p>
     <div className="detail-facts"><span>{detail.type||"Аниме"}</span><span>{detail.year||"Год не указан"}</span>{detail.score&&<span>★ {detail.score}</span>}
       <span>{detail.episodes==null?"Серии не уточнены":detail.episodes+" эпизодов по Jikan"}</span></div>
     <p className="detail-synopsis">{detail.description}</p>
     <div className="detail-actions"><button className="solid-button" disabled={saving} onClick={()=>save(detail)} type="button"><FolderPlus size={17}/>{saving?"Сохранение…":"В мою библиотеку"}</button>
      {detail.trailerUrl&&<a className="quiet-button" href={detail.trailerUrl} target="_blank" rel="noopener noreferrer"><PlayCircle size={16}/> Трейлер</a>}
      {detail.url&&<a className="quiet-button" href={detail.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16}/> Источник метаданных</a>}
      {source?.sourceUrl&&<a className="quiet-button" href={source.sourceUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={16}/> Открыть на {source.sourceName}</a>}</div>
     {saveMessage&&<p className="directory-notice" role="status">{saveMessage}</p>}
    </div></div>
    <YummyPanel key={String(detail.id)} initialUrl={source?.sourceName==="YummyAnime"?source.sourceUrl:""}/>
    <PublicReleasePanel title={detail}/>
    <h2 className="directory-subheading">Эпизоды MyAnimeList <small>информационный список, не видео</small></h2>
    {episodes.length?<div className="episodes-list">{episodes.map((ep,i)=><div key={ep.number||i} className="episode-row"><span className="episode-number">{ep.number||i+1}</span><span>{ep.title}</span><small>{ep.aired?new Date(ep.aired).toLocaleDateString("ru"):""}</small></div>)}</div>:<div className="directory-tip"><Info size={18}/> Список эпизодов не опубликован или временно недоступен.</div>}
    {moreEpisodes&&<button className="quiet-button directory-more" onClick={more} type="button">Показать ещё эпизоды <ChevronRight size={16}/></button>}
   </>}
  </>}
  {route==="/upload"&&<>
   <PageHeader eyebrow="МОЁ ХРАНИЛИЩЕ" title="Загрузка файлов" subtitle="Файлы шифруются AES-256-GCM на твоём устройстве и загружаются в твой Google Drive."/>
   <div className="directory-upload" onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);filesToDrive(e.dataTransfer.files);}} data-dragging={dragging}>
    <CloudUpload size={40}/><h2>{hasCatalog&&isAdmin?"Добавь медиа в библиотеку":"Сначала подключи библиотеку"}</h2>
    <p>MP4, MP3, PNG, PDF, EPUB, ZIP, CBZ, TXT и другие файлы. Перетащи сюда файлы или выбери их на устройстве.</p>
    <button className="solid-button" type="button" onClick={triggerPicker}>{hasCatalog&&isAdmin?"Выбрать файлы":"Перейти к подключению"}</button>
   </div>
   {!isAdmin&&<div className="directory-notice"><AlertTriangle size={17}/> Загрузка доступна только администратору открытой библиотеки.</div>}
   {uploads.length>0&&<><h2 className="directory-subheading">Очередь загрузки</h2><div className="directory-uploads">{uploads.map((f,i)=><div key={i} className="upload-row"><strong>{f.name}</strong><span>{f.status==="done"?"Готово":f.status==="error"?f.error:f.percent+"%"}</span><progress value={f.percent} max="100"/></div>)}</div></>}
  </>}
  {route==="/settings"&&<>
   <PageHeader eyebrow="УПРАВЛЕНИЕ" title="Библиотека и доступ" subtitle="Настройки подключения к Google Drive и зашифрованному каталогу."/>
   <div className="directory-settings">
    <div className="directory-setting-row"><LockKeyhole size={22}/><div><strong>Вход в Google</strong><span>{signedIn?"Выполнен":"Не выполнен"}</span></div><button className="quiet-button" onClick={()=>document.getElementById(signedIn?"logoutBtn":"loginBtn")?.click()} type="button">{signedIn?"Выйти":"Войти"}</button></div>
    <div className="directory-setting-row"><HardDrive size={22}/><div><strong>Google Drive</strong><span>{driveConnected?"Подключён":"Не подключён"}</span></div><button className="quiet-button" disabled={!signedIn} onClick={()=>document.getElementById("driveBtn")?.click()} type="button">{driveConnected?"Обновить":"Подключить"}</button></div>
    <div className="directory-setting-row"><ShieldCheck size={22}/><div><strong>Каталог MediaVault</strong><span>{hasCatalog?(isAdmin?"Открыт · администратор":"Открыт · зритель"):"Закрыт"}</span></div><button className="quiet-button" onClick={()=>navigate("/catalog")} type="button">Открыть</button></div>
   </div>
   <div className="directory-tip"><Info size={18}/> Секретная фраза никогда не передаётся на сервер. Для подключения существующего каталога нужен его ID и исходная секретная фраза. Не создавай новую библиотеку вместо старой.</div>
  </>}
  {!["/discover","/import","/upload","/settings"].includes(route)&&!titleId&&<div className="directory-notice">Страница не найдена. <button onClick={()=>navigate("/home")}>На главную</button></div>}
 </main>;
}

export function SavedMetadata({navigate}){
 const [entries,setEntries]=useState([]);
 useEffect(()=>{
  const handler=e=>setEntries(Array.isArray(e.detail?.entries)?e.detail.entries:[]);
  document.addEventListener("mediavault:metadata-updated",handler);
  return()=>document.removeEventListener("mediavault:metadata-updated",handler);
 },[]);
 if(!entries.length)return null;
 return <section className="saved-metadata"><h2 className="directory-subheading">Сохранённые карточки <small>{entries.length}</small></h2>
  <p className="directory-hint">Описания и обложки сохранены в зашифрованном каталоге Google Drive; видеофайлы загружаются отдельно.</p>
  <div className="directory-grid">{entries.map(item=><MediaCard key={item.id} item={item} onClick={()=>navigate("/title/"+item.id)}/>)}</div>
 </section>;
}
