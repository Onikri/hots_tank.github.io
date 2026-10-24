import {useEffect,useRef,useState} from 'react';
import {catalogProviders,fetchCatalog,mergeCatalog} from './catalog.js';

const cache=new Map();
export function useCatalog(query,kind,year,server,page=1){
  const [items,setItems]=useState([]),[statuses,setStatuses]=useState({}),[loading,setLoading]=useState(false);
  const version=useRef(0);
  useEffect(()=>{
    const generation=++version.current,abort=new AbortController();
    // Never offer titles from an older query while the new debounce is pending.
    setItems([]);setStatuses({});setLoading(true);
    const current=()=>generation===version.current&&!abort.signal.aborted;
    const timer=setTimeout(()=>{
      const names=catalogProviders(kind,query.trim(),server),key=JSON.stringify([query.trim(),kind,year,server,page]);
      const cached=cache.get(key);
      if(cached&&cached.expires>Date.now()){setItems(cached.items);setStatuses(cached.statuses);setLoading(false);return;}
      setItems([]);setStatuses(Object.fromEntries(names.map(name=>[name,'loading'])));setLoading(names.length>0);
      const results=[],states={};
      Promise.allSettled(names.map(async provider=>{
        try{const found=await fetchCatalog(provider,{query:query.trim(),kind,year,server,page,signal:abort.signal});if(!current())return;results.push(...found);states[provider]='ok';setItems(mergeCatalog(results));}
        catch(error){if(!current())return;states[provider]='unavailable';}
        if(current())setStatuses({...states,...Object.fromEntries(names.filter(n=>!states[n]).map(n=>[n,'loading']))});
      })).then(()=>{
        if(!current())return;setLoading(false);cache.set(key,{items:mergeCatalog(results),statuses:states,expires:Date.now()+180000});
        while(cache.size>60)cache.delete(cache.keys().next().value);
      });
    },query?350:0);
    return()=>{clearTimeout(timer);abort.abort();};
  },[query,kind,year,server,page]);
  return {items,statuses,loading};
}
