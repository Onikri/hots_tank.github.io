import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import Icon from './Icons.jsx';
import {Poster} from './ImportParts.jsx';

export default function CatalogSearch({query,onQuery,suggestions,loading,showFilters,onToggleFilters,onChoose,onComposing}){
  const input=useRef(null),root=useRef(null),[open,setOpen]=useState(false),[active,setActive]=useState(null);
  const [placement,setPlacement]=useState({above:false,height:430});
  const expanded=open&&!!query.trim(),activeIndex=suggestions.findIndex(item=>item.id===active);
  useLayoutEffect(()=>{
    if(!expanded)return;
    const viewport=window.visualViewport;
    const position=()=>{
      const rect=root.current?.getBoundingClientRect();if(!rect)return;
      const top=Math.max((viewport?.offsetTop||0)+12,(document.querySelector('.app-header')?.getBoundingClientRect().bottom||0)+8);
      const bottom=(viewport?.offsetTop||0)+(viewport?.height||innerHeight)-(document.querySelector('.bottom-nav')?.getBoundingClientRect().height||0)-12;
      const below=bottom-rect.bottom-7,above=rect.top-top-7,flip=below<220&&above>below;
      const height=Math.max(60,Math.min(430,flip?above:below));
      setPlacement(old=>old.above===flip&&old.height===height?old:{above:flip,height});
    };
    position();window.addEventListener('resize',position);window.addEventListener('scroll',position,true);
    viewport?.addEventListener('resize',position);viewport?.addEventListener('scroll',position);
    return()=>{window.removeEventListener('resize',position);window.removeEventListener('scroll',position,true);viewport?.removeEventListener('resize',position);viewport?.removeEventListener('scroll',position);};
  },[expanded]);
  useEffect(()=>{setActive(null);},[query]);
  useEffect(()=>{
    const close=event=>{if(!root.current?.contains(event.target))setOpen(false);};
    document.addEventListener('pointerdown',close);
    return()=>document.removeEventListener('pointerdown',close);
  },[]);
  useEffect(()=>{
    if(expanded&&activeIndex>=0)document.getElementById('prediction-'+activeIndex)?.scrollIntoView({block:'nearest'});
  },[activeIndex,expanded]);
  function choose(item){setOpen(false);setActive(null);onChoose(item);}
  function keyDown(event){
    if(event.nativeEvent.isComposing)return;
    if(event.key==='Escape'){event.preventDefault();setOpen(false);setActive(null);return;}
    if(['ArrowDown','ArrowUp'].includes(event.key)){
      event.preventDefault();setOpen(true);
      const next=event.key==='ArrowDown'?(activeIndex+1)%suggestions.length:(activeIndex<=0?suggestions.length-1:activeIndex-1);
      setActive(suggestions[next]?.id||null);
    }
    if(event.key==='Enter'&&expanded){
      event.preventDefault();
      if(activeIndex>=0)choose(suggestions[activeIndex]);
    }
  }
  return <div className="catalog-search-wrap" ref={root} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget)){setOpen(false);setActive(null);}}}>
    <div className="search-bar catalog-search">
      <Icon name="search" size={21}/>
      <input id="catalogSearch" ref={input} className="search-input" value={query} maxLength={160}
        onChange={event=>{onQuery(event.target.value);setOpen(true);setActive(null);}}
        onCompositionStart={()=>onComposing(true)} onCompositionEnd={event=>{onComposing(false);onQuery(event.currentTarget.value);}}
        onFocus={()=>setOpen(true)} onKeyDown={keyDown} autoComplete="off" spellCheck={false} enterKeyHint="search"
        placeholder="Название на русском, English, 日本語…" aria-label="Глобальный поиск по каталогам"
        role="combobox" aria-autocomplete="list" aria-expanded={expanded}
        aria-controls={expanded?'catalogPredictions':undefined} aria-activedescendant={expanded&&activeIndex>=0?'prediction-'+activeIndex:undefined}/>
      {loading&&<span className="loading-ring" aria-label="Поиск"/>}
      {query&&<button className="icon-button" aria-label="Очистить поиск по каталогам" onClick={()=>{onQuery('');setActive(null);input.current?.focus();}}><Icon name="close" size={17}/></button>}
      <button className={'icon-button filter-toggle'+(showFilters?' is-active':'')} onClick={()=>{setOpen(false);onToggleFilters();}} aria-label="Фильтры каталога" aria-expanded={showFilters}><Icon name="filter" size={19}/></button>
    </div>
    {expanded&&<div id="catalogPredictions" className={'catalog-predictions'+(placement.above?' is-above':'')} style={{maxHeight:placement.height}} role="listbox" aria-label="Подсказки названий" aria-busy={loading}>
      {suggestions.map((item,index)=><button id={'prediction-'+index} key={item.id} tabIndex={-1} className={active===item.id?'prediction-active':''}
        role="option" aria-selected={active===item.id} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(item)}>
        <span className="prediction-cover"><Poster item={item}/></span><span><strong>{item.title}</strong><small>{[item.year,item.titles?.native||item.titles?.en].filter(Boolean).join(' · ')}</small></span><Icon name="chevron" size={16}/>
      </button>)}
      {(!suggestions.length||loading)&&<div className="prediction-message" role="presentation">{loading?'Ищем подходящие названия…':'Совпадений пока нет. Попробуй другое написание.'}</div>}
    </div>}
  </div>;
}
