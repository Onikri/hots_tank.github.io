import React,{useState,useEffect} from "react";
import {Film,Link2,KeyRound,ExternalLink,AlertTriangle,Search} from "lucide-react";
import {getYummyAnime} from "./yummy-api.js";
export default function YummyPanel({initialUrl=""}){
 const [url,setUrl]=useState(initialUrl||"");
 const [token,setToken]=useState(()=>sessionStorage.getItem("mediavault-yummy-app")||"");
 const [result,setResult]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
 useEffect(()=>{if(initialUrl)setUrl(initialUrl);},[initialUrl]);
 async function load(event){
  event.preventDefault();setError("");setResult(null);setBusy(true);
  try{
   sessionStorage.setItem("mediavault-yummy-app",token.trim());
   const data=await getYummyAnime(url,token);setResult(data);
  }catch(e){setError(e.message||"Не удалось получить сведения.");}
  finally{setBusy(false);}
 }
 return <section className="yummy-panel">
   <h2><Film size={22}/> YummyAnime — официальные данные</h2>
   <p className="directory-hint">YummyAnime требует публичный ключ приложения <code>X-Application</code>. Введи свой ключ — он останется только в этой браузерной сессии, в GitHub не отправляется. Покажем источники и серии, если их возвращает API. Видео других сайтов не извлекается.</p>
   <form onSubmit={load} className="yummy-form">
     <label><span><Link2 size={15}/> Ссылка на тайтл YummyAnime</span><input value={url} onChange={e=>setUrl(e.target.value)} required placeholder="https://ru.yummyani.me/catalog/item/..." autoComplete="off"/></label>
     <label><span><KeyRound size={15}/> Публичный токен X-Application</span><input value={token} onChange={e=>setToken(e.target.value)} type="password" required placeholder="Токен из YummyAnime → Приложения" autoComplete="off"/></label>
     <button type="submit" className="solid-button" disabled={busy}><Search size={17}/>{busy?"Проверяем API…":"Получить доступные серии"}</button>
   </form>
   {error&&<p className="directory-notice" role="alert"><AlertTriangle size={16}/>{error}</p>}
   {result&&<div className="yummy-results">
      <h3>{result.title.title||"Тайтл YummyAnime"}</h3>
      {result.title.description&&<p>{result.title.description}</p>}
      {!result.videos.length?<p className="directory-notice">API не вернул доступных видеоисточников. Наличие эпизодов не подтверждено.</p>:
       <div className="yummy-sources">{result.videos.map((source,index)=><article key={String(source.id)+"-"+index} className="yummy-source">
         <h4>{source.name}</h4>
         <p>{source.episodeCount===null?"Количество серий API не указал":source.episodeCount+" серий по API"}</p>
         {source.episodes.length>0&&<ol>{source.episodes.map((ep,j)=><li key={j}>
           <span>Серия {ep.number}: {ep.title}</span>
           {ep.link&&<a href={ep.link} target="_blank" rel="noopener noreferrer"><ExternalLink size={14}/> Источник</a>}
         </li>)}</ol>}
         {(source.page||source.direct)&&<a href={source.page||source.direct} className="quiet-button" target="_blank" rel="noopener noreferrer"><ExternalLink size={15}/> Открыть у источника</a>}
       </article>)}</div>}
      <a href={result.sourceUrl} className="quiet-button" target="_blank" rel="noopener noreferrer">Страница на YummyAnime <ExternalLink size={15}/></a>
   </div>}
   <a href="https://yummyani.me/dev/applications" target="_blank" rel="noopener noreferrer" className="yummy-help">Создать приложение и получить X-Application ↗</a>
 </section>;
}
