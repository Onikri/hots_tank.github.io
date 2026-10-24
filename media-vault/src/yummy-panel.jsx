import React,{useEffect,useState} from "react";
import {Film,Link2,ExternalLink,AlertTriangle,Search,Code,Info,PlayCircle} from "lucide-react";
import {sourceUrl,parseHtml,parsePageText} from "./yummy-html.js";
export default function YummyPanel({initialUrl=""}){
 const [url,setUrl]=useState(initialUrl),[raw,setRaw]=useState(""),[visible,setVisible]=useState("");
 const [embed,setEmbed]=useState(false),[data,setData]=useState(null),[error,setError]=useState(""),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
 useEffect(()=>{if(initialUrl)setUrl(initialUrl);},[initialUrl]);
 let valid="";try{valid=sourceUrl(url);}catch{}
 async function inspect(event){
   event?.preventDefault();setError("");setMessage("");setData(null);setBusy(true);
   try{
     const link=sourceUrl(url);
     if(raw.trim()){setData(parseHtml(raw,link));setMessage("HTML обработан локально.");return;}
     if(visible.trim()){setData({...parsePageText(visible),title:"",description:"",episodeLinks:[]});setMessage("Серии найдены в тексте страницы.");return;}
     try{
       const r=await fetch(link,{credentials:"omit",headers:{Accept:"text/html"}});
       if(!r.ok)throw Error("HTTP "+r.status);
       setData(parseHtml(await r.text(),link));
       setMessage("Публичная разметка прочитана.");
     }catch(e){setError("Не удалось прочитать HTML с GitHub Pages: источник может блокировать CORS. Открой оригинальный сайт или вставь публичный HTML / текст страницы. "+(e.message||""));}
   }catch(e){setError(e.message||String(e));}finally{setBusy(false);}
 }
 return <section className="yummy-panel">
  <h2><Film size={22}/> YummyAnime — без API</h2>
  <p className="directory-hint">Приложение пробует получить публичную HTML-страницу и найти сведения о сериях. Видео запускается на сайте-источнике или во встроенной странице, если владелец разрешил iframe. Защищённые ссылки не извлекаются.</p>
  <form className="yummy-form yummy-form-simple" onSubmit={inspect}>
   <label><span><Link2 size={15}/> Ссылка на тайтл</span><input required value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://ru.yummyani.me/catalog/item/blich"/></label>
   <button className="solid-button" type="submit" disabled={busy}><Search size={17}/>{busy?"Проверяю страницу…":"Найти серии"}</button>
  </form>
  {valid&&<div className="yummy-direct">
   <button className="quiet-button" type="button" onClick={()=>setEmbed(v=>!v)}><PlayCircle size={17}/>{embed?"Закрыть встроенную страницу":"Попробовать плеер внутри MediaVault"}</button>
   <a className="quiet-button" href={valid} rel="noopener noreferrer" target="_blank"><ExternalLink size={16}/> Смотреть на YummyAnime</a>
  </div>}
  {embed&&valid&&<div className="yummy-embed"><iframe src={valid} loading="lazy" title="YummyAnime" referrerPolicy="strict-origin-when-cross-origin" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowFullScreen/><p className="directory-hint">Если сайт запрещает встраивание, открой его по ссылке выше.</p></div>}
  <details className="yummy-manual">
   <summary><Code size={16}/> Анализ HTML или текста, если CORS блокирует запрос</summary>
   <p className="directory-hint">Скопируй публичный HTML или текст раздела «Смотреть аниме» на YummyAnime. Не вставляй cookies, пароли и приватные токены.</p>
   <label>HTML страницы<textarea rows={4} value={raw} onChange={e=>setRaw(e.target.value)} placeholder="<!doctype html>…"/></label>
   <label>Или видимый текст<textarea rows={4} value={visible} onChange={e=>setVisible(e.target.value)} placeholder={"Количество серий\n366\nОзвучка\n366 / 366"}/></label>
   <button type="button" className="quiet-button" onClick={inspect}>Обработать вставленное</button>
  </details>
  {error&&<p className="directory-notice" role="alert"><AlertTriangle size={16}/>{error}</p>}
  {message&&<p className="directory-tip" role="status"><Info size={16}/>{message}</p>}
  {data&&<div className="yummy-results">
   {data.title&&<h3>{data.title}</h3>}{data.description&&<p>{data.description}</p>}
   {data.counts.length?data.counts.map((c,i)=><p key={i} className="yummy-source">Опубликовано {c.available} из {c.total} серий</p>):<p className="directory-hint">Подтверждённые числа серий не найдены.</p>}
   {data.total&&<p>Всего серий: {data.total}</p>}
   {!!data.episodeLinks?.length&&<div className="yummy-sources">{data.episodeLinks.map((x,i)=><a key={i} href={x.href} target="_blank" rel="noopener noreferrer" className="quiet-button">{x.name||"Страница эпизода"} <ExternalLink size={14}/></a>)}</div>}
  </div>}
 </section>;
}
