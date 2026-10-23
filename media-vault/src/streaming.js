// Playback is limited to releases explicitly returned by AniLiberty's published REST API.
// No external site player scraping, token extraction or CORS bypass.
const BASE="https://api.anilibria.app/api/v1";
async function api(path,{signal}={}){
  const res=await fetch(BASE+path,{headers:{Accept:"application/json"},signal});
  if(res.status===429)throw Error("AniLibria ограничила частоту запросов.");
  if(!res.ok)throw Error("AniLibria недоступна (HTTP "+res.status+").");
  return res.json();
}
export function safeHls(url){
  if(typeof url!=="string"||!url.trim())return "";
  try{
    const u=new URL(url,"https://anilibria.top");
    if(u.protocol!=="https:"||u.username||u.password)return "";
    const host=u.hostname.toLowerCase();
    if(host==="localhost"||host.endsWith(".local")||host.endsWith(".internal")||
       host==="127.0.0.1"||host==="0.0.0.0"||host==="::1")return "";
    return u.href;
  }catch{return "";}
}
export function normalizeRelease(raw){
  const id=Number(raw?.id),name=raw?.name||{};
  const title=typeof name==="string"?name:name.main||name.english||name.alternative||"";
  return {id:Number.isInteger(id)&&id>0?id:0,title:String(title).trim(),
    alias:typeof raw?.alias==="string"?raw.alias:"",year:raw?.year||null,
    episodes:Array.isArray(raw?.episodes)?raw.episodes.map(normalizeEpisode).filter(e=>e.number!==null):[],
    description:String(raw?.description||"").replace(/<[^>]+>/g,"").slice(0,2000)};
}
export function normalizeEpisode(e){
  const number=Number(e?.ordinal??e?.number??e?.episode);
  const hls=e?.hls||{};
  const streams=[
    {quality:"1080p",url:safeHls(e?.hls_1080||hls.fhd)},
    {quality:"720p",url:safeHls(e?.hls_720||hls.hd)},
    {quality:"480p",url:safeHls(e?.hls_480||hls.sd)}
  ].filter(s=>!!s.url);
  return {number:Number.isFinite(number)&&number>0?number:null,
    title:String(e?.name||e?.name_english||("Серия "+(Number.isFinite(number)?number:""))),
    streams};
}
export async function searchAniLibria(query,opts={}){
  const text=String(query||"").trim().slice(0,120);
  if(!text)throw Error("Введите название аниме.");
  const results=await api("/app/search/releases?query="+encodeURIComponent(text),opts);
  const arr=Array.isArray(results)?results:(Array.isArray(results?.data)?results.data:(results?.data?.items||[]));
  return arr.map(normalizeRelease).filter(r=>r.id&&r.title).slice(0,10);
}
export async function getAniLibriaRelease(id,opts={}){
  const n=Number(id);
  if(!Number.isInteger(n)||n<1)throw Error("Некорректный ID релиза.");
  const data=await api("/anime/releases/"+n,opts);
  return normalizeRelease(data?.data||data);
}
