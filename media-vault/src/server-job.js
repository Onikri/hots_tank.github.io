export const NOTEBOOK_URL='https://colab.research.google.com/github/Onikri/hots_tank.github.io/blob/main/media-vault/notebooks/MediaVault_Server_Import.ipynb';

export function publicSourceUrl(value){
  let url;
  try{url=new URL(String(value).trim());}catch{throw Error('Введи полную HTTPS-ссылку на страницу или видео.');}
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))throw Error('Нужна HTTPS-ссылка без логина и пароля.');
  const host=url.hostname.toLowerCase();
  if(host==='localhost'||host.endsWith('.local')||host.endsWith('.internal')||host.startsWith('[')||/^\d+(\.\d+){3}$/.test(host))throw Error('Локальные и служебные адреса не поддерживаются.');
  url.hash='';return url.href;
}

export function validateEpisodeSelection(value){
  const text=String(value||'all').trim().toLowerCase();
  if(['all','все',''].includes(text))return 'all';
  for(const part of text.split(',')){
    const match=/^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if(!match)throw Error('Серии: «все», «1-12» или «1, 3, 5-8».');
    const first=Number(match[1]),last=Number(match[2]||match[1]);
    if(first<1||last<first||last>10000)throw Error('Проверь диапазон серий.');
  }
  return text.replaceAll(' ','');
}

// This payload is intentionally an allowlist. No OAuth token, key or phrase is exported.
export function buildServerJob({libraryId,urls,collection='',episodes='all',quality='720'}){
  if(!/^[\w-]{5,256}$/.test(String(libraryId||'')))throw Error('Сначала открой библиотеку, чтобы получить её ID.');
  const sources=[...new Set(String(urls||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(publicSourceUrl))];
  if(!sources.length)throw Error('Добавь ссылку на страницу сезона, серию или видео.');
  if(sources.length>200)throw Error('В одном задании можно указать до 200 ссылок.');
  if(!['best','1080','720','480','360'].includes(String(quality)))throw Error('Выбери качество из списка.');
  return {version:1,library_id:String(libraryId),sources,collection:String(collection).trim().slice(0,180),
    episodes:validateEpisodeSelection(episodes),quality:String(quality),resume:true};
}
