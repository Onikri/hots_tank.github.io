import {useState} from 'react';
import Icon from './Icons.jsx';

export default function LibrarySetup({state,libraryId,setLibraryId,passphrase,setPassphrase,again,setAgain,onOpen,onFind}){
  const [manual,setManual]=useState(false),[link,setLink]=useState('');
  const busy=!!state.busy;
  const searching=state.libraryDiscovery==='searching';
  const failed=state.libraryDiscovery==='error';
  const creating=state.admin&&state.libraryDiscovery==='empty'&&!manual;
  const emptyReader=!state.admin&&state.libraryDiscovery==='empty'&&!manual;
  const options=state.libraryOptions||[];
  function readLink(value){
    setLink(value);
    let id=value.trim();
    try{id=new URL(id).searchParams.get('library')||'';}catch{}
    setLibraryId(/^[\w-]{5,256}$/.test(id)?id:'');
  }
  return <section id="setupPanel" className="settings-card" aria-busy={searching}>
    <div className="section-heading"><h2 className="section-title">{searching?'Ищем твою библиотеку':failed?'Не удалось найти библиотеку':creating?'Придумай фразу для защиты файлов':emptyReader?'Нужно приглашение владельца':options.length>1&&!manual?'Выбери библиотеку':'Твоя библиотека найдена'}</h2><Icon name="lock" size={21}/></div>
    {searching?<p className="page-subtitle" role="status"><span className="spinner"/> Проверяем твой Google Drive. Никакие ID вводить не нужно.</p>:failed?<>
      <p className="inline-error" role="alert">{state.libraryDiscoveryError}</p>
      <button id="findLibrariesBtn" className="btn btn-secondary" disabled={busy} onClick={onFind}><Icon name="refresh" size={17}/>Найти библиотеку ещё раз</button>
    </>:<>
      <p className="page-subtitle">{creating?'Drive уже подключён. Папку, зашифрованный каталог и его ID создадим автоматически.':emptyReader?'Владелец должен пригласить твой Google-аккаунт. Ссылку и фразу библиотеки он передаст тебе.':'Введи фразу, которую ты задал при создании библиотеки. Файлы и каталог мы уже нашли в Drive.'}</p>
      {!manual&&options.length>1&&<div className="form-field"><label className="input-label" htmlFor="libraryChoice">Доступные библиотеки</label><select id="libraryChoice" className="field-input" value={libraryId} onChange={event=>setLibraryId(event.target.value)}><option value="">Выбери библиотеку</option>{options.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}</select></div>}
      <button className="text-link" onClick={()=>{setManual(!manual);setLink('');setLibraryId(manual?state.libraryId:'');}}>{manual?'Вернуться к найденной библиотеке':'У меня есть ссылка на другую библиотеку'}<Icon name="chevron" size={14}/></button>
      {manual&&<div className="form-field"><label className="input-label" htmlFor="libraryLink">Ссылка-приглашение</label><input id="libraryLink" className="field-input" value={link} onChange={event=>readLink(event.target.value)} placeholder="Вставь ссылку, которую прислал владелец" autoComplete="off"/><p className="fine">Ссылка сама содержит адрес каталога. Копировать отдельный ID не требуется.</p></div>}
      {!emptyReader&&<>
        <div className="form-field"><label className="input-label" htmlFor="passphrase">{creating?'Твоя новая секретная фраза':'Секретная фраза библиотеки'}</label><input id="passphrase" className="field-input" type="password" value={passphrase} onChange={event=>setPassphrase(event.target.value)} placeholder={creating?'Придумай фразу: не менее 12 символов':'Фраза, которой зашифрованы файлы'} autoComplete="off"/></div>
        {creating&&<div id="createRow" className="form-field"><label className="input-label" htmlFor="passphraseAgain">Повтори придуманную фразу</label><input id="passphraseAgain" className="field-input" type="password" value={again} onChange={event=>setAgain(event.target.value)} placeholder="Та же фраза ещё раз" autoComplete="off"/></div>}
        <p className="fine">Это не пароль Google. {creating?'Придумай и сохрани свою фразу: ею будут зашифрованы файлы.':'Для чужой библиотеки фразу нужно получить у её владельца.'} Сервис не может восстановить забытую фразу.</p>
        <div className="form-actions">{creating?<button id="createBtn" className="btn btn-primary" disabled={busy} onClick={()=>onOpen(true)}>{state.busy==='create'?<span className="spinner"/>:<Icon name="plus" size={18}/>}Создать мою библиотеку</button>:<button id="unlockBtn" className="btn btn-primary" disabled={busy||!libraryId} onClick={()=>onOpen(false)}>{state.busy==='unlock'?<span className="spinner"/>:<Icon name="book" size={18}/>}Открыть библиотеку</button>}</div>
      </>}
    </>}
  </section>;
}
