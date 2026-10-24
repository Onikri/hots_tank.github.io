import {useEffect,useMemo,useRef,useState} from 'react';

export function validateServer(value){
  if(!value?.trim())return '';
  const url=new URL(value.trim());
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('Нужен HTTPS-адрес твоего сервера без пути и параметров.');
  return url.origin;
}
function storedServer(){try{return validateServer(window.MEDIA_VAULT_CONFIG?.importServerUrl||localStorage.getItem('mediavault_import_server')||'');}catch{return '';}}
export function createImportClient(server,googleToken,fetcher=fetch){
  let session=null,signing=null;
  async function request(path,{method='GET',body,auth=true,headers={},signal}={}){
    if(!server)throw Error('Сервер импорта ещё не подключён.');
    if(auth&&!session)await authenticate();
    const response=await fetcher(server+path,{method,signal,headers:{...(body?{'Content-Type':'application/json'}:{}),...(auth?{Authorization:'Bearer '+session.token}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json().catch(()=>({}));
    if(!response.ok){if(response.status===401)session=null;throw Object.assign(Error(typeof result.detail==='string'?result.detail:'Сервер не выполнил запрос.'),{status:response.status});}
    return result;
  }
  async function authenticate(){
    if(signing)return signing;
    signing=(async()=>{
      const health=await request('/health',{auth:false});
      if(health.application!=='MediaVault'||health.version<4||health.origin!==window.location.origin)throw Error('Этот адрес не подтвердил конфигурацию MediaVault.');
      if(!googleToken())throw Error('Сначала войди через Google.');
      const response=await fetcher(server+'/auth/session',{method:'POST',headers:{Authorization:'Bearer '+googleToken()}});
      const data=await response.json();if(!response.ok)throw Error(data.detail||'Сервер не подтвердил вход.');
      session=data;return data;
    })();
    try{return await signing;}finally{signing=null;}
  }
  return {request,authenticate,reset:()=>{session=null;},getSession:()=>session};
}

export function useImportService(state,actions){
  const [server,setAddress]=useState(storedServer),[status,setStatus]=useState('idle'),[error,setError]=useState(''),[session,setSession]=useState(null),[jobs,setJobs]=useState([]);
  const live=useRef(state);live.current=state;
  const client=useMemo(()=>createImportClient(server,()=>live.current.token),[server,state.user?.sub]);
  const refreshSignature=useRef('');
  const active=jobs.some(job=>['queued','running','cancelling'].includes(job.status));
  function setServer(value){const address=validateServer(value);try{localStorage.setItem('mediavault_import_server',address);}catch{}setAddress(address);}
  useEffect(()=>{
    let closed=false,timer;
    setSession(null);setJobs([]);setError('');refreshSignature.current='';
    if(!server||!state.admin||!state.user||!state.token){setStatus(server?'disconnected':'unconfigured');return;}
    async function update(){
      try{
        setStatus(previous=>previous==='connected'?'connected':'connecting');
        const access=client.getSession()||await client.authenticate();
        const response=await client.request('/jobs');
        if(!closed){setSession(access);setJobs(response.jobs||[]);setStatus('connected');setError('');}
      }catch(cause){if(!closed){setStatus('error');setError(cause.message);}}
      if(!closed)timer=setTimeout(update,4500);
    }
    update();return()=>{closed=true;clearTimeout(timer);client.reset();};
  },[server,state.admin,state.user?.sub,!!state.token,client]);
  useEffect(()=>{
    if(!state.catalog||state.busy||!state.driveConnected)return;
    const signature=jobs.map(j=>j.id+':'+(j.progress?.saved||0)+':'+j.status).join('|');
    if(!signature||signature===refreshSignature.current)return;
    if(jobs.some(j=>j.progress?.saved>0||j.status==='completed')){
      refreshSignature.current=signature;
      actions.refreshCatalog().then(ok=>{if(!ok&&refreshSignature.current===signature)refreshSignature.current='';});
    }
  },[jobs,state.catalog?.folderId,!!state.busy,state.driveConnected]);
  async function refresh(){const result=await client.authenticate();setSession(result);const data=await client.request('/jobs');setJobs(data.jobs);setStatus('connected');return result;}
  async function connect(){
    const popup=window.open('about:blank','mediavault-drive-consent','popup,width=560,height=720');
    if(!popup)throw Error('Разреши всплывающее окно для подключения Google Drive.');
    try{
      const data=await client.request('/oauth/start',{method:'POST'});
      if(new URL(data.url).origin!=='https://accounts.google.com')throw Error('Некорректный адрес Google.');
      popup.location=data.url;
      await new Promise((resolve,reject)=>{
        const finish=(error)=>{window.removeEventListener('message',message);clearInterval(timer);clearTimeout(timeout);error?reject(error):resolve();};
        const message=event=>{if(event.origin===server&&event.source===popup&&event.data?.type==='mediavault-server-connected')finish();};
        window.addEventListener('message',message);
        const timer=setInterval(()=>{if(popup.closed)finish();},1000),timeout=setTimeout(()=>finish(Error('Время подключения истекло. Повтори вход.')),180000);
      });
      const result=await refresh();if(!result.driveConnected)throw Error('Google Drive ещё не подключён к серверу.');
    }catch(cause){popup.close();throw cause;}
  }
  async function submit(job){
    if(!session?.driveConnected)throw Error('Подключи Google Drive к серверу перед первым импортом.');
    const task=await client.request('/jobs',{method:'POST',body:{job,vault_key:actions.getServerKey()},headers:{'Idempotency-Key':crypto.randomUUID()}});
    setJobs(old=>[task,...old.filter(value=>value.id!==task.id)]);return task;
  }
  async function operation(id,op){const task=await client.request('/jobs/'+encodeURIComponent(id)+'/'+op,{method:'POST'});setJobs(old=>old.map(value=>value.id===id?task:value));return task;}
  return {server,setServer,status,error,session,jobs,active,connect,submit,refresh,
    request:client.request,cancel:id=>operation(id,'cancel'),resume:id=>operation(id,'resume')};
}
