import {useEffect, useRef, useState} from 'react';

const names={video:'Видео',audio:'Музыка',image:'Изображение',manga:'Манга',book:'Книга'};
async function libraryReady(name,signal){
  for(let attempt=0;attempt<60;attempt++){
    if(signal.aborted)throw new DOMException('Операция отменена','AbortError');
    if(window[name])return window[name];
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('Не удалось загрузить обработчик книги или архива. Проверь подключение к сети.');
}

export default function MediaViewer({item,onClose,readWhole,prepareStream,onError}) {
  const [source,setSource]=useState('');
  const [text,setText]=useState('');
  const [busy,setBusy]=useState(true);
  const [error,setError]=useState('');
  const [page,setPage]=useState(0);
  const [pageCount,setPageCount]=useState(0);
  const [rendition,setRendition]=useState(null);
  const panelRef=useRef(null);
  const mediaRef=useRef(null);
  const epubHost=useRef(null);
  const bookRef=useRef(null);
  const entriesRef=useRef([]);
  const urls=useRef(new Set());
  const generation=useRef(0);
  const pageRequest=useRef(0);
  const pageUrl=useRef('');
  const mediaUrl=useRef('');
  const loadAbort=useRef(null);
  const methods=useRef({readWhole,prepareStream,onError});
  methods.current={readWhole,prepareStream,onError};
  const extension=item.name.toLowerCase().split('.').pop();
  const isMedia=item.category==='video'||item.category==='audio';

  function report(cause){
    const message=cause?.message||String(cause);
    setError(message);setBusy(false);methods.current.onError?.(cause);
  }
  function objectUrl(blob){
    const url=URL.createObjectURL(blob);urls.current.add(url);return url;
  }

  useEffect(()=>{
    const previousOverflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    const onKey=event=>{if(event.key==='Escape')onClose();};
    window.addEventListener('keydown',onKey);
    return ()=>{document.body.style.overflow=previousOverflow;window.removeEventListener('keydown',onKey);};
  },[onClose]);

  useEffect(()=>{
    const current=++generation.current;
    const abort=new AbortController();
    loadAbort.current=abort;
    const activeMedia=mediaRef.current;
    const active=()=>generation.current===current&&!abort.signal.aborted;
    setSource('');setText('');setBusy(true);setError('');
    setPage(0);setPageCount(0);setRendition(null);entriesRef.current=[];
    (async()=>{
      if(isMedia){
        const stream=await methods.current.prepareStream(item);
        if(active()){setSource(stream||'');setBusy(false);}
        return;
      }
      // The signal also lets a reader that supports cancellation stop its download.
      const blob=await methods.current.readWhole(item,{signal:abort.signal});
      if(!active())return;
      if(item.category==='image'||extension==='pdf'){
        setSource(objectUrl(blob));
      }else if(item.category==='manga'){
        const JSZip=await libraryReady('JSZip',abort.signal);
        const zip=await JSZip.loadAsync(blob);
        if(!active())return;
        const entries=Object.values(zip.files).filter(entry=>!entry.dir&&/\.(jpe?g|png|webp|gif|avif)$/i.test(entry.name))
          .sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
        if(!entries.length)throw Error('В архиве нет изображений.');
        entriesRef.current=entries;setPageCount(entries.length);
      }else if(extension==='txt'){
        const content=await blob.text();if(active())setText(content);
      }else if(extension==='epub'){
        const ePub=await libraryReady('ePub',abort.signal);
        const data=await blob.arrayBuffer();if(!active())return;
        const book=ePub(data);bookRef.current=book;
        const view=book.renderTo(epubHost.current,{width:'100%',height:'100%',flow:'paginated',allowScriptedContent:false});
        await view.display();if(active())setRendition(view);
      }else throw Error('Для книг поддерживаются PDF, EPUB и TXT.');
      if(active())setBusy(false);
    })().catch(cause=>{if(active()&&cause?.name!=='AbortError')report(cause);});
    return ()=>{
      abort.abort();generation.current++;pageRequest.current++;
      const media=activeMedia;
      if(media){media.pause();media.removeAttribute('src');media.load();}
      if(bookRef.current){
        // EPUB.js 0.3.93 revokes archive cache keys rather than their Blob URLs.
        for(const url of Object.values(bookRef.current.archive?.urlCache||{})){
          if(typeof url==='string'&&url.startsWith('blob:'))URL.revokeObjectURL(url);
        }
        try{bookRef.current.destroy();}catch{}bookRef.current=null;
      }
      for(const url of urls.current)URL.revokeObjectURL(url);
      urls.current.clear();pageUrl.current='';mediaUrl.current='';entriesRef.current=[];
    };
  },[item.id]);

  useEffect(()=>{
    if(!pageCount)return;
    const request=++pageRequest.current;
    const current=generation.current;
    setBusy(true);
    entriesRef.current[page].async('blob').then(blob=>{
      if(request!==pageRequest.current||current!==generation.current)return;
      const next=objectUrl(blob);
      if(pageUrl.current){URL.revokeObjectURL(pageUrl.current);urls.current.delete(pageUrl.current);}
      pageUrl.current=next;setSource(next);setBusy(false);
    }).catch(cause=>{if(request===pageRequest.current&&current===generation.current)report(cause);});
  },[page,pageCount]);

  async function fallback(){
    const current=generation.current;
    setBusy(true);setError('');
    try{
      const blob=await methods.current.readWhole(item,{signal:loadAbort.current?.signal});
      if(current!==generation.current)return;
      const media=mediaRef.current;if(media)media.pause();
      const next=objectUrl(blob);
      if(mediaUrl.current){URL.revokeObjectURL(mediaUrl.current);urls.current.delete(mediaUrl.current);}
      mediaUrl.current=next;setSource(next);setBusy(false);
    }catch(cause){if(current===generation.current)report(cause);}
  }
  async function fullscreen(){
    try{
      const media=mediaRef.current;
      if(media?.webkitEnterFullscreen)media.webkitEnterFullscreen();
      else await (media?.requestFullscreen?media:panelRef.current)?.requestFullscreen?.();
    }catch(cause){methods.current.onError?.(cause);}
  }

  return <section id="viewer" ref={panelRef} className="mv-viewer" role="dialog" aria-modal="true" aria-label={item.name}>
    <header className="mv-viewer-head">
      <button id="closeViewer" className="mv-icon-button" aria-label="Закрыть просмотр" onClick={onClose}>←</button>
      <div className="mv-viewer-title"><small>{names[item.category]||'Файл'}</small><strong>{item.name}</strong></div>
      {item.category==='video'&&<button className="mv-icon-button" aria-label="На весь экран" onClick={fullscreen}>⛶</button>}
    </header>
    <div id="viewerContent" className={'mv-viewer-body'+(item.category==='manga'?' mv-viewer-manga':'')}>
      {busy&&<div className="mv-viewer-loading" role="status">Расшифровка на устройстве…</div>}
      {error&&<div className="mv-viewer-error" role="alert">{error}</div>}
      {isMedia&&(item.category==='video'
        ?<video ref={mediaRef} src={source||undefined} controls playsInline preload="metadata" onError={()=>source&&report(Error('Браузер не смог воспроизвести файл. Попробуй загрузить его целиком.'))}/>
        :<audio ref={mediaRef} src={source||undefined} controls preload="metadata" onError={()=>source&&report(Error('Браузер не смог воспроизвести аудио. Попробуй загрузить файл целиком.'))}/>)}
      {isMedia&&!source&&!busy&&!error&&<p>Потоковое воспроизведение недоступно. Загрузи файл целиком.</p>}
      {(item.category==='image'||item.category==='manga')&&source&&<img src={source} alt={item.category==='manga'?'Страница '+(page+1):item.name}/>}
      {item.category==='book'&&extension==='pdf'&&source&&<iframe src={source} title={item.name}/>}
      {item.category==='book'&&extension==='txt'&&!busy&&<pre>{text}</pre>}
      {item.category==='book'&&extension==='epub'&&<div className="mv-epub-host" ref={epubHost}/>}
    </div>
    <footer className="mv-viewer-tools">
      {isMedia&&<button className="mv-button mv-button-secondary" disabled={busy} onClick={fallback}>Загрузить файл целиком (резервный режим)</button>}
      {item.category==='manga'&&pageCount>0&&<>
        <button className="mv-button mv-button-secondary" disabled={page===0||busy} onClick={()=>setPage(value=>Math.max(0,value-1))}>← Назад</button>
        <span aria-live="polite">{page+1} / {pageCount}</span>
        <button className="mv-button mv-button-secondary" disabled={page===pageCount-1||busy} onClick={()=>setPage(value=>Math.min(pageCount-1,value+1))}>Вперёд →</button>
      </>}
      {rendition&&<>
        <button className="mv-button mv-button-secondary" onClick={()=>rendition.prev().catch(report)}>← Назад</button>
        <button className="mv-button mv-button-secondary" onClick={()=>rendition.next().catch(report)}>Вперёд →</button>
      </>}
    </footer>
  </section>;
}
