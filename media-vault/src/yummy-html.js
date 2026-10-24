// No API. Only inspect public HTML or visible text without executing page scripts.
const HOSTS=new Set(["yummyani.me","ru.yummyani.me","old.yummyani.me","yummyanime.tv","yummyanime.org","yummyani.org"]);
export function sourceUrl(input){
 let u;try{u=new URL(String(input||"").trim());}catch{throw Error("Вставь HTTPS-ссылку на тайтл YummyAnime.");}
 if(u.protocol!=="https:"||u.username||u.password||!HOSTS.has(u.hostname.replace(/^www\./,"").toLowerCase()))
  throw Error("Разрешены только HTTPS-страницы YummyAnime.");
 if(!/^\/(?:catalog\/item|anime)\/[^?#/]+/.test(u.pathname))throw Error("Нужна страница тайтла /catalog/item/...");
 u.search="";u.hash="";return u.href;
}
export function seriesCounts(text){
 const seen=new Set();
 return [...String(text||"").slice(0,400000).matchAll(/\b(\d{1,4})\s*\/\s*(\d{1,4})\b/g)]
  .map(m=>({available:Number(m[1]),total:Number(m[2])}))
  .filter(x=>x.total>0&&x.total<=2000&&x.available<=x.total)
  .filter(x=>{let key=x.available+":"+x.total;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,15);
}
export function parsePageText(text){
 const t=String(text||"").slice(0,400000);
 const count=t.match(/(?:Количество серий|Всего серий)\s*:?\s*(\d{1,4})/i);
 return {counts:seriesCounts(t),total:count?Number(count[1]):null};
}
function safeLink(value,base){
 try{const u=new URL(value,base);return u.protocol==="https:"&&!u.username&&!u.password?u.href:"";}catch{return "";}
}
export function parseHtml(html,url){
 const page=sourceUrl(url);
 if(typeof DOMParser==="undefined")throw Error("HTML-парсер недоступен.");
 const doc=new DOMParser().parseFromString(String(html||"").slice(0,1500000),"text/html");
 const meta=k=>doc.querySelector('meta[property="'+k+'"], meta[name="'+k+'"]')?.getAttribute("content")||"";
 const text=doc.body?.textContent||"";
 const title=(meta("og:title")||doc.querySelector("h1")?.textContent||doc.title||"").trim().slice(0,180);
 const description=(meta("og:description")||meta("description")||"").trim().slice(0,2000);
 const cover=safeLink(meta("og:image"),page);
 const episodeLinks=[...doc.querySelectorAll('a[href*="/episode"],a[href*="/video"]')]
  .map(a=>({name:(a.textContent||"").trim().slice(0,80),href:safeLink(a.getAttribute("href"),page)}))
  .filter(a=>a.href&&new URL(a.href).origin===new URL(page).origin).slice(0,60);
 return {title,description,cover,episodeLinks,...parsePageText(text)};
}
