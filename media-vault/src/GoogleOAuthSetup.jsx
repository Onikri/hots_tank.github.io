import React,{useState} from 'react';
import Icon from './Icons.jsx';

export default function GoogleOAuthSetup({service}){
  const [secret,setSecret]=useState(''),[filename,setFilename]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false);
  const clientId=window.MEDIA_VAULT_CONFIG?.googleClientId,redirect=service.server+'/oauth/callback';
  async function readFile(event){
    const file=event.target.files?.[0];setSecret('');setFilename('');setError('');
    if(!file)return;
    try{
      if(file.size>65536)throw Error();
      const config=JSON.parse(await file.text()).web;
      if(config?.client_id!==clientId||typeof config?.client_secret!=='string')throw Error();
      setSecret(config.client_secret);setFilename(file.name);
    }catch{setError('Выбери JSON существующего Web OAuth-клиента MediaVault из Google Cloud.');}
    event.target.value='';
  }
  async function save(event){
    event.preventDefault();setBusy(true);setError('');
    try{await service.configureGoogle({client_id:clientId,client_secret:secret});setSecret('');setFilename('');}
    catch(cause){setError(cause.message);}finally{setBusy(false);}
  }
  return <form className="google-oauth-setup" onSubmit={save}>
    <h3>Подключи фоновый импорт один раз</h3>
    <p>В <a href="https://console.cloud.google.com/auth/clients?project=262576202069" target="_blank" rel="noopener noreferrer">Google Cloud</a> открой OAuth-клиент MediaVault и добавь этот адрес в «Authorized redirect URIs»:</p>
    <div className="oauth-redirect"><code>{redirect}</code><button type="button" className="icon-button" aria-label="Скопировать адрес возврата Google" onClick={async()=>{try{await navigator.clipboard.writeText(redirect);setCopied(true);}catch{setError('Скопируй адрес возврата из строки выше.');}}}><Icon name={copied?'check':'copy'} size={16}/></button></div>
    <p>Сохрани адрес. В правой панели этого же клиента открой <strong>Client secrets → Add Secret</strong>. Google покажет новый секрет один раз — скопируй его в поле ниже. Старый секрет оставь включённым до завершения подключения.</p>
    <label className="input-label" htmlFor="googleOAuthSecret">Client Secret из Google Cloud</label>
    <input id="googleOAuthSecret" className="field-input" type="password" autoComplete="off" value={secret} onChange={event=>{setSecret(event.target.value);setFilename('');}} placeholder="Вставь новый Client Secret" disabled={busy}/>
    <p className="fine">Настройки передаются только твоему серверу через HTTPS и хранятся там зашифрованными.</p>
    <details><summary>У меня сохранён JSON OAuth-клиента</summary><label className="input-label" htmlFor="googleOAuthFile">JSON OAuth-клиента Google</label><input id="googleOAuthFile" className="field-input" type="file" accept=".json,application/json" onChange={readFile} disabled={busy}/>{filename&&<p className="fine">Выбран файл: {filename}</p>}<p className="fine">Подойдёт файл, сохранённый при создании секрета. Google не позволяет скачать существующий секрет повторно.</p></details>
    {error&&<p className="inline-error" role="alert">{error}</p>}
    <button className="btn btn-primary" disabled={busy||secret.trim().length<20}><Icon name="lock" size={16}/>{busy?'Сохраняем…':'Сохранить настройки Google'}</button>
    <p className="fine">Затем нажми «Разрешить серверу доступ к Drive» и выбери roma.shevchenko2020@gmail.com.</p>
  </form>;
}
