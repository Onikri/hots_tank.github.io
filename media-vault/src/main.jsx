import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {motion, AnimatePresence, useReducedMotion} from 'motion/react';
import {Separator} from '@radix-ui/react-separator';
import {
  Menu, Search, LayoutGrid, Clapperboard, BookOpen, BookText, Music2, Images,
  House, UserRound, Plus, ChevronRight, X, LockKeyhole, ShieldCheck,
  Cloud, ArrowUpRight, SlidersHorizontal, Check, LogIn, LogOut, FolderOpen,
  UploadCloud, Copy, Rows3
} from 'lucide-react';
import './ui.css';

const categories=[
  {id:'all',label:'Всё',full:'Все материалы',Icon:LayoutGrid},
  {id:'video',label:'Видео',full:'Видео и аниме',Icon:Clapperboard},
  {id:'manga',label:'Манга',full:'Манга и комиксы',Icon:BookOpen},
  {id:'book',label:'Книги',full:'Ранобэ и книги',Icon:BookText},
  {id:'audio',label:'Музыка',full:'Музыка',Icon:Music2},
  {id:'image',label:'Фото',full:'Изображения',Icon:Images}
];

const defaultCounts={all:0,video:0,manga:0,book:0,audio:0,image:0};
function IconButton({Icon,label,onClick,active=false,children,className=''}){
  return <motion.button whileTap={{scale:.91}} type="button" aria-label={label} aria-pressed={active} onClick={onClick}
     className={'icon-action '+className+(active?' is-active':'')}><Icon size={21} strokeWidth={1.9}/>{children}</motion.button>;
}
function Brand({onClick}){
  return <a href="./" className="brand-wordmark" aria-label="MediaVault — главная" onClick={onClick}>
    <span className="brand-symbol">M<span>V</span><i/></span><span className="brand-label">MEDIA<span>VAULT</span></span>
  </a>;
}
function CategoryTabs({current,counts,choose}){
  return <nav className="category-tabs" aria-label="Категории библиотеки">
    {categories.map(({id,label,Icon})=><motion.button type="button" whileTap={{scale:.96}} key={id} data-category={id}
      className={'category-tab'+(current===id?' selected':'')} aria-current={current===id?'true':undefined}
      onClick={()=>choose(id)}><Icon size={16}/><span>{label}</span>{current===id&&<motion.i layoutId="category-indicator" className="tab-indicator"/>}</motion.button>)}
  </nav>;
}
function App(){
  const reduceMotion=useReducedMotion();
  const [category,setCategory]=useState('all');
  const [counts,setCounts]=useState(defaultCounts);
  const [menu,setMenu]=useState(false);
  const [account,setAccount]=useState(false);
  const [filterOpen,setFilterOpen]=useState(false);
  const [active,setActive]=useState('home');
  const [view,setView]=useState('grid');
  const [bootError,setBootError]=useState('');
  const [status,setStatus]=useState('Не подключено');
  const [sort,setSort]=useState('newest');
  const [query,setQuery]=useState('');
  const [hasCatalog,setHasCatalog]=useState(false);
  const [signedIn,setSignedIn]=useState(false);
  const [driveConnected,setDriveConnected]=useState(false);
  const [isAdmin,setIsAdmin]=useState(false);
  const closeOverlays=()=>{setMenu(false);setAccount(false);setFilterOpen(false);};

  useEffect(()=>{
    const onUpdate=event=>{
      const d=event.detail||{};
      if(d.counts) setCounts(d.counts);
      if(d.category) setCategory(d.category);
      if(typeof d.unlocked==='boolean')setHasCatalog(d.unlocked);
      if(typeof d.admin==='boolean')setIsAdmin(d.admin);
    };
    document.addEventListener('mediavault:library-updated',onUpdate);
    const onAuth=event=>{const d=event.detail||{};setSignedIn(!!d.signedIn);setDriveConnected(!!d.driveConnected);setHasCatalog(!!d.unlocked);setIsAdmin(!!d.admin);};
    document.addEventListener('mediavault:auth-state',onAuth);
    import('../app.js').catch(error=>{
      console.error('MediaVault initialization error',error);
      setBootError('Не удалось запустить библиотеку. Проверь подключение и перезагрузи страницу.');
    });
    const statusElement=document.getElementById('status');
    const observer=new MutationObserver(()=>setStatus(statusElement.textContent||''));
    if(statusElement)observer.observe(statusElement,{childList:true,subtree:true,characterData:true});
    return ()=>{document.removeEventListener('mediavault:library-updated',onUpdate);document.removeEventListener('mediavault:auth-state',onAuth);observer.disconnect();};
  },[]);
  useEffect(()=>{const fn=e=>{if(e.key==='Escape')closeOverlays();};window.addEventListener('keydown',fn);return()=>window.removeEventListener('keydown',fn);},[]);
  useEffect(()=>{document.getElementById('libraryGrid')?.classList.toggle('as-list',view==='list');},[view]);

  function goTo(id){
    closeOverlays();setActive(id);
    const anchor=id==='home'?'homeSection':'librarySection';
    document.getElementById(anchor)?.scrollIntoView({behavior:reduceMotion?'instant':'smooth',block:'start'});
  }
  function chooseCategory(id){
    setCategory(id);setActive('catalog');closeOverlays();
    document.dispatchEvent(new CustomEvent('mediavault:choose-category',{detail:{category:id}}));
    document.getElementById('librarySection')?.scrollIntoView({behavior:reduceMotion?'instant':'smooth',block:'start'});
  }
  function addMedia(){
    closeOverlays();
    const el=document.getElementById('uploadBtn');
    if(el && !el.classList.contains('hidden'))document.getElementById('filesInput')?.click();
    else document.getElementById('primaryBtn')?.click();
  }
  const appearanceMotion=reduceMotion?{initial:false,animate:{opacity:1},exit:{opacity:0}}:{initial:{opacity:0,y:10},animate:{opacity:1,y:0},exit:{opacity:0,y:8},transition:{duration:.19}};
  return <>
    <div className="site-layout">
      <aside className="desktop-rail" aria-label="Боковая навигация">
        <Brand/>
        <p className="rail-title">НАВИГАЦИЯ</p>
        <button className={'rail-item'+(active==='home'?' current':'')} onClick={()=>goTo('home')}><House size={19}/><span>Главная</span></button>
        <button className={'rail-item'+(active==='catalog'?' current':'')} onClick={()=>goTo('catalog')}><LayoutGrid size={19}/><span>Моя коллекция</span><span className="rail-count">{counts.all}</span></button>
        <p className="rail-title rail-categories">МЕДИАТЕКА</p>
        <nav id="nav" aria-label="Разделы">
          {categories.filter(x=>x.id!=='all').map(({id,full,Icon})=><button className={'rail-item'+(category===id?' current':'')} data-category={id} key={id} onClick={()=>chooseCategory(id)}><Icon size={19}/><span>{full}</span></button>)}
        </nav>
        <div className="rail-bottom"><div className="secure-indicator"><ShieldCheck size={17}/><span>Приватное хранилище</span></div><p>Файлы зашифрованы на устройстве, хранятся в Google Drive.</p></div>
      </aside>
      <div className="app-column">
        <header className="app-header">
          <div className="mobile-only-header"><Brand/></div>
          <div className="desktop-header-copy"><span className="eyebrow">ТВОЁ ПРОСТРАНСТВО</span><strong>Медиатека</strong></div>
          <div className="header-actions">
            <span id="status" className="connection-status" aria-live="polite">Не подключено</span>
            <IconButton Icon={Search} label="Перейти к поиску" onClick={()=>{goTo('catalog');document.getElementById('searchInput')?.focus();}}/>
            <IconButton Icon={UserRound} label="Аккаунт" active={account} onClick={()=>{setAccount(v=>!v);setMenu(false);setFilterOpen(false);}}/>
            <IconButton Icon={Menu} label="Меню" className="mobile-menu-icon" active={menu} onClick={()=>{setMenu(v=>!v);setAccount(false);setFilterOpen(false);}}/>
          </div>
        </header>
        <main className="main-content">
          <section id="homeSection" className="home-section">
            <div className="section-intro"><span className="eyebrow">MEDIA<span className="orange-text">VAULT</span> / LIBRARY</span><h1>Твоя коллекция<span className="period">.</span></h1><p>Всё, что хочется пересматривать и перечитывать.</p></div>
            <div className="welcome-strip">
              <div className="welcome-mark"><BookOpen size={28} strokeWidth={1.6}/><div className="welcome-mark-spark">✳</div></div>
              <div className="welcome-text"><span>ЛИЧНОЕ ХРАНИЛИЩЕ</span><strong>{hasCatalog?'Библиотека открыта':'Твои файлы. Твои правила.'}</strong><p>Аниме, манга, книги, музыка и фото — в одном защищённом месте.</p></div>
              <button className="welcome-link" type="button" onClick={addMedia} aria-label={hasCatalog?'Добавить файлы':'Подключить библиотеку'}><ArrowUpRight size={21}/></button>
            </div>
            <div className="small-overview">
              <div className="stat"><span className="stat-icon sky"><FolderOpen size={17}/></span><div><strong>{counts.all}</strong><span>материалов</span></div></div>
              <div className="stat"><span className="stat-icon lime"><LockKeyhole size={17}/></span><div><strong>AES-256</strong><span>шифрование</span></div></div>
              <div className="stat"><span className="stat-icon orange"><Cloud size={17}/></span><div><strong>Drive</strong><span>хранилище</span></div></div>
            </div>
          </section>
          {bootError&&<div className="error-banner" role="alert">{bootError}</div>}
          <section id="notice" className="auth-notice" aria-live="polite"><div className="notice-icon"><LockKeyhole size={22}/></div><div><strong>Библиотека закрыта</strong><p>Войди через Google, подключи Drive и введи секретную фразу.</p><a target="_blank" rel="noreferrer" href="https://github.com/Onikri/hots_tank.github.io/blob/main/media-vault/README.md">Как настроить доступ <ArrowUpRight size={13}/></a></div><button className="notice-action" type="button" onClick={()=>setAccount(true)}>Войти <ChevronRight size={15}/></button></section>
          <section id="setupPanel" className="setup-panel hidden">
            <div className="panel-heading"><LockKeyhole size={20}/><h2>Открыть библиотеку</h2></div>
            <p className="panel-subtitle">Сначала подключи аккаунт и Drive, затем открой существующий каталог.</p>
            <div className="input-field"><label htmlFor="libraryId">ID зашифрованного каталога</label><input id="libraryId" autoComplete="off" placeholder="Из ссылки-приглашения"/></div>
            <div className="input-field"><label htmlFor="passphrase">Секретная фраза</label><input id="passphrase" type="password" autoComplete="off" placeholder="Введи секретную фразу"/></div>
            <div className="input-field hidden" id="createRow"><label htmlFor="passphraseAgain">Повтори фразу</label><input id="passphraseAgain" type="password" autoComplete="off" placeholder="Повтори секретную фразу"/></div>
            <div className="form-actions"><button className="solid-button" id="unlockBtn" type="button"><LockKeyhole size={17}/> Открыть библиотеку</button><button id="createBtn" type="button" className="quiet-button hidden"><Plus size={17}/> Создать новую</button></div>
            <p className="important-note"><ShieldCheck size={15}/> Для существующей коллекции не создавай новую библиотеку. Восстановить утраченную фразу нельзя.</p>
          </section>
          <section id="adminPanel" className="admin-panel hidden">
            <div className="section-row"><div><span className="eyebrow">УПРАВЛЕНИЕ</span><h2>Для владельца</h2></div><span className="role-chip">АДМИНИСТРАТОР</span></div>
            <div className="admin-cards">
              <div className="admin-card"><UploadCloud size={25}/><h3>Добавить файлы</h3><p>Видео, комиксы, музыка и книги шифруются перед загрузкой.</p><input type="file" id="filesInput" multiple hidden/><button className="quiet-button" id="selectFilesBtn" type="button">Выбрать файлы <ArrowUpRight size={16}/></button><div id="uploadQueue"/></div>
              <div className="admin-card"><UserRound size={25}/><h3>Пригласить зрителя</h3><p>Доступ к папке Drive только на чтение.</p><div className="invite-row"><input id="inviteEmail" type="email" placeholder="email@gmail.com"/><button className="quiet-button" id="inviteBtn" type="button">Пригласить</button></div><button className="text-button" id="copyLinkBtn" type="button"><Copy size={15}/> Ссылка-приглашение</button></div>
            </div>
          </section>
          <section id="librarySection" className="catalog-section">
            <div className="section-row catalogue-title"><div><span className="eyebrow">КАТАЛОГ</span><h2>Моя библиотека <span className="title-count">{counts.all}</span></h2></div><button className="add-small" type="button" onClick={addMedia}><Plus size={18}/> Добавить</button></div>
            <div className="search-controls"><label className="search-field" htmlFor="searchInput"><Search size={21}/><input type="search" id="searchInput" placeholder="Поиск по названию" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button aria-label="Очистить поиск" type="button" onClick={()=>{setQuery('');document.getElementById('searchInput')?.dispatchEvent(new Event('input',{bubbles:true}));}}><X size={16}/></button>}</label>
              <motion.button whileTap={{scale:.93}} type="button" className={'filter-button'+(filterOpen?' opened':'')} aria-label="Фильтры и сортировка" onClick={()=>setFilterOpen(!filterOpen)}><SlidersHorizontal size={20}/></motion.button></div>
            <CategoryTabs current={category} counts={counts} choose={chooseCategory}/>
            <div className="result-heading"><div><strong id="sectionTitle">Все материалы</strong><span id="count">0 файлов</span></div><div className="result-view-buttons"><button className={view==='grid'?'active':''} title="Плитка" aria-label="Плитка" onClick={()=>setView('grid')}><LayoutGrid size={18}/></button><button className={view==='list'?'active':''} title="Список" aria-label="Список" onClick={()=>setView('list')}><Rows3 size={18}/></button></div></div>
            <div id="libraryGrid" className="library-grid"/>
          </section>
        </main>
      </div>
    </div>
    <nav className="bottom-nav" aria-label="Навигация">
      {[{id:'home',Icon:House,label:'Главная'},{id:'catalog',Icon:LayoutGrid,label:'Каталог'}].map(({id,Icon,label})=><button key={id} className={'bottom-item'+(active===id?' active':'')} onClick={()=>goTo(id)}><motion.span whileTap={{scale:.8}}><Icon size={22} strokeWidth={active===id?2.3:1.8}/></motion.span><small>{label}</small></button>)}
      <button className="bottom-item bottom-add" type="button" onClick={addMedia}><motion.span whileTap={{scale:.82,rotate:90}} className="bottom-add-icon"><Plus size={25}/></motion.span><small>Добавить</small></button>
      <button className={'bottom-item'+(account?' active':'')} type="button" onClick={()=>{setAccount(!account);setMenu(false);setFilterOpen(false);}}><motion.span whileTap={{scale:.8}}><UserRound size={22}/></motion.span><small>Аккаунт</small></button>
      <button id="mobileMenu" className={'bottom-item'+(menu?' active':'')} type="button" onClick={()=>{setMenu(!menu);setAccount(false);setFilterOpen(false);}}><motion.span whileTap={{scale:.8}}><Menu size={22}/></motion.span><small>Меню</small></button>
    </nav>
    <AnimatePresence>
      {(menu||account||filterOpen)&&<motion.div key="scrim" className="overlay-scrim" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onClick={closeOverlays}/>}
      {menu&&<motion.aside {...appearanceMotion} key="menu" className="app-drawer" role="dialog" aria-modal="true" aria-label="Меню категорий"><div className="drawer-top"><Brand/><IconButton Icon={X} label="Закрыть меню" onClick={closeOverlays}/></div><p className="drawer-caption">МОЯ МЕДИАТЕКА</p><button className="drawer-link" onClick={()=>goTo('home')}><House size={19}/> Главная <ChevronRight size={16}/></button><button className="drawer-link" onClick={()=>goTo('catalog')}><LayoutGrid size={19}/> Библиотека <ChevronRight size={16}/></button><Separator className="drawer-divider" decorative/>{categories.filter(x=>x.id!=='all').map(({id,full,Icon})=><button key={id} data-category={id} onClick={()=>chooseCategory(id)} className={'drawer-link'+(category===id?' selected':'')}><Icon size={19}/>{full}<ChevronRight size={16}/></button>)}<div className="drawer-footer"><ShieldCheck size={18}/> Защита AES-256-GCM</div></motion.aside>}
      {account&&<motion.section {...appearanceMotion} key="account" className="app-drawer account-drawer" role="dialog" aria-modal="true" aria-label="Аккаунт"><div className="drawer-top"><div><p className="drawer-caption">MEDIA VAULT</p><h2>Аккаунт</h2></div><IconButton Icon={X} label="Закрыть" onClick={closeOverlays}/></div><div className="account-banner"><span className="account-avatar"><UserRound size={28}/></span><div><strong>Google Drive</strong><p>{status}</p></div><span className="status-dot"/></div><div className="account-buttons">{!signedIn&&<button type="button" className="solid-button" onClick={()=>document.getElementById('loginBtn')?.click()}><LogIn size={17}/> Войти через Google</button>}{signedIn&&<button type="button" className="solid-button" onClick={()=>document.getElementById('driveBtn')?.click()}><Cloud size={17}/> {driveConnected?'Обновить доступ к Drive':'Подключить Drive'}</button>}{signedIn&&<button type="button" className="quiet-button" onClick={()=>document.getElementById('logoutBtn')?.click()}><LogOut size={17}/> Выйти</button>}</div><Separator className="drawer-divider" decorative/><button className="drawer-link" type="button" onClick={()=>{closeOverlays();document.getElementById('setupPanel')?.scrollIntoView({behavior:'smooth'});}}><LockKeyhole size={18}/> Открыть библиотеку <ChevronRight size={16}/></button><button className="drawer-link" type="button" onClick={()=>{closeOverlays();goTo('catalog');}}><FolderOpen size={18}/> Мои файлы <ChevronRight size={16}/></button><div className="account-warning"><ShieldCheck size={19}/><p>Ключ шифрования не отправляется на сервер. Никому не передавай секретную фразу.</p></div></motion.section>}
      {filterOpen&&<motion.section {...appearanceMotion} key="filters" className="filter-sheet" role="dialog" aria-modal="true" aria-label="Сортировка"><div className="drawer-top"><h2>Сортировка</h2><IconButton Icon={X} label="Закрыть" onClick={closeOverlays}/></div>{[['newest','Сначала новые'],['oldest','Сначала старые'],['name','По названию'],['size','По размеру']].map(([id,label])=><button className={'sort-row'+(sort===id?' selected':'')} key={id} onClick={()=>{setSort(id);closeOverlays();document.getElementById('sortSelect').value=id;document.getElementById('sortSelect').dispatchEvent(new Event('change',{bubbles:true}));}}>{label}{sort===id&&<Check size={19}/>}</button>)}</motion.section>}
    </AnimatePresence>
    <select id="sortSelect" value={sort} onChange={e=>setSort(e.target.value)} aria-label="Сортировка файлов" className="sr-only" tabIndex={-1}><option value="newest">Сначала новые</option><option value="oldest">Сначала старые</option><option value="name">По названию</option><option value="size">По размеру</option></select>
    <button id="primaryBtn" type="button" className="sr-only">Открыть библиотеку</button>
    <span id="crumbCategory" className="sr-only"/>
    <div className="auth-engine" aria-hidden="true"><button type="button" id="loginBtn">Войти через Google</button><button type="button" id="driveBtn" className="hidden">Подключить Drive</button><button type="button" id="logoutBtn" className="hidden">Выйти</button></div>
    <button id="uploadBtn" type="button" className="sr-only hidden">Добавить файлы</button>
    <div id="viewer" className="viewer hidden" role="dialog" aria-modal="true" aria-label="Просмотр файла"><div className="viewer-head"><div><small id="viewerType"/><strong id="viewerTitle"/></div><button id="closeViewer" className="icon-action" type="button" aria-label="Закрыть просмотр"><X size={24}/></button></div><div className="viewer-body" id="viewerContent"/><div className="viewer-tools" id="viewerTools"/></div>
    <div id="toast" role="status" className="toast hidden"/>
  </>;
}
createRoot(document.getElementById('root')).render(<App/>);