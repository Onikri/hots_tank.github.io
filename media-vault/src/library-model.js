// Reading format (category) and library section are separate: an EPUB may be
// either a book or a light novel, and a title can also contain its cover image.
export const SECTION_LABELS={anime:'Аниме',manga:'Манга',ranobe:'Ранобэ',book:'Книги',music:'Музыка',video:'Видео',image:'Фото'};
export const SECTION_FORMAT={anime:'video',manga:'manga',ranobe:'book',book:'book',music:'audio',video:'video',image:'image'};
const DEFAULT_SECTION={video:'video',audio:'music',manga:'manga',book:'book',image:'image'};
const ALIASES={anime:'anime','аниме':'anime',manga:'manga','манга':'manga',ranobe:'ranobe','ранобэ':'ranobe','ранобе':'ranobe',books:'book','книги':'book',music:'music','музыка':'music',video:'video','видео':'video',images:'image','фото':'image'};
export const normalizedName=value=>String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ');
export const sameName=(a,b)=>normalizedName(a).toLocaleLowerCase('ru')===normalizedName(b).toLocaleLowerCase('ru');
export const sectionForItem=item=>SECTION_LABELS[item.section]?item.section:
  item.category==='video'&&item.importFingerprint?'anime':DEFAULT_SECTION[item.category]||'book';
export function sectionForCollection(collection,catalog){
  if(SECTION_LABELS[collection.section])return collection.section;
  const member=catalog.items?.find(item=>item.collectionId===collection.id);
  return sectionForItem(member||collection);
}
export function uploadPlacement({name,category,sourcePath='',section,collection,part=''}){
  const parents=sourcePath.split(/[\\/]/).filter(Boolean).slice(0,-1);
  const marker=parents.findIndex((value,index)=>index<2&&ALIASES[value.toLocaleLowerCase('ru')]);
  const inferred=marker>=0?ALIASES[parents[marker].toLocaleLowerCase('ru')]:undefined;
  const path=marker>=0?parents.slice(marker+1):parents;
  const selected=section&&section!=='auto'?section:inferred||DEFAULT_SECTION[category];
  if(!SECTION_LABELS[selected])throw Error('Выбери раздел библиотеки.');
  if(category!==SECTION_FORMAT[selected]&&category!=='image')throw Error(`Этот файл не подходит для раздела «${SECTION_LABELS[selected]}».`);
  const explicit=typeof collection==='string'?collection:collection?.name||collection?.title;
  const title=normalizedName(explicit)||normalizedName(path[0])||normalizedName(name.replace(/\.[^.]+$/,''));
  const partName=normalizedName(part)||normalizedName(path.slice(1).join(' / '));
  if(!title||title.length>500||partName.length>500)throw Error('Проверь название тайтла и сезона/тома.');
  return {section:selected,collectionName:title,partName};
}
export function buildTitles(catalog,items=catalog?.items||[]){
  const collections=new Map((catalog?.storage?.collections||[]).map(group=>[group.id,group]));
  const result=new Map();
  for(const item of items){
    const group=collections.get(item.collectionId),section=sectionForItem(item);
    const id=group?.id||'file-'+item.id,key=section+':'+id;
    if(!result.has(key))result.set(key,{id:key,name:group?.name||item.name.replace(/\.[^.]+$/,''),
      section,category:SECTION_FORMAT[section],items:[],parts:group?.parts||[],size:0,addedAt:item.addedAt});
    const title=result.get(key);title.items.push(item);title.size+=item.size||0;
    if(new Date(item.addedAt)>new Date(title.addedAt))title.addedAt=item.addedAt;
  }
  return [...result.values()];
}
export function titleParts(title){
  const names=new Map(title.parts.map(part=>[part.id,part.name]));
  const parts=new Map();
  for(const item of title.items){
    const name=names.get(item.partId)||item.partName||(item.season?'Сезон '+item.season:'Материалы');
    if(!parts.has(name))parts.set(name,[]);
    parts.get(name).push(item);
  }
  return [...parts].map(([name,items])=>({name,items:items.slice().sort((a,b)=>(a.episode??Infinity)-(b.episode??Infinity)||a.name.localeCompare(b.name,'ru',{numeric:true}))})).sort((a,b)=>a.name.localeCompare(b.name,'ru',{numeric:true}));
}
