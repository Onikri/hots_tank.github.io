import {useEffect,useState} from 'react';
const cache=new Map();
export function useVoices(items,voice,service){
  const [results,setResults]=useState({}),[pending,setPending]=useState(0);
  useEffect(()=>{
    let closed=false;const abort=new AbortController();
    setResults({});setPending(0);
    if(!voice||service.status!=='connected')return;
    const candidates=items.slice(0,24);let cursor=0;
    setPending(candidates.length);
    async function work(){
      while(!closed&&cursor<candidates.length){
        const item=candidates[cursor++],key=service.server+':'+item.title;
        try{
          let value=cache.get(key);
          if(!value||value.expires<Date.now()){
            const data=await service.request('/sources/availability?q='+encodeURIComponent(item.title),{signal:abort.signal});
            value={...data,expires:Date.now()+900000};cache.set(key,value);
            if(cache.size>128)cache.delete(cache.keys().next().value);
          }
          if(!closed)setResults(old=>({...old,[item.id]:value}));
        }catch{if(!closed)setResults(old=>({...old,[item.id]:{dubs:[],unavailable:true}}));}
        if(!closed)setPending(n=>Math.max(0,n-1));
      }
    }
    const timer=setTimeout(()=>{work();work();},600);
    return()=>{closed=true;clearTimeout(timer);abort.abort();};
  },[items,!!voice,service.server,service.status]);
  return {results,pending};
}
