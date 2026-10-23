// Public metadata only. Never fetch or download streaming files from external sites.
const API="https://api.jikan.moe/v4";
const EXTERNAL_HOSTS=new Set(["animelib.me","animelib.org","animelib.ru","yummyanime.tv","yummyanime.org","yummyani.org"]);
export const DEMO_IDS=[52991,5114,9253,16498,32281,38000,1535,20583];
export function parseSource(input){
  const value=String(input||"").trim();
  if(!value)throw Error("Введи название или ссылку на тайтл.");
  let url;
  try {url=new URL(value);}catch{
    return {query:value.slice(0,160),sourceUrl:"",sourceName:"Поиск по названию"};
  }
  const host=url.hostname.toLowerCase().replace(/^www\./,"");
  if(url.protocol!=="https:" || !EXTERNAL_HOSTS.has(host))throw Error("Поддерживаются HTTPS-ссылки AnimeLIB или YummyAnime. Можно ввести название вместо ссылки.");
  const segments=url.pathname.split("/").filter(Boolean);
  const raw=decodeURIComponent(segments.filter(x=>x!=="ru"&&x!=="anime"&&x!=="title"&&x!=="watch").at(-1)||"");
  const query=raw.replace(/-\d+$/,"").replace(/[-_]+/g," ").trim();
  return {query:query||"",sourceUrl:url.origin+url.pathname,sourceName:host.includes("lib")?"AnimeLIB":"YummyAnime"};
}
export function toCard(d){
  return {
    id:Number(d?.mal_id)||0,title:d?.title_english||d?.title||"Без названия",
    originalTitle:d?.title||"",image:d?.images?.webp?.large_image_url||d?.images?.jpg?.large_image_url||"",
    description:d?.synopsis||"Описание не опубликовано.",episodes:Number.isFinite(d?.episodes)?d.episodes:null,
    score:Number.isFinite(d?.score)?d.score:null,year:d?.year||null,
    status:d?.status||"Не указан",type:d?.type||"TV",source:"Jikan / MyAnimeList",
    url:d?.url||"",aired:d?.aired?.string||""
  };
}
async function request(path,{signal}={}){
  const response=await fetch(API+path,{headers:{Accept:"application/json"},signal});
  if(response.status===429)throw Error("Каталог временно ограничивает запросы. Повтори попытку немного позже.");
  if(!response.ok)throw Error("Источник метаданных недоступен (HTTP "+response.status+").");
  return response.json();
}
export async function demoTitles(opts={}){
  const r=await request("/top/anime?limit=18&filter=bypopularity",opts);
  return (r.data||[]).map(toCard).filter(c=>c.id&&c.image).slice(0,12);
}
export async function lookupTitles(input,opts={}){
  const source=parseSource(input);
  const query=source.query.trim();
  if(!query)throw Error("Нельзя распознать название из ссылки. Введи название вручную.");
  const r=await request("/anime?q="+encodeURIComponent(query)+"&limit=12&sfw=true",opts);
  return {source,results:(r.data||[]).map(toCard).filter(c=>c.id)};
}
export async function animeDetails(id,opts={}){
  const n=Number(id);
  if(!Number.isInteger(n)||n<=0)throw Error("Некорректный ID тайтла.");
  const r=await request("/anime/"+n,opts);
  return toCard(r.data);
}
export async function episodeMetadata(id,page=1,opts={}){
  const n=Number(id), p=Number(page);
  if(!Number.isInteger(n)||n<=0||!Number.isInteger(p)||p<1||p>50)throw Error("Некорректная страница эпизодов.");
  const r=await request("/anime/"+n+"/episodes?page="+p,opts);
  return {episodes:(r.data||[]).map(e=>({number:Number(e.mal_id)||0,title:e.title||"Без названия",aired:e.aired||null,filler:!!e.filler})),
    hasNext:!!r.pagination?.has_next_page,current:p};
}
export function validateSavedEntry(entry){
  const id=Number(entry?.id);
  if(!Number.isInteger(id)||id<=0)throw Error("Некорректный идентификатор каталога.");
  const title=String(entry?.title||"").trim().slice(0,180);
  if(!title)throw Error("Нет названия.");
  const source=parseSource(entry?.sourceUrl||title);
  return {id,title,originalTitle:String(entry?.originalTitle||"").slice(0,200),
    image:/^https:\/\/(cdn\.myanimelist\.net|.*\.myanimelist\.net)\//.test(String(entry?.image||""))?entry.image:"",
    description:String(entry?.description||"").slice(0,4000),
    episodes:Number.isInteger(entry?.episodes)&&entry.episodes>=0?entry.episodes:null,
    sourceUrl:source.sourceUrl,sourceName:source.sourceName,updatedAt:new Date().toISOString()};
}
