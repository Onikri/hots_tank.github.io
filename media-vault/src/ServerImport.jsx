import React,{useMemo,useState} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import {motion,useReducedMotion} from 'motion/react';
import Icon from './Icons.jsx';
import {buildServerJob,NOTEBOOK_URL} from './server-job.js';

export default function ServerImport({state,onConnect,onRefresh}){
  const [mode,setMode]=useState('single');
  const [urls,setUrls]=useState('');
  const [collection,setCollection]=useState('');
  const [episodes,setEpisodes]=useState('all');
  const [quality,setQuality]=useState('720');
  const [job,setJob]=useState(null),[open,setOpen]=useState(false);
  const [error,setError]=useState(''),[copied,setCopied]=useState(false);
  const reduced=useReducedMotion();
  const ready=!!state.catalog&&state.admin;
  const jobJson=useMemo(()=>job?JSON.stringify(job,null,2):'',[job]);
  function prepare(event){
    event.preventDefault();setError('');setCopied(false);
    if(!ready){setError('Открой библиотеку владельца перед импортом.');return;}
    try{setJob(buildServerJob({libraryId:state.libraryId,urls,collection,episodes,quality}));setOpen(true);}
    catch(cause){setError(cause.message);}
  }
  async function copy(){
    try{await navigator.clipboard.writeText(JSON.stringify(job));setCopied(true);}
    catch{setError('Автокопирование недоступно. Скопируй текст задания из поля ниже.');}
  }
  return <>
    <div className="page-title-row"><div><p className="eyebrow">Твоя следующая история</p><h1 className="page-title">Добавить аниме</h1><p className="page-subtitle">Серверный импорт в Google Drive</p></div><span className="import-cloud-icon"><Icon name="cloud" size={28}/></span></div>
    <motion.section className="server-intro" initial={reduced?false:{opacity:0,y:8}} animate={{opacity:1,y:0}}>
      <span className="server-tag"><i/> БЕЗ ВИДЕОТРАФИКА НА УСТРОЙСТВЕ</span>
      <h2>Пока ты выбираешь,<br/><em>сервер собирает коллекцию.</em></h2>
      <p>Скачивание, сборка видео и шифрование выполняются в бесплатной сессии Google Colab. В Drive попадают зашифрованные файлы.</p>
      <div className="server-route"><span><Icon name="video" size={17}/> Источник</span><Icon name="arrow" size={15}/><span><Icon name="cloud" size={17}/> Colab</span><Icon name="arrow" size={15}/><span><Icon name="lock" size={17}/> Твой Drive</span></div>
    </motion.section>
    {!ready&&<div className="notice-card"><Icon name="lock" size={23}/><div><h3 className="notice-title">Сначала открой свою библиотеку</h3><p>Импорт доступен владельцу. Фраза библиотеки понадобится только в серверной сессии.</p><button className="text-link" onClick={onConnect}>Подключить библиотеку<Icon name="arrow" size={15}/></button></div></div>}
    <form className="settings-card server-form" onSubmit={prepare}>
      <Tabs.Root value={mode} onValueChange={value=>{setMode(value);setUrls('');}}>
        <Tabs.List className="import-tabs" aria-label="Источники импорта"><Tabs.Trigger value="single">Одна ссылка</Tabs.Trigger><Tabs.Trigger value="list">Список серий</Tabs.Trigger></Tabs.List>
        <div className="form-field"><label className="input-label" htmlFor="streamUrl">{mode==='single'?'Ссылка на сезон, серию или видео':'Ссылки — по одной на строку'}</label>
          {mode==='single'?<input id="streamUrl" className="field-input" type="url" value={urls} onChange={event=>setUrls(event.target.value)} placeholder="https://…" required autoComplete="off"/>:<textarea id="streamUrl" className="field-input source-list" value={urls} onChange={event=>setUrls(event.target.value)} placeholder={'https://…/episode-1\nhttps://…/episode-2'} required autoComplete="off"/>}
          <p className="fine">Парсер прочитает публичную страницу и доступный плеер. Прямые MP4 и HLS-ссылки тоже поддерживаются.</p>
        </div>
      </Tabs.Root>
      <div className="form-field"><label className="input-label" htmlFor="serverCollection">Коллекция / название аниме</label><input id="serverCollection" className="field-input" value={collection} onChange={event=>setCollection(event.target.value)} placeholder="Например, Моя коллекция · сезон 1" autoComplete="off"/></div>
      <div className="import-field-grid"><div className="form-field"><label className="input-label" htmlFor="serverEpisodes">Серии</label><input id="serverEpisodes" className="field-input" value={episodes} onChange={event=>setEpisodes(event.target.value)} placeholder="all или 1-12" autoComplete="off"/></div><div className="form-field"><label className="input-label" htmlFor="serverQuality">Предпочитаемое качество</label><select id="serverQuality" className="field-input" value={quality} onChange={event=>setQuality(event.target.value)}><option value="best">Лучшее доступное</option><option value="1080">До 1080p</option><option value="720">До 720p</option><option value="480">До 480p</option><option value="360">До 360p</option></select></div></div>
      <p className="fine">Качество и серии выбираются из того, что действительно найдено на странице.</p>
      {error&&<p className="inline-error" role="alert">{error}</p>}
      <button id="importVideoBtn" className="btn btn-primary" disabled={!ready} type="submit"><Icon name="cloud" size={18}/>Подготовить серверный импорт<Icon name="arrow" size={17}/></button>
    </form>
    <div className="benefit-grid import-benefits"><div className="benefit-card"><span><Icon name="lock" size={21}/></span><div><h3>Шифрование до сохранения</h3><p>В Drive — категории, коллекции и зашифрованные блоки. Названия хранятся в закрытом каталоге.</p></div></div><div className="benefit-card"><span><Icon name="history" size={21}/></span><div><h3>Можно продолжить позже</h3><p>Бесплатные сессии Colab ограничены по времени. Повторный запуск пропускает уже сохранённые эпизоды.</p></div></div></div>
    <section className="settings-card"><h2 className="section-title">После импорта</h2><p className="page-subtitle">Когда Colab закончит, обнови каталог. Видео останется в Drive, и ты сможешь смотреть его здесь.</p><button id="refreshAfterImport" className="btn btn-secondary" disabled={!state.catalog||!!state.busy} onClick={onRefresh}><Icon name="refresh" size={17}/>Обновить библиотеку</button><p className="fine">Пока сервер записывает каталог, дождись завершения импорта перед изменениями библиотеки.</p></section>
    <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="server-dialog"><Dialog.Close className="icon-button dialog-close" aria-label="Закрыть"><Icon name="close" size={20}/></Dialog.Close><span className="dialog-mark"><Icon name="cloud" size={28}/></span><Dialog.Title>Готово к серверной загрузке</Dialog.Title><Dialog.Description>Скопируй задание, открой Colab и запусти блокнот. Войди в свой Google-аккаунт и введи фразу библиотеки в приватном поле блокнота.</Dialog.Description><ol className="import-steps"><li><b>1</b><span>Скопируй задание — оно содержит ссылки и ID каталога.</span></li><li><b>2</b><span>В Colab выбери «Выполнить всё», затем вставь задание.</span></li><li><b>3</b><span>Дождись результата и обнови библиотеку на сайте.</span></li></ol><label className="input-label" htmlFor="serverJob">Задание для Colab</label><textarea id="serverJob" className="field-input job-payload" readOnly value={jobJson}/><p className="fine">Токен Google, ключ и секретная фраза в задание не включаются.</p><div className="dialog-actions"><button id="copyServerJob" className="btn btn-secondary" onClick={copy}><Icon name={copied?'check':'copy'} size={17}/>{copied?'Задание скопировано':'Скопировать задание'}</button><a id="openColab" className="btn btn-primary" href={NOTEBOOK_URL} target="_blank" rel="noopener noreferrer">Открыть Google Colab<Icon name="arrow" size={17}/></a></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
