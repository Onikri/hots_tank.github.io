// YummyAnime's published API: https://api.yani.tv/swagger.json
// Public X-Application tokens are supplied by the user, never compiled into the site.
// No authentication bypass, iframe scraping, or third-party stream extraction.
const BASE="https://api.yani.tv";
const HOSTS=new Set(["yummyani.me","ru.yummyani.me","yummyani.org","yummyanime.tv","yummyanime.org","yummyani.tv"]);
const cleanText=x=>typeof x==="string"?x.trim().slice(0,240):"";
export function parseYummyLink(input){
  let url;try{url=new URL(String(input||"").trim());}catch{throw Error("Вставь полную HTTPS-ссылку на тайтл YummyAnime.");}
  const host=url.hostname.toLowerCase().replace(/^www\./,"");
  if(url.protocol!=="https:"||!HOSTS.has(host)||url.username||url.password)throw Error("Это не HTTPS-ссылка YummyAnime.");
  const parts=url.pathname.split("/").filter(Boolean);
  const item=parts.findIndex(p=>p==="item");
  const slug=item>=0?parts[item+1]:(parts.findIndex(p=>p==="anime")>=0?parts[parts.indexOf("anime")+1]:"");
  if(!slug||!/^[\wа-яА-ЯёЁ-]{1,120}$/.test(slug))throw Error("Не удалось найти идентификатор тайтла в ссылке YummyAnime.");
  return {alias:slug,url:url.origin+url.pathname};
}
export function normalizeYummyTitle(payload){
 const wrapper=payload?.response??payload?.data??payload;
 const item=wrapper?.anime??wrapper?.item??wrapper;
 const title=cleanText(item?.title?.ru||item?.title?.russian||item?.title||
   item?.names?.ru||item?.name||"");
 const id=Number(item?.anime_id??item?.id);
 const poster=item?.poster?.medium||item?.poster?.fullsize||item?.poster?.big||"";
 return {id:Number.isInteger(id)&&id>0?id:null,
   title,description:cleanText(item?.description?.plain||item?.description?.text||item?.description)||"",
   poster:validHttps(poster),episodes:Number.isInteger(item?.episodes_count)?item.episodes_count:null};
}
export function validHttps(value){
 if(typeof value!=="string"||!value.trim())return "";
 try{const u=new URL(value.trim(),"https://yummyani.me");return u.protocol==="https:"&&!u.username&&!u.password?u.href:"";}catch{return "";}
}
function flattenVideos(value,depth=0){
 if(depth>3||value==null)return [];
 if(Array.isArray(value))return value.flatMap(x=>flattenVideos(x,depth+1));
 if(typeof value!=="object")return [];
 if(Object.prototype.hasOwnProperty.call(value,"id")||value.url||value.player||value.link)
   return [value];
 for(const field of ["videos","items","players","dubs","sources","list"]){
  if(value[field])return flattenVideos(value[field],depth+1);
 }
 return Object.values(value).flatMap(x=>flattenVideos(x,depth+1)).slice(0,100);
}
export function normalizeYummyVideos(payload){
 const raw=payload?.response??payload?.data??payload;
 return flattenVideos(raw).slice(0,80).map((v,i)=>{
  const name=cleanText(v?.title||v?.name||v?.voice?.name||v?.translator?.name||
    v?.dubbing?.name||v?.player?.name)||"Источник "+(i+1);
  const episodes=Array.isArray(v?.episodes)?v.episodes:
      Array.isArray(v?.series)?v.series:[];
  const direct=validHttps(v?.file||v?.stream||v?.hls||v?.video_url||"");
  const page=validHttps(v?.url||v?.link||v?.player?.url||v?.iframe||"");
  return {id:v?.id??i,name,episodeCount:episodes.length||null,
    episodes:episodes.slice(0,100).map((e,index)=>({
      number:Number(e?.number??e?.episode??e?.ordinal)||index+1,
      title:cleanText(e?.title||e?.name)||"Серия "+(index+1),
      link:validHttps(e?.page_url||e?.url||e?.link||"")
    })),
    page, direct:/\.(m3u8|mp4)(?:\?|$)/i.test(new URL(direct||"https://invalid.test").pathname+new URL(direct||"https://invalid.test").search)?direct:""
  };
 }).filter(v=>v.page||v.direct||v.episodeCount||v.name);
}
async function request(path,token,{signal}={}){
 const appToken=String(token||"").trim();
 if(!appToken||appToken.length>1024)throw Error("Нужен публичный X-Application токен своего приложения YummyAnime.");
 let res;
 try{res=await fetch(BASE+path,{signal,headers:{"X-Application":appToken,"Lang":"ru","Accept":"application/json"}});}
 catch(error){if(error?.name==="AbortError")throw error;throw Error("Браузер не смог обратиться к YummyAnime API (CORS или сеть). Прокси и обход защиты не используются.");}
 if(res.status===401||res.status===403)throw Error("YummyAnime отклонил токен приложения ("+res.status+"). Проверь X-Application.");
 if(res.status===420)throw Error("YummyAnime требует капчу; автоматическое прохождение не поддерживается.");
 if(res.status===429)throw Error("Достигнут лимит запросов YummyAnime. Повтори позднее.");
 if(!res.ok)throw Error("YummyAnime API вернул HTTP "+res.status+".");
 return res.json();
}
export async function getYummyAnime(input,token,opts={}){
 const parsed=parseYummyLink(input);
 const info=normalizeYummyTitle(await request("/anime/"+encodeURIComponent(parsed.alias),token,opts));
 if(!info.id)throw Error("YummyAnime не вернул ID тайтла. Уточни ссылку.");
 const videos=normalizeYummyVideos(await request("/anime/"+info.id+"/videos",token,opts));
 return {title:info,videos,sourceUrl:parsed.url};
}
