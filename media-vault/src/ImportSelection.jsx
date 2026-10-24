import React,{useEffect,useRef,useState} from 'react';
import Icon from './Icons.jsx';
import {kinds,ReleaseCalendar} from './ImportParts.jsx';

export default function ImportSelection({state,service,item,manual=false,onSubmitted}){
  const [url,setUrl]=useState(''),[collection,setCollection]=useState(item?.title||''),[season,setSeason]=useState('1'),[manualKind,setManualKind]=useState('anime');
  const [found,setFound]=useState([]),[providers,setProviders]=useState([]),[inspection,setInspection]=useState(null),[dub,setDub]=useState('');
  const [mode,setMode]=useState('all'),[one,setOne]=useState(''),[first,setFirst]=useState('1'),[last,setLast]=useState('12'),[list,setList]=useState('');
  const [quality,setQuality]=useState('720'),[busy,setBusy]=useState(''),[error,setError]=useState('');
  const generation=useRef(0),kind=item?.kind||manualKind,ready=!!state.catalog&&state.admin&&service.session?.driveConnected;
  useEffect(()=>{
    let closed=false;setFound([]);setInspection(null);setDub('');setUrl('');setCollection(item?.title||'');
    if(!item||service.status!=='connected')return;
    setBusy('search');setError('');
    service.request('/sources/search?q='+encodeURIComponent(item.title)+'&kind='+item.kind).then(data=>{if(!closed){setFound(data.results||[]);setProviders(data.providers||[]);}}).catch(cause=>{if(!closed)setError(cause.message);}).finally(()=>{if(!closed)setBusy('');});
    return()=>{closed=true;generation.current++;};
  },[item?.id,service.status]);
  async function inspect(value,voice='',selectedSeason=season){
    const version=++generation.current;setUrl(value);setBusy('inspect');setError('');setDub(voice);
    try{
      const data=await service.request('/sources/inspect',{method:'POST',body:{url:value,...(voice?{dub_url:voice}:{}),season:Number(selectedSeason),kind}});
      if(version===generation.current){setInspection(data);if(data.episodes?.length){setOne(String(data.episodes[0].number));setFirst(String(data.episodes[0].number));setLast(String(data.episodes.at(-1).number));}}
    }catch(cause){if(version===generation.current){setInspection(null);setError(cause.message);}}finally{if(version===generation.current)setBusy('');}
  }
  const published=(inspection?.episodes||[]).filter(e=>!e.season||Number(e.season)===Number(season));
  const episodeText=mode==='all'?'all':mode==='single'?one:mode==='range'?first+'-'+last:list;
  async function submit(event){
    event.preventDefault();setError('');
    if(!ready){setError('Открой библиотеку владельца и подключи сервер к Google Drive.');return;}
    if(!url||!collection.trim()){setError('Выбери источник и название тайтла.');return;}
    if(!inspection){setError('Сначала проверь ссылку: нужны опубликованные серии или главы.');return;}
    if(inspection.dubs?.length&&!dub){setError('Выбери озвучку из плеера.');return;}
    if(!published.length){setError('В этом источнике не найдены опубликованные файлы выбранного сезона.');return;}
    if(mode==='range'&&(!Number(first)||Number(last)<Number(first))){setError('Проверь начало и конец диапазона.');return;}
    const metadata=item?Object.fromEntries(['title','titles','aliases','description','cover','year','format','genres','tags','age','ageLabel','episodes','chapters','volumes','status','startDate','endDate','releases','ids','links','kind'].map(key=>[key,item[key]])):{};
    const job={version:2,library_id:state.libraryId,sources:[url],collection:collection.trim(),season:Number(season),episodes:episodeText||'all',quality,resume:true,
      section:kind==='manga'?'manga':kind==='ranobe'?'ranobe':['movie','tv'].includes(kind)?'video':'anime',metadata,
      entries:published.map(entry=>({number:entry.number,url:entry.url,title:entry.title||'',season:Number(entry.season||season)})),
      dub:inspection.dubs?.find(d=>d.url===dub)?.name||'',provider:inspection.provider};
    setBusy('submit');try{await service.submit(job);onSubmitted();}catch(cause){setError(cause.message);}finally{setBusy('');}
  }
  return <form className="import-selection" onSubmit={submit}>
    <div className="section-heading"><h3>В твою коллекцию</h3><span className="source-label"><Icon name="lock" size={12}/> Зашифровано в Drive</span></div>
    {!ready&&<p className="selection-notice">{!state.catalog?'Открой свою библиотеку, чтобы начать импорт.':!service.server?'Для автоматического импорта нужно один раз подключить сервер.':'Разреши серверу фоновый доступ к Google Drive.'}</p>}
    {manual&&<div className="form-field"><label className="input-label" htmlFor="manualKind">Тип произведения</label><select id="manualKind" className="field-input" value={manualKind} onChange={e=>{setManualKind(e.target.value);setInspection(null);}}>{kinds.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></div>}
    {item&&<><label className="input-label">Источники с публичными плеерами</label>{busy==='search'?<div className="source-loading"><span className="loading-ring"/>Ищем доступные страницы…</div>:found.length?<div className="source-results">{found.map(source=><button type="button" key={source.provider+source.url} className={'source-result'+(url===source.url?' selected':'')} onClick={()=>inspect(source.url)}><span><b>{source.providerName}</b><small>{source.title}</small></span><Icon name={url===source.url?'check':'chevron'} size={17}/></button>)}</div>:<p className="fine">{service.status==='connected'?'Подходящую страницу пока не нашли. Можно указать публичную ссылку ниже.':'Поиск доступных серий включится после подключения сервера.'}</p>}{providers.some(s=>s.status!=='ok')&&<details className="provider-diagnostics"><summary>Доступность сайтов</summary>{providers.map(s=><p key={s.provider}><b>{s.name}</b> — {s.status==='ok'?'проверен':s.message||'временно недоступен'}</p>)}</details>}</>}
    <div className="form-field"><label className="input-label" htmlFor="streamUrl">{manual?'Ссылка на сезон, главу или видео':'Своя ссылка на источник'}</label><div className="form-actions"><input id="streamUrl" className="field-input" type="url" value={url} onChange={e=>{setUrl(e.target.value);setInspection(null);}} placeholder="https://…" required/><button type="button" className="btn btn-secondary btn-small" disabled={!url||!!busy||service.status!=='connected'} onClick={()=>inspect(url)}>{busy==='inspect'?'Проверяем…':'Проверить'}</button></div></div>
    {inspection?.dubs?.length>0&&<div className="form-field"><label className="input-label" htmlFor="importDub">Озвучка</label><select id="importDub" className="field-input" value={dub} onChange={e=>inspect(url,e.target.value)}><option value="">Выбрать озвучку</option>{inspection.dubs.map(d=><option key={d.id+d.url} value={d.url}>{d.name}</option>)}</select></div>}
    {inspection&&!inspection.dubs?.length&&['anime','movie','tv'].includes(kind)&&<p className="fine">Источник не указал названия озвучек. Будет использована дорожка доступного плеера.</p>}
    <div className="import-field-grid"><div className="form-field"><label className="input-label" htmlFor="serverCollection">Название в коллекции</label><input id="serverCollection" className="field-input" value={collection} onChange={e=>setCollection(e.target.value)} required placeholder="Название тайтла"/></div><div className="form-field"><label className="input-label" htmlFor="serverSeason">{['manga','ranobe'].includes(kind)?'Том':'Сезон'}</label>{inspection?.seasons?.length?<select id="serverSeason" className="field-input" value={season} onChange={e=>{const selected=inspection.seasons.find(s=>s.number===Number(e.target.value));setSeason(e.target.value);if(selected?.url)inspect(selected.url,'',e.target.value);}}>{inspection.seasons.map(s=><option key={s.number} value={s.number}>{s.name||s.number}</option>)}</select>:<input id="serverSeason" className="field-input" type="number" min="1" max="1000" value={season} onChange={e=>setSeason(e.target.value)} required/>}</div></div>
    <div className="episode-selection" role="group" aria-labelledby="episodeSelectionLabel"><p id="episodeSelectionLabel" className="episode-selection-legend">{kind==='manga'?'Какие главы добавить':'Какие серии добавить'}</p><div className="chip-row">{[['all','Весь сезон'],['single','Одна'],['range','Диапазон'],['list','Свой список']].map(([id,label])=><button type="button" key={id} className={'chip'+(mode===id?' chip-active':'')} onClick={()=>setMode(id)}>{id==='all'&&kind==='manga'?'Все главы':label}</button>)}</div>{mode==='single'&&<select className="field-input" value={one} onChange={e=>setOne(e.target.value)} aria-label="Номер серии">{published.map(e=><option key={e.url} value={e.number}>{e.title||'Серия '+e.number}</option>)}</select>}{mode==='range'&&<div className="import-field-grid"><input className="field-input" type="number" min="1" value={first} onChange={e=>setFirst(e.target.value)} aria-label="Первая серия"/><input className="field-input" type="number" min="1" value={last} onChange={e=>setLast(e.target.value)} aria-label="Последняя серия"/></div>}{mode==='list'&&<input id="serverEpisodes" className="field-input" value={list} onChange={e=>setList(e.target.value)} placeholder="1, 3, 5-8" aria-label="Список серий"/>}<p className="fine">{inspection?`Найдено опубликованных файлов: ${published.length}. `:''}Добавляются только доступные файлы. Завершённые повторно не скачиваются.</p></div>
    {['anime','movie','tv'].includes(kind)&&<><label className="input-label" htmlFor="serverQuality">Качество</label><select id="serverQuality" className="field-input" value={quality} onChange={e=>setQuality(e.target.value)}>{[['best','Лучшее доступное'],['1080','До 1080p'],['720','До 720p'],['480','До 480p'],['360','До 360p']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></>}
    {error&&<p className="inline-error" role="alert">{error}</p>}<button id="importVideoBtn" className="btn btn-primary import-submit" disabled={!ready||!!busy||!inspection} type="submit"><Icon name="cloud" size={18}/>{busy==='submit'?'Отправляем на сервер…':'Импортировать в коллекцию'}<Icon name="arrow" size={17}/></button><p className="fine">После принятия задания сервером вкладку можно закрыть. Результат появится в библиотеке автоматически.</p>
    {inspection&&<details className="source-calendar"><summary>Даты публикаций этого источника</summary><ReleaseCalendar dubReleases={inspection.releases||[]}/></details>}
  </form>;
}
