import {useMemo,useState} from 'react';
import {buildTitles,titleParts,SECTION_LABELS} from './library-model.js';
import Icon from './Icons.jsx';

export default function TitleBrowser({catalog,items,sort,renderFile,renderTitle}){
  const [mode,setMode]=useState(()=>{try{return localStorage.getItem('mediavault_library_view')||'titles';}catch{return 'titles';}});
  const [selected,setSelected]=useState(null);
  const titles=useMemo(()=>buildTitles(catalog,items).sort((a,b)=>sort==='name'?a.name.localeCompare(b.name,'ru'):(new Date(b.addedAt)-new Date(a.addedAt))),[catalog,items,sort]);
  const current=titles.find(title=>title.id===selected);
  function changeMode(value){setMode(value);setSelected(null);try{localStorage.setItem('mediavault_library_view',value);}catch{}}
  return <>
    <div className="title-browser-toolbar"><div className="import-tabs" role="group" aria-label="Вид библиотеки"><button id="showTitlesBtn" data-state={mode==='titles'?'active':'inactive'} aria-pressed={mode==='titles'} onClick={()=>changeMode('titles')}>Тайтлы</button><button id="showFilesBtn" data-state={mode==='files'?'active':'inactive'} aria-pressed={mode==='files'} onClick={()=>changeMode('files')}>Файлы</button></div><span className="fine">{titles.length} тайтлов · {items.length} файлов</span></div>
    {mode==='files'?<div id="libraryGrid" className="media-grid">{items.map(renderFile)}</div>:current?<section className="title-detail">
      <button id="backToTitles" className="text-link" onClick={()=>setSelected(null)}><Icon name="back" size={16}/>Все тайтлы</button>
      <div className="section-heading"><div><p className="eyebrow">{SECTION_LABELS[current.section]}</p><h2 className="section-title">{current.name}</h2><p className="fine">Отдельная папка тайтла · {current.items.length} файлов</p></div></div>
      {current.metadata?.description&&<p className="detail-description">{current.metadata.description}</p>}
      <div className="detail-genres">{(current.metadata?.genres||[]).map(genre=><span key={genre}>{genre}</span>)}{current.metadata?.ageLabel&&<span>{current.metadata.ageLabel}</span>}{current.metadata?.year&&<span>{current.metadata.year}</span>}</div>
      {titleParts(current).map(part=><section className="title-part" key={part.name}><h3 className="section-title">{part.name}</h3><div className="media-grid">{part.items.map(renderFile)}</div></section>)}
    </section>:<div id="libraryGrid" className="media-grid">{titles.map(title=>renderTitle(title,()=>setSelected(title.id)))}</div>}
  </>;
}
