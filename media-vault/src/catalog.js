// Free metadata only. Source discovery and every media byte stay on the import server.
const strip=value=>String(value||'').replace(/<[^>]*>/g,' ').replace(/\[\/?(?:b|i|u|url|spoiler|quote)[^\]]*\]/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
export const normalized=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
// A spelling fallback, not a translation: e.g. Наруто → naruto. Keep the
// original query and metadata intact; translated titles still need catalogue aliases.
const cyrillic={а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',і:'i',ї:'yi',є:'ye',ґ:'g'};
export function alternateSpelling(query){
  const value=String(query||'').normalize('NFKC').trim();
  return value.length>=2&&/[а-яёіїєґ]/i.test(value)?value.toLocaleLowerCase().replace(/[а-яёіїєґ]/g,char=>cyrillic[char]):'';
}
export function rankCatalog(items,query){
  const terms=[query,alternateSpelling(query)].map(normalized).filter(Boolean);
  if(!terms.length)return items;
  const score=item=>Math.max(0,...item.aliases.flatMap(alias=>terms.map(term=>{
    const value=normalized(alias);
    return value===term?1000:value.startsWith(term+' ')?800:value.startsWith(term)?700:value.includes(term)?500:term.split(' ').every(word=>value.includes(word))?300:0;
  })));
  return items.map((item,index)=>({item,index,score:score(item)})).sort((a,b)=>b.score-a.score||a.index-b.index).map(value=>value.item);
}
export const safeImage=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch{return '';}};
const yearOf=value=>value?Number(String(value).slice(0,4))||null:null;
const fuzzyDate=value=>!value?.year?null:[value.year,...(value.month?[String(value.month).padStart(2,'0')]:[]),...(value.month&&value.day?[String(value.day).padStart(2,'0')]:[])].join('-');
const unique=values=>[...new Set(values.filter(Boolean))];
export const genreLabels={Action:'Экшен',Adventure:'Приключения',Comedy:'Комедия',Drama:'Драма',Fantasy:'Фэнтези',Horror:'Ужасы',Mystery:'Детектив',Romance:'Романтика','Sci-Fi':'Фантастика','Science Fiction':'Фантастика','Slice of Life':'Повседневность',Sports:'Спорт',Supernatural:'Сверхъестественное',Suspense:'Триллер',Thriller:'Триллер',Mecha:'Меха',Music:'Музыка',Psychological:'Психология',Historical:'История',School:'Школа'};
export const providers={kitsu:'Kitsu',anilist:'AniList',shikimori:'Shikimori',jikan:'MyAnimeList / Jikan',imdb:'IMDb',tvmaze:'TVmaze',wikidata:'Wikidata'};
const ageOf=value=>/^(R18|rx|r_plus)|18\+|NC-17/i.test(value||'')?18:/^R\b|R - 17|17\+/i.test(value||'')?17:/^PG[-_]13|13\+/i.test(value||'')?13:/^PG\b/i.test(value||'')?12:/^G\b/i.test(value||'')?0:null;
const dates=values=>(values||[]).map(x=>({...x,date:typeof x.date==='number'?new Date(x.date*1000).toISOString():x.date})).filter(x=>x.date&&!Number.isNaN(Date.parse(x.date)));
function record(provider,id,kind,values){
  if(['manga','ranobe'].includes(kind))kind=/novel|раноб[эе]/i.test(values.format||'')?'ranobe':'manga';
  const titles=values.titles||{};
  const title=strip(titles.ru||titles.en||values.title||titles.native||'Без названия');
  return {...values,id:provider+':'+id,provider,providerId:String(id),providers:[provider],kind,title,
    titles,aliases:unique([title,...Object.values(titles),...(values.aliases||[])]),description:strip(values.description),
    cover:safeImage(values.cover),year:values.year||yearOf(values.startDate),format:values.format||'',
    genres:unique(values.genres||[]),tags:unique(values.tags||[]),age:values.age??null,ageLabel:values.ageLabel||'',
    episodes:values.episodes||null,chapters:values.chapters||null,volumes:values.volumes||null,
    status:values.status||'',startDate:values.startDate||null,endDate:values.endDate||null,
    releases:dates(values.releases),ids:values.ids||{},links:values.links||[]};
}
export function normalizeCatalog(provider,data,kind='anime'){
  const list=value=>Array.isArray(value)?value:value?[value]:[];
  if(provider==='kitsu'){
    const included=new Map((data.included||[]).map(item=>[item.type+':'+item.id,item]));
    return list(data.data).map(item=>{
      const a=item.attributes||{},related=key=>(item.relationships?.[key]?.data||[]).map(ref=>included.get(ref.type+':'+ref.id)).filter(Boolean);
      const genres=related('genres').map(x=>x.attributes?.name),categories=related('categories').map(x=>x.attributes?.title);
      const mapping=related('mappings').find(x=>/myanimelist/.test(x.attributes?.externalSite));
      return record(provider,item.id,kind,{titles:{en:a.titles?.en||a.titles?.en_us,ru:a.titles?.ru_ru,native:a.titles?.ja_jp||a.titles?.zh_cn||a.titles?.ko_kr},title:a.canonicalTitle,aliases:[...Object.values(a.titles||{}),...(a.abbreviatedTitles||[])],description:a.synopsis,
        cover:a.posterImage?.large||a.posterImage?.medium,format:a.subtype,year:yearOf(a.startDate),startDate:a.startDate,endDate:a.endDate,
        genres,tags:categories,age:ageOf(a.ageRating),ageLabel:a.ageRatingGuide||a.ageRating,episodes:a.episodeCount,chapters:a.chapterCount,volumes:a.volumeCount,status:a.status,
        ids:mapping?{mal:String(mapping.attributes.externalId)}:{},links:[{provider,url:'https://kitsu.io/'+(item.type==='manga'?'manga':'anime')+'/'+(a.slug||item.id)}]});
    });
  }
  if(provider==='anilist')return list(data.data?.Media||data.data?.Page?.media).map(a=>record(provider,a.id,kind,{
    titles:{en:a.title?.english,native:a.title?.native},title:a.title?.romaji,aliases:[a.title?.romaji,...(a.synonyms||[])],description:a.description,cover:a.coverImage?.large,
    year:a.seasonYear||a.startDate?.year,startDate:fuzzyDate(a.startDate),endDate:fuzzyDate(a.endDate),
    format:a.format,genres:a.genres,tags:(a.tags||[]).map(t=>t.name),age:a.isAdult?18:null,episodes:a.episodes,chapters:a.chapters,volumes:a.volumes,status:a.status,
    releases:[...(a.airingSchedule?.nodes||[]),...(a.nextAiringEpisode?[a.nextAiringEpisode]:[])].map(e=>({episode:e.episode,date:e.airingAt,kind:'original',provider:'anilist'})),
    ids:a.idMal?{mal:String(a.idMal)}:{},links:[{provider,url:a.siteUrl}]}));
  if(provider==='shikimori')return list(data).filter(a=>a?.id!=null&&(a.name||a.russian)).map(a=>record(provider,a.id,kind,{titles:{ru:a.russian,en:a.name,native:a.japanese?.[0]},aliases:[...(a.synonyms||[]),...(a.english||[]),...(a.japanese||[])],description:a.description,
    cover:a.image?.original?'https://shikimori.one'+a.image.original:'',format:a.kind,genres:(a.genres||[]).map(g=>g.russian||g.name),episodes:a.episodes,chapters:a.chapters,volumes:a.volumes,
    status:a.status,startDate:a.aired_on,endDate:a.released_on,age:ageOf(a.rating),ageLabel:a.rating,ids:{mal:String(a.id)},links:[{provider,url:'https://shikimori.one'+a.url}]}));
  if(provider==='jikan')return list(data.data).map(a=>record(provider,a.mal_id,kind,{titles:{en:a.title_english,native:a.title_japanese},title:a.title,aliases:(a.titles||[]).map(t=>t.title),description:a.synopsis,
    cover:a.images?.webp?.large_image_url||a.images?.jpg?.large_image_url,format:a.type,year:a.year,genres:(a.genres||[]).map(g=>g.name),tags:[...(a.themes||[]),...(a.demographics||[])].map(t=>t.name),
    age:ageOf(a.rating),ageLabel:a.rating,episodes:a.episodes,chapters:a.chapters,volumes:a.volumes,status:a.status,startDate:a.aired?.from||a.published?.from,endDate:a.aired?.to||a.published?.to,
    broadcast:a.broadcast?.string,ids:{mal:String(a.mal_id)},links:[{provider,url:a.url}]}));
  if(provider==='tvmaze')return list(data).map(value=>value.show||value).filter(a=>a.id).map(a=>record(provider,a.id,a.genres?.includes('Anime')?'anime':'tv',{
    title:a.name,description:a.summary,cover:a.image?.original||a.image?.medium,format:a.type,genres:a.genres,status:a.status,startDate:a.premiered,endDate:a.ended,
    ids:a.externals?.imdb?{imdb:a.externals.imdb}:{},episodes:a._embedded?.episodes?.length||null,
    releases:(a._embedded?.episodes||[]).filter(e=>e.airstamp).map(e=>({episode:e.number,season:e.season,date:e.airstamp,kind:'original',provider})),links:[{provider,url:a.url}]}));
  if(provider==='imdb'){
    if(data['@type'])return [record(provider,(data.url||'').match(/tt\d+/)?.[0]||'',kind,{title:data.name,description:data.description,cover:typeof data.image==='string'?data.image:data.image?.url,
      format:data['@type'],genres:list(data.genre),age:ageOf(data.contentRating),ageLabel:data.contentRating,startDate:data.datePublished,links:[{provider,url:data.url}]})];
    return (data.d||[]).filter(a=>a.id?.startsWith('tt')&&/movie|film|series|tv/i.test(a.qid||a.q||'')).map(a=>record(provider,a.id,/series/i.test(a.qid||a.q)?'tv':'movie',{title:a.l,cover:a.i?.imageUrl,year:a.y,format:a.q,ids:{imdb:a.id},description:'',links:[{provider,url:'https://www.imdb.com/title/'+a.id+'/'}]}));
  }
  if(provider==='wikidata')return (data.search||[]).filter(a=>/film|фильм|映画|영화|电影|сериал|television/i.test(a.description||'')).map(a=>record(provider,a.id,/сериал|series|television/i.test(a.description||'')?'tv':'movie',{title:a.label,description:a.description,aliases:a.aliases,links:[{provider,url:a.concepturi||'https://www.wikidata.org/wiki/'+a.id}]}));
  return [];
}

export function mergeCatalog(values){
  const result=[];
  for(const item of values){
    const current=result.find(other=>other.kind===item.kind&&(
      Object.keys(item.ids||{}).some(key=>item.ids[key]&&item.ids[key]===other.ids?.[key])||
      ((!item.year||!other.year||item.year===other.year)&&item.aliases.some(alias=>normalized(alias).length>3&&other.aliases.some(x=>normalized(x)===normalized(alias))))));
    if(!current){result.push({...item});continue;}
    current.providers=unique([...current.providers,...item.providers]);current.aliases=unique([...current.aliases,...item.aliases]);
    current.genres=unique([...current.genres,...item.genres]);current.tags=unique([...current.tags,...item.tags]);current.links=[...current.links,...item.links];current.ids={...current.ids,...item.ids};
    current.releases=[...current.releases,...item.releases].filter((e,i,a)=>a.findIndex(x=>x.date===e.date&&x.episode===e.episode)===i);
    if(item.titles.ru){current.titles={...current.titles,...item.titles};current.title=item.titles.ru;current.description=item.description||current.description;}
    for(const key of ['cover','description','year','format','age','ageLabel','episodes','chapters','volumes','status','startDate','endDate'])if(current[key]==null||current[key]==='')current[key]=item[key];
  }
  return result;
}

export function matchesFilters(item,filters){
  if(filters.year&&String(item.year)!==String(filters.year))return false;
  if(filters.genre&&!item.genres.some(g=>normalized(genreLabels[g]||g).includes(normalized(filters.genre))))return false;
  if(filters.format&&normalized(item.format)!==normalized(filters.format))return false;
  if(filters.age==='under18'&&(item.age==null||item.age>=18))return false;
  if(filters.age==='adult'&&(item.age==null||item.age<18))return false;
  return true;
}

export function providerUrl(provider,{query='',kind='anime',page=1,identity,year,server=''}){
  if(server){const url=new URL('metadata/'+provider,server+'/');for(const [key,value]of Object.entries({q:query,kind,page,identity,year}))if(value)url.searchParams.set(key,value);return url.href;}
  const resource=['manga','ranobe'].includes(kind)?'manga':'anime';
  if(provider==='kitsu'){
    const url=new URL('https://kitsu.io/api/edge/'+resource+(identity?'/'+identity:''));url.searchParams.set('include','genres,categories,mappings');
    if(!identity){url.searchParams.set('page[limit]',16);url.searchParams.set('page[offset]',(page-1)*16);if(query)url.searchParams.set('filter[text]',query);else url.searchParams.set('sort','-userCount');if(year&&resource==='anime')url.searchParams.set('filter[seasonYear]',year);}
    return url.href;
  }
  if(provider==='shikimori'){const url=new URL('https://shikimori.one/api/'+(resource==='anime'?'animes':'mangas')+(identity?'/'+identity:''));if(!identity){url.searchParams.set('search',query);url.searchParams.set('limit',16);url.searchParams.set('page',page);url.searchParams.set('order','popularity');if(year)url.searchParams.set('season',year);}return url.href;}
  if(provider==='jikan'){const url=new URL('https://api.jikan.moe/v4/'+resource+(identity?'/'+identity+'/full':''));if(!identity){url.searchParams.set('q',query);url.searchParams.set('limit',16);url.searchParams.set('page',page);}return url.href;}
  if(provider==='tvmaze')return identity?'https://api.tvmaze.com/shows/'+identity+'?embed=episodes':'https://api.tvmaze.com/search/shows?q='+encodeURIComponent(query);
  if(provider==='wikidata')return 'https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&origin=*&language='+(/[А-Яа-яЁё]/.test(query)?'ru':/[ぁ-ヿ]/.test(query)?'ja':/[가-힣]/.test(query)?'ko':/[一-鿿]/.test(query)?'zh':'en')+'&search='+encodeURIComponent(query)+'&limit=20';
  if(provider==='anilist')return 'https://graphql.anilist.co';
  throw Error('Для этого каталога нужно подключить сервер импорта.');
}

const aniFields='id idMal title{romaji english native} synonyms description coverImage{large} format status genres tags{name} isAdult episodes chapters volumes seasonYear startDate{year month day} endDate{year month day} siteUrl nextAiringEpisode{episode airingAt} airingSchedule(perPage:50,notYetAired:true){nodes{episode airingAt}}';
export async function fetchCatalog(provider,options,fetcher=fetch){
  options.signal?.throwIfAborted();
  const url=providerUrl(provider,options),abort=new AbortController(),signal=options.signal;
  const stop=()=>abort.abort();signal?.addEventListener('abort',stop,{once:true});
  const timeout=setTimeout(stop,16000);
  try{
    const init={signal:abort.signal};
    if(provider==='anilist'&&!options.server){init.method='POST';init.headers={'Content-Type':'application/json'};init.body=JSON.stringify(options.identity?{query:`query($id:Int){Media(id:$id){${aniFields}}}`,variables:{id:Number(options.identity)}}:{query:`query($search:String,$type:MediaType,$page:Int){Page(page:$page,perPage:16){media(type:$type,sort:POPULARITY_DESC${options.query?',search:$search':''}){${aniFields}}}}`,variables:{search:options.query||null,type:['manga','ranobe'].includes(options.kind)?'MANGA':'ANIME',page:options.page||1}});}
    const response=await fetcher(url,init);
    if(!response.ok)throw Error(response.status===429?'Слишком частые запросы':'Каталог временно недоступен');
    const data=await response.json();if(data.errors)throw Error('Каталог не ответил на запрос');
    const items=normalizeCatalog(provider,data,options.kind);
    const alternate=!options.identity&&!options.spellingFallback&&['kitsu','anilist','jikan'].includes(provider)&&alternateSpelling(options.query);
    if(!items.length&&alternate){
      clearTimeout(timeout);options.signal?.throwIfAborted();
      return (await fetchCatalog(provider,{...options,query:alternate,spellingFallback:true},fetcher)).map(item=>({...item,searchSpelling:alternate}));
    }
    return items;
  }catch(error){
    signal?.throwIfAborted();
    // Free metadata hosts can be reachable from a browser while rejecting a
    // datacentre IP (or vice versa). IMDb needs the relay because it lacks CORS.
    // This fallback never handles source pages, playlists or media bytes.
    if(options.server&&provider!=='imdb'){
      clearTimeout(timeout);
      return await fetchCatalog(provider,{...options,server:''},fetcher);
    }
    throw error;
  }finally{clearTimeout(timeout);signal?.removeEventListener('abort',stop);}
}
export function catalogProviders(kind,query,server){
  if(['movie','tv'].includes(kind))return [...(server?['imdb']:[]),...(query?['tvmaze','wikidata']:[])];
  return ['kitsu','shikimori','anilist',...(query?['jikan']:[])];
}
