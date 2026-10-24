import {useCallback,useEffect,useState} from 'react';
import {catalogProviders,fetchCatalog,mergeCatalog,rankCatalog} from './catalog.js';

const cache=new Map();
const emptyItems=Object.freeze([]),emptyStatuses=Object.freeze({});
export function useCatalog(query,kind,year,server,page=1,composing=false){
  const text=query.trim(),cacheKey=JSON.stringify([text,kind,year,server,page]);
  const [revision,setRevision]=useState(0),[snapshot,setSnapshot]=useState(null);
  const key=cacheKey+':'+revision+':'+composing;
  const retry=useCallback(()=>{cache.delete(cacheKey);setRevision(value=>value+1);},[cacheKey]);
  useEffect(()=>{
    if(composing)return;
    const abort=new AbortController(),names=catalogProviders(kind,text,server);
    const cached=cache.get(cacheKey);
    if(cached&&cached.expires>Date.now()){
      setSnapshot({key,...cached,loading:false});return;
    }
    const states=Object.fromEntries(names.map(name=>[name,'loading'])),results={};
    const items=()=>rankCatalog(mergeCatalog(names.flatMap(name=>results[name]||[])),text);
    setSnapshot({key,items:[],statuses:{...states},loading:names.length>0});
    const timer=setTimeout(()=>{
      Promise.allSettled(names.map(async provider=>{
        try{
          const found=await fetchCatalog(provider,{query:text,kind,year,server,page,signal:abort.signal});
          if(abort.signal.aborted)return;
          results[provider]=found;states[provider]='ok';
        }catch(error){
          if(abort.signal.aborted)return;
          states[provider]='unavailable';
        }
        if(!abort.signal.aborted)setSnapshot({key,items:items(),statuses:{...states},loading:Object.values(states).includes('loading')});
      })).then(()=>{
        if(abort.signal.aborted)return;
        const complete={items:items(),statuses:{...states}};
        setSnapshot({key,...complete,loading:false});
        // Do not make temporary provider outages persist for three minutes.
        if(names.length&&names.every(name=>states[name]==='ok')){
          cache.set(cacheKey,{...complete,expires:Date.now()+180000});
          while(cache.size>60)cache.delete(cache.keys().next().value);
        }
      });
    },text?350:0);
    return()=>{clearTimeout(timer);abort.abort();};
  },[key]);
  // Clear old choices in the same render as input/type/page changes, before
  // effects run. IME composition never dispatches intermediate search terms.
  const current=snapshot?.key===key?snapshot:{items:emptyItems,statuses:emptyStatuses,loading:!composing};
  return {...current,retry};
}
