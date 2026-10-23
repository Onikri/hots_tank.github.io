// Public metadata only. Never fetch or download streaming files from external sites.
const API="https://api.jikan.moe/v4";
const SHIKI="https://shikimori.one/api/graphql";
const RU_BY_ID=Object.freeze({
  52991:"Провожающая в последний путь Фрирен",
  5114:"Стальной алхимик: Братство",
  9253:"Врата Штейна",
  16498:"Атака титанов",
  32281:"Твоё имя",
  38000:"Клинок, рассекающий демонов",
  1535:"Тетрадь смерти",
  20583:"Волейбол!!",
  21:"Ван-Пис",
  1:"Ковбой Бибоп",
  30276:"Ванпанчмен",
  11061:"Охотник х Охотник",
  199:"Унесённые призраками"
});
function cyrillic(str){return /[А-Яа-яЁё]/.test(String(str||""));}
export function imageCandidates(item){
  const sources=[item?.image,item?.imageFallback,item?.shikiImage];
  return [...new Set(sources.filter(x=>{
    try{const u=new URL(x);return u.protocol==="https:"&&
      (u.hostname==="cdn.myanimelist.net"||u.hostname.endsWith(".myanimelist.net")||
       u.hostname==="shikimori.one"||u.hostname.endsWith(".shikimori.one"));}catch{return false;}
  }))];
}
export async function localizeCards(cards,{signal}={}){
  const original=cards.map(c=>({...c,title:RU_BY_ID[c.id]||c.title}));
  const ids=original.map(c=>c.id).filter(id=>Number.isInteger(id)&&id>0);
  if(!ids.length)return original;
  try{
    const query='query ($ids: String) { animes(ids: $ids, limit: 50) { malId russian description poster { mainUrl originalUrl } } }';
    const response=await fetch(SHIKI,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},
      body:JSON.stringify({query,variables:{ids:ids.join(",")}}),
      signal:signal&&typeof AbortSignal.any==="function"?
        AbortSignal.any([signal,AbortSignal.timeout(4500)]):
        (typeof AbortSignal.timeout==="function"?AbortSignal.timeout(4500):signal)});
    if(!response.ok)throw Error("Shikimori "+response.status);
    const data=await response.json();
    const byId=new Map((data?.data?.animes||[]).map(x=>[Number(x.malId),x]));
    return original.map(c=>{
      const ru=byId.get(c.id);
      if(!ru)return c;
      const poster=ru.poster?.mainUrl||ru.poster?.originalUrl||"";
      let normalized="";
      try{const url=new URL(poster,"https://shikimori.one");if(url.protocol==="https:"&&
         (url.hostname==="shikimori.one"||url.hostname.endsWith(".shikimori.one")))normalized=url.href;}catch{}
      return {...c,title:cyrillic(ru.russian)?ru.russian:c.title,
        description:cyrillic(ru.description)?ru.description:c.description,
        shikiImage:normalized};
    });
  }catch(error){if(error?.name==="AbortError")throw error;return original;}
}

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
    id:Number(d?.mal_id)||0,title:(d?.titles||[]).find(t=>cyrillic(t.title))?.title||RU_BY_ID[Number(d?.mal_id)]||
      d?.title_english||d?.title||"Без названия",
    originalTitle:d?.title||"",image:d?.images?.webp?.large_image_url||d?.images?.jpg?.large_image_url||"",
    imageFallback:d?.images?.jpg?.large_image_url||d?.images?.jpg?.image_url||d?.images?.webp?.image_url||"",
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
  return localizeCards((r.data||[]).map(toCard).filter(c=>c.id).slice(0,12),opts);
}
export async function lookupTitles(input,opts={}){
  const source=parseSource(input);
  const query=source.query.trim();
  if(!query)throw Error("Нельзя распознать название из ссылки. Введи название вручную.");
  const r=await request("/anime?q="+encodeURIComponent(query)+"&limit=12&sfw=true",opts);
  return {source,results:await localizeCards((r.data||[]).map(toCard).filter(c=>c.id),opts)};
}
export async function animeDetails(id,opts={}){
  const n=Number(id);
  if(!Number.isInteger(n)||n<=0)throw Error("Некорректный ID тайтла.");
  const r=await request("/anime/"+n,opts);
  return (await localizeCards([toCard(r.data)],opts))[0];
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
    image:imageCandidates(entry)[0]||"",imageFallback:imageCandidates(entry)[1]||"",
    description:String(entry?.description||"").slice(0,4000),
    episodes:Number.isInteger(entry?.episodes)&&entry.episodes>=0?entry.episodes:null,
    sourceUrl:source.sourceUrl,sourceName:source.sourceName,updatedAt:new Date().toISOString()};
}
