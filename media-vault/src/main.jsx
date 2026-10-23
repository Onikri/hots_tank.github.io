import React, {useEffect, useState} from "react";
import {createRoot} from "react-dom/client";
import "../style.css";
import "./ui.css";

const sections = [
  {id:"all",icon:"▦",label:"Все материалы",short:"Все"},
  {id:"video",icon:"▶",label:"Аниме и видео",short:"Видео"},
  {id:"manga",icon:"▤",label:"Манга",short:"Манга"},
  {id:"book",icon:"▧",label:"Ранобэ и книги",short:"Книги"},
  {id:"audio",icon:"♫",label:"Музыка",short:"Музыка"},
  {id:"image",icon:"▧",label:"Изображения",short:"Фото"}
];

function Glyph({name}) {
  const paths = {
    home:<><path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-7h6v7"/></>,
    catalog:<><rect x="3" y="3" width="7" height="8" rx="1"/><rect x="14" y="3" width="7" height="8" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/></>,
    account:<><circle cx="12" cy="8" r="4"/><path d="M4 21v-2c0-4 3-6 8-6s8 2 8 6v2"/></>,
    menu:<path d="M3 6h18M3 12h18M3 18h18"/>,
    search:<><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></>,
    sort:<><path d="M4 6h14M4 12h10M4 18h6"/><path d="m18 15 3 3-3 3"/></>,
    lock:<><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    close:<path d="M5 5l14 14M19 5 5 19"/>
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function VaultApp() {
  const [menuOpen,setMenuOpen] = useState(false);
  const [accountOpen,setAccountOpen] = useState(false);
  const [activeTab,setActiveTab] = useState("home");
  const [category,setCategory] = useState("all");
  const [counts,setCounts] = useState({all:0,video:0,manga:0,book:0,audio:0,image:0});
  const [bootError,setBootError] = useState("");

  useEffect(()=>{
    const update = event => {
      if(event.detail?.counts)setCounts(event.detail.counts);
      if(event.detail?.category)setCategory(event.detail.category);
    };
    document.addEventListener("mediavault:library-updated",update);
    import("../app.js").catch(error=>{
      console.error("MediaVault failed to initialize",error);
      setBootError("Не удалось загрузить библиотеку. Обнови страницу или проверь подключение.");
    });
    return ()=>document.removeEventListener("mediavault:library-updated",update);
  },[]);

  useEffect(()=>{
    const close = event=>{
      if(event.key==="Escape"){setMenuOpen(false);setAccountOpen(false);}
    };
    window.addEventListener("keydown",close);
    return ()=>window.removeEventListener("keydown",close);
  },[]);

  const jump = (id)=>{
    setMenuOpen(false);
    setAccountOpen(false);
    setActiveTab(id==="homeSection"?"home":"catalog");
    document.getElementById(id)?.scrollIntoView({behavior:"smooth",block:"start"});
  };
  const addFile = ()=>{
    const upload=document.getElementById("uploadBtn");
    if(upload && !upload.classList.contains("hidden")) {
      document.getElementById("filesInput")?.click();
    } else {
      document.getElementById("primaryBtn")?.click();
    }
  };
  const chooseCategory = id=>{
    setCategory(id);setMenuOpen(false);setActiveTab("catalog");
  };

  return <>
    <div className="shell">
      <aside className={"sidebar"+(menuOpen?" open":"")} aria-label="Боковое меню">
        <a className="brand" href="./"><span className="brand-symbol">◇</span><span>MEDIA<span className="brand-light">VAULT</span></span></a>
        <span className="eyebrow">РАЗДЕЛЫ БИБЛИОТЕКИ</span>
        <nav id="nav" aria-label="Категории">
          {sections.map(item=><button key={item.id} type="button" data-category={item.id}
            className={"nav-item"+(category===item.id?" active":"")} onClick={()=>chooseCategory(item.id)}>
            <span>{item.icon}</span>{item.label}
          </button>)}
        </nav>
        <div className="sidebar-spacer"/>
        <div className="sidebar-bottom"><Glyph name="lock"/> Зашифровано на устройстве<br/><small>Google Drive · AES-256-GCM</small></div>
      </aside>
      {menuOpen&&<button type="button" className="sidebar-shade" onClick={()=>setMenuOpen(false)} aria-label="Закрыть меню"/>}
      <main className="main">
        <header className="topbar">
          <a href="./" className="top-brand" aria-label="MediaVault — главная">
            <span className="top-brand-icon">◇</span><span>MEDIA<b>VAULT</b></span>
          </a>
          <div className="crumb">Личная медиатека <span className="slash">/</span><span id="crumbCategory">Все файлы</span></div>
          <span id="status" className="status" aria-live="polite">Не подключено</span>
          <button className="account-trigger" aria-label="Управление аккаунтом" aria-expanded={accountOpen}
            onClick={()=>setAccountOpen(!accountOpen)} type="button"><Glyph name="account"/></button>
          <div className={"top-actions"+(accountOpen?" mobile-open":"")}>
            <button type="button" className="btn btn-outline" id="loginBtn">Войти через Google</button>
            <button type="button" className="btn btn-outline hidden" id="driveBtn">Подключить Drive</button>
            <button type="button" className="btn btn-ghost hidden" id="logoutBtn">Выйти</button>
          </div>
        </header>
        <div className="content">
          {bootError&&<div className="load-error" role="alert">{bootError}</div>}
          <section className="hero" id="homeSection">
            <div className="hero-content">
              <div className="hero-tag"><span>✦</span> ТВОЯ ЛИЧНАЯ МЕДИАТЕКА</div>
              <h1>Любимые истории.<br/><em>В одном месте.</em></h1>
              <p>Аниме, манга, ранобэ, музыка и фотографии. Своя коллекция с приватным шифрованием в Google Drive.</p>
              <div className="hero-actions">
                <button type="button" className="btn btn-primary" id="primaryBtn">Открыть библиотеку <span aria-hidden="true">→</span></button>
                <button type="button" className="btn btn-outline hidden" id="uploadBtn">＋ Добавить файлы</button>
              </div>
              <div className="hero-security"><Glyph name="lock"/> Приватная библиотека · AES-256-GCM</div>
            </div>
            <div className="hero-art" aria-hidden="true">
              <span className="art-card art-back">♫</span><span className="art-card art-mid">▤</span><span className="art-card art-front">▶</span>
            </div>
          </section>
          <section className="notice" id="notice" aria-live="polite">
            <strong>Библиотека закрыта</strong>
            <p>Войди через Google, подключи Drive и введи секретную фразу библиотеки.</p>
            <a href="https://github.com/Onikri/hots_tank.github.io/blob/main/media-vault/README.md" target="_blank" rel="noopener noreferrer">Инструкция по подключению ↗</a>
          </section>
          <section className="settings hidden" id="setupPanel">
            <div className="panel-title"><Glyph name="lock"/><h2>Открыть библиотеку</h2></div>
            <div className="field"><label htmlFor="libraryId">ID зашифрованного каталога</label><input id="libraryId" placeholder="Из сохранённой ссылки-приглашения" autoComplete="off"/></div>
            <div className="field"><label htmlFor="passphrase">Секретная фраза</label><input id="passphrase" type="password" autoComplete="off" placeholder="Фраза для расшифровки"/></div>
            <div className="field hidden" id="createRow"><label htmlFor="passphraseAgain">Повтори фразу при создании</label><input id="passphraseAgain" type="password" autoComplete="off" placeholder="Повтор фразы"/></div>
            <div className="settings-actions">
              <button type="button" className="btn btn-primary" id="unlockBtn">Открыть библиотеку</button>
              <button type="button" className="btn btn-outline hidden" id="createBtn">Создать новую библиотеку</button>
            </div>
            <p className="fine">Не создавай новую библиотеку, если пытаешься восстановить существующую. Секретную фразу восстановить невозможно.</p>
          </section>
          <section className="admin hidden" id="adminPanel">
            <div className="section-head"><h2>Управление медиатекой</h2><span className="role">АДМИНИСТРАТОР</span></div>
            <div className="admin-grid">
              <div className="admin-card"><h3>Загрузка файлов</h3><p>Файлы шифруются на устройстве перед отправкой в Drive.</p>
                <input type="file" id="filesInput" multiple hidden/>
                <button type="button" className="btn btn-outline" id="selectFilesBtn">＋ Выбрать файлы</button>
                <div id="uploadQueue"/>
              </div>
              <div className="admin-card"><h3>Пригласить зрителя</h3><p>Зритель получит доступ на чтение к папке библиотеки.</p>
                <div className="inline"><input type="email" id="inviteEmail" placeholder="email@gmail.com"/><button type="button" className="btn btn-outline" id="inviteBtn">Пригласить</button></div>
                <button type="button" className="text-button" id="copyLinkBtn">Скопировать ссылку-приглашение ↗</button>
              </div>
            </div>
          </section>
          <section className="library-section" id="librarySection">
            <div className="catalog-heading">
              <div><span className="eyebrow">МОЯ КОЛЛЕКЦИЯ</span><h2>Каталог</h2><p>Всё, что важно, в одном месте</p></div>
              <span className="catalog-label">PRIVATE COLLECTION</span>
            </div>
            <label className="catalog-search" htmlFor="searchInput"><Glyph name="search"/>
              <input type="search" id="searchInput" aria-label="Поиск по названию" placeholder="Быстрый поиск по названию" autoComplete="off"/>
            </label>
            <nav className="category-strip" aria-label="Фильтр по категориям">
              {sections.map(item=><button type="button" key={item.id} data-category={item.id}
                className={"category-chip"+(category===item.id?" active":"")} onClick={()=>chooseCategory(item.id)}>
                {item.short}<span className="chip-count">{counts[item.id]||0}</span>
              </button>)}
            </nav>
            <div className="section-head catalog-results">
              <div><h2 id="sectionTitle">Все материалы</h2><span id="count" className="count">0 файлов</span></div>
              <label className="sort-control" htmlFor="sortSelect"><Glyph name="sort"/>
                <select id="sortSelect" aria-label="Сортировка">
                  <option value="newest">Сначала новые</option>
                  <option value="oldest">Сначала старые</option>
                  <option value="name">По названию</option>
                  <option value="size">По размеру</option>
                </select>
              </label>
            </div>
            <div id="libraryGrid" className="library-grid" aria-live="polite">
              <div className="empty"><div className="empty-icon">◇</div><h3>Библиотека закрыта</h3><p>Подключи Google Drive, чтобы увидеть свои файлы.</p></div>
            </div>
          </section>
        </div>
      </main>
    </div>
    <nav className="bottom-dock" aria-label="Основная навигация">
      <button className={"dock-tab"+(activeTab==="home"?" active":"")} onClick={()=>jump("homeSection")} type="button"><Glyph name="home"/><span>Главная</span></button>
      <button className={"dock-tab"+(activeTab==="catalog"?" active":"")} onClick={()=>jump("librarySection")} type="button"><Glyph name="catalog"/><span>Каталог</span></button>
      <button className="dock-tab dock-add" onClick={addFile} type="button" aria-label="Добавить файл"><span className="dock-add-glyph">＋</span><span>Добавить</span></button>
      <button className={"dock-tab"+(accountOpen?" active":"")} onClick={()=>{setMenuOpen(false);setAccountOpen(!accountOpen);}} type="button"><Glyph name="account"/><span>Аккаунт</span></button>
      <button className={"dock-tab"+(menuOpen?" active":"")} id="mobileMenu" aria-expanded={menuOpen} onClick={()=>{setAccountOpen(false);setMenuOpen(!menuOpen);}} type="button"><Glyph name="menu"/><span>Меню</span></button>
    </nav>
    <div id="viewer" className="viewer hidden" role="dialog" aria-modal="true" aria-label="Просмотр файла">
      <div className="viewer-head"><div><small id="viewerType"/><strong id="viewerTitle"/></div><button type="button" className="icon-btn" id="closeViewer" aria-label="Закрыть">✕</button></div>
      <div id="viewerContent" className="viewer-body"/>
      <div id="viewerTools" className="viewer-tools"/>
    </div>
    <div id="toast" className="toast hidden" role="status"/>
  </>;
}

createRoot(document.getElementById("root")).render(<VaultApp/>);
