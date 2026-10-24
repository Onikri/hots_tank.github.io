import {CHUNK_SIZE,sealChunk,sealIndex,guessCategory,mimeFor} from "../crypto.js";
import {createFolder,uploadSmall,replaceSmall} from "../drive.js";
import {SECTION_LABELS,SECTION_FORMAT,sectionForCollection,uploadPlacement,sameName} from './library-model.js';

const categories=["video","audio","manga","book","image"];
function aborted(){return new DOMException("Загрузка отменена","AbortError");}
function describe(source,options={}){
  const name=String(options.name||source?.name||"").trim();
  if(!name||name.length>500)throw Error("Укажи имя файла длиной до 500 символов.");
  const category=options.category||guessCategory({name});
  if(!categories.includes(category))throw Error("Неподдерживаемый тип файла.");
  const sourcePath=String(options.sourcePath||source?.webkitRelativePath||"").slice(0,2048);
  const requested=options.collection;
  const placement=uploadPlacement({name,category,sourcePath,section:options.section,collection:requested,part:options.part});
  const size=options.size??source?.size;
  if(size!=null&&(!Number.isSafeInteger(Number(size))||Number(size)<0))throw Error("Некорректный размер файла.");
  if(size!=null&&Number(size)===0)throw Error("Пустой файл не поддерживается.");
  return {name,category,mime:options.mime||mimeFor({name,type:source?.type||""},category),
    size:size==null?null:Number(size),sourcePath,...placement,
    collectionId:typeof requested==="object"?requested?.id:null,
    metadataId:options.metadataId??requested?.metadataId,
    episode:options.episode,signal:options.signal};
}
async function* sourceBytes(source,signal){
  if(!source)throw Error("Источник не вернул поток данных.");
  if(source.getReader){
    const reader=source.getReader();let finished=false;
    const abort=()=>{reader.cancel().catch(()=>{});};
    signal?.addEventListener("abort",abort,{once:true});
    try{
      while(true){
        if(signal?.aborted)throw aborted();
        const result=await reader.read();
        if(signal?.aborted)throw aborted();
        if(result.done){finished=true;break;}
        yield result.value;
      }
    }finally{
      signal?.removeEventListener("abort",abort);
      if(!finished)try{await reader.cancel();}catch{}
      reader.releaseLock();
    }
  }else if(source[Symbol.asyncIterator]||source[Symbol.iterator]){
    for await(const part of source){if(signal?.aborted)throw aborted();yield part;}
  }else throw Error("Источник должен вернуть ReadableStream или AsyncIterable.");
}
export async function* encryptionChunks(source,signal){
  // The plaintext buffer stays at 4 MiB even when the source has arbitrary chunk sizes.
  let buffer=new Uint8Array(CHUNK_SIZE),used=0;
  for await(const input of sourceBytes(source,signal)){
    const bytes=input instanceof ArrayBuffer?new Uint8Array(input):
      ArrayBuffer.isView(input)?new Uint8Array(input.buffer,input.byteOffset,input.byteLength):null;
    if(!bytes)throw Error("Источник вернул данные неверного типа.");
    for(let offset=0;offset<bytes.length;){
      const count=Math.min(CHUNK_SIZE-used,bytes.length-offset);
      buffer.set(bytes.subarray(offset,offset+count),used);
      used+=count;offset+=count;
      if(used===CHUNK_SIZE){yield buffer;buffer=new Uint8Array(CHUNK_SIZE);used=0;}
    }
  }
  if(used)yield buffer.subarray(0,used);
}

/** Session secrets are supplied by an in-memory closure and never returned by getState(). */
export function createUploadService({getSession,onCatalog,onProgress=()=>{},onAuthExpired=()=>{}}){
  let mutations=Promise.resolve();
  const active=new Set();
  function capture(){
    const session=getSession();
    if(!session.admin||!session.key||!session.salt||!session.catalog||!session.libraryId)
      throw Error("Открой библиотеку администратора перед загрузкой.");
    assert(session);
    return {generation:session.generation,key:session.key,salt:session.salt,libraryId:session.libraryId};
  }
  function assert(context,signal){
    const current=getSession();
    if(signal?.aborted||context.generation!==current.generation||context.key!==current.key||
      context.libraryId!==current.libraryId)throw aborted();
    if(!current.admin||!current.catalog||!current.token||Date.now()>=current.tokenExpiresAt)
      throw Error("Подключи Google Drive заново.");
    return current;
  }
  function enqueue(context,operation){
    const result=mutations.then(()=>{assert(context);return operation();});
    mutations=result.catch(()=>{});
    return result;
  }
  function token(context,signal){return assert(context,signal).token;}
  function transfer(externalSignal){
    const controller=new AbortController(),abort=()=>controller.abort();
    externalSignal?.addEventListener("abort",abort,{once:true});
    if(externalSignal?.aborted)abort();
    active.add(controller);
    return {signal:controller.signal,cleanup(){
      active.delete(controller);externalSignal?.removeEventListener("abort",abort);
    }};
  }
  function emit(descriptor,id,loaded,status,error="",phase="uploading"){
    const total=descriptor.size||0;
    onProgress({id,name:descriptor.name,loaded,total,
      percent:status==="done"?100:total?Math.min(99,Math.floor(loaded/total*100)):0,status,phase,error});
  }
  async function folders(draft,descriptor,context,signal){
    const old=draft.storage||{};
    const storage=draft.storage={...old,version:2,mediaFolders:{...(old.mediaFolders||{})},sectionFolders:{...(old.sectionFolders||{})},
      collections:Array.isArray(old.collections)?old.collections.map(entry=>({...entry,parts:(entry.parts||[]).map(part=>({...part}))})):[]};
    let mediaFolder=storage.sectionFolders[descriptor.section];
    if(!mediaFolder){
      mediaFolder=(await createFolder(token(context,signal),SECTION_LABELS[descriptor.section],draft.folderId,{signal})).id;
      storage.sectionFolders[descriptor.section]=mediaFolder;
      if(SECTION_FORMAT[descriptor.section]===descriptor.category&&descriptor.section!=='anime'&&descriptor.section!=='ranobe')storage.mediaFolders[descriptor.category]??=mediaFolder;
    }
    let collection=storage.collections.find(entry=>sectionForCollection(entry,draft)===descriptor.section&&
      (descriptor.collectionId?entry.id===descriptor.collectionId:sameName(entry.name,descriptor.collectionName)));
    if(!collection){
      const id=crypto.randomUUID();
      const folder=await createFolder(token(context,signal),"collection-"+id,mediaFolder,{signal});
      collection={id,category:SECTION_FORMAT[descriptor.section],section:descriptor.section,name:descriptor.collectionName,folderId:folder.id,parts:[]};
      if(Number.isSafeInteger(Number(descriptor.metadataId))&&Number(descriptor.metadataId)>0)
        collection.metadataId=Number(descriptor.metadataId);
      storage.collections.push(collection);
    }
    let parent=collection.folderId,part;
    if(descriptor.partName){
      collection.parts??=[];
      part=collection.parts.find(entry=>sameName(entry.name,descriptor.partName));
      if(!part){
        const id=crypto.randomUUID();
        part={id,name:descriptor.partName,folderId:(await createFolder(token(context,signal),'part-'+id,parent,{signal})).id};
        collection.parts.push(part);
      }
      parent=part.folderId;
    }
    const itemId=crypto.randomUUID();
    const folder=await createFolder(token(context,signal),"asset-"+itemId,parent,{signal});
    return {itemId,folderId:folder.id,collection,part};
  }
  async function commit(catalog,context,signal){
    assert(context,signal);
    const sealed=await sealIndex(catalog,context.key,context.salt);
    await replaceSmall(token(context,signal),context.libraryId,
      new Blob([JSON.stringify(sealed)],{type:"application/octet-stream"}),{signal});
    assert(context,signal);
    await onCatalog(catalog);
  }
  async function ingest(descriptor,stream,context){
    const task=transfer(descriptor.signal),signal=task.signal,id=crypto.randomUUID();
    let loaded=0;
    try{
      assert(context,signal);emit(descriptor,id,0,"running","","preparing");
      const current=getSession().catalog;
      const draft={...current,items:[...current.items]};
      const destination=await folders(draft,descriptor,context,signal),chunks=[];
      for await(const raw of encryptionChunks(stream,signal)){
        assert(context,signal);
        emit(descriptor,id,loaded,"running","","encrypting");
        const sealed=await sealChunk(raw,context.key,destination.itemId,chunks.length);
        emit(descriptor,id,loaded,"running","","uploading");
        const remote=await uploadSmall(token(context,signal),"part-"+String(chunks.length).padStart(6,"0")+".enc",
          new Blob([sealed.ciphertext]),destination.folderId,{signal});
        chunks.push({fileId:remote.id,iv:sealed.iv});loaded+=raw.byteLength;
        if(descriptor.size!=null&&loaded>descriptor.size)throw Error("Источник превысил заявленный размер файла.");
        assert(context,signal);emit(descriptor,id,loaded,"running");
      }
      if(!loaded)throw Error("Источник вернул пустой файл.");
      if(descriptor.size!=null&&loaded!==descriptor.size)throw Error("Источник вернул неполный файл.");
      const item={id:destination.itemId,folderId:destination.folderId,name:descriptor.name,
        category:descriptor.category,mime:descriptor.mime,size:loaded,addedAt:new Date().toISOString(),
        section:descriptor.section,collectionId:destination.collection.id,chunks};
      if(destination.part){item.partId=destination.part.id;item.partName=destination.part.name;}
      if(descriptor.sourcePath)item.sourcePath=descriptor.sourcePath;
      if(descriptor.episode!=null)item.episode=descriptor.episode;
      if(Number.isSafeInteger(Number(descriptor.metadataId))&&Number(descriptor.metadataId)>0)
        item.metadataId=Number(descriptor.metadataId);
      draft.items.push(item);
      emit(descriptor,id,loaded,"running","","saving");
      await commit(draft,context,signal);
      if(context.generation===getSession().generation)emit(descriptor,id,loaded,"done","","done");
      return item;
    }catch(error){
      if(context.generation===getSession().generation)emit(descriptor,id,loaded,"error",error.message||String(error));
      if(error.status===401)onAuthExpired();
      // A failed catalog PATCH can have an uncertain outcome. Do not delete an asset it may reference.
      throw error;
    }finally{task.cleanup();try{await stream?.cancel?.();}catch{}}
  }
  async function uploadFiles(files,options={}){
    const context=capture(),results=[];
    for(const file of Array.from(files||[])){
      let started=false;
      try{
        const descriptor=describe(file,options);
        const item=await enqueue(context,()=>{
          assert(context,descriptor.signal);
          started=true;
          return ingest(descriptor,file.stream(),context);
        });
        results.push({name:file.name,ok:true,item});
      }catch(error){
        results.push({name:file.name,ok:false,error:error.message||String(error)});
        if(error.name==="AbortError"||error.status===401||context.generation!==getSession().generation)break;
        if(!started)onProgress({id:crypto.randomUUID(),name:file.name,loaded:0,total:file.size||0,
          percent:0,status:"error",error:error.message||String(error)});
        if(!getSession().token)break;
      }
    }
    return results;
  }
  async function importStream(options){
    const context=capture(),descriptor=describe(null,{...options,category:options.category||"video"});
    try{return await enqueue(context,()=>ingest(descriptor,options.stream,context));}
    catch(error){try{await options.stream?.cancel?.();}catch{}throw error;}
  }
  async function importVideo(options,fetcher=fetch){
    const context=capture();
    if(!options?.sourceUrl)throw Error("Укажи URL видео.");
    // Validate the user-visible metadata before starting a remote download.
    describe(null,{...options,category:"video",mime:options.mime||"video/mp4"});
    const url=new URL(options.sourceUrl);
    if(!["https:","http:"].includes(url.protocol))throw Error("Источник видео должен использовать HTTP или HTTPS.");
    const task=transfer(options.signal);let response;
    try{
      assert(context,task.signal);
      response=await fetcher(url.href,{signal:task.signal});
      assert(context,task.signal);
      if(response?.ok===false)throw Error("Источник видео: HTTP "+response.status);
      const headers=response?.headers;
      const contentType=(headers?.get?.("content-type")||response?.mime||"").split(";")[0].trim();
      if(contentType&&!/^(video\/(mp4|webm|quicktime|x-matroska|x-m4v)|application\/octet-stream)$/i.test(contentType))
        throw Error("Источник должен вернуть готовый MP4/WebM-поток, а не плейлист, HTML или JSON.");
      const headerSize=Number(headers?.get?.("content-length")),encoded=headers?.get?.("content-encoding");
      const size=options.size??response?.size??
        (!encoded&&Number.isSafeInteger(headerSize)&&headerSize>0?headerSize:undefined);
      const mime=options.mime||(contentType==="application/octet-stream"?"video/mp4":contentType)||"video/mp4";
      const descriptor=describe(null,{...options,category:"video",mime,size,signal:task.signal});
      return await enqueue(context,()=>ingest(descriptor,response.body,context));
    }catch(error){try{await response?.body?.cancel?.();}catch{}throw error;}
    finally{task.cleanup();}
  }
  async function mutateCatalog(change){
    const context=capture();
    return enqueue(context,async()=>{
      const next=await change(getSession().catalog);
      await commit(next,context);
      return next;
    });
  }
  function cancel(){for(const controller of active)controller.abort();}
  function getState(){
    const current=getSession();
    return {signedIn:!!current.user,admin:!!current.admin,driveConnected:!!current.token,
      unlocked:!!current.catalog,libraryId:current.libraryId||"",uploading:active.size>0};
  }
  return Object.freeze({uploadFiles,importStream,importVideo,mutateCatalog,cancel,getState});
}
