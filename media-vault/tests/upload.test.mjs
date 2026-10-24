// Access checks complementary to upload.test.cjs; no Google credentials or live Drive.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createUploadService} from '../src/upload.js';

test('reader and already-cancelled sessions cannot start source downloads or Drive writes',async()=>{
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const session={generation:1,user:{email:'reader@example.test'},admin:false,token:'fake-token',
    tokenExpiresAt:Date.now()+3600000,key,salt:crypto.getRandomValues(new Uint8Array(16)),
    libraryId:'catalog',catalog:{version:1,folderId:'root',items:[]}};
  let requests=0;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{requests++;throw Error('No network operation should begin');};
  const service=createUploadService({getSession:()=>session,onCatalog:catalog=>{session.catalog=catalog;}});
  try{
    const options={sourceUrl:'https://media.example.test/video.mp4',name:'Video.mp4'};
    const fetcher=async()=>{requests++;throw Error('No source download should begin');};
    await assert.rejects(()=>service.importVideo(options,fetcher),/администратора/);
    await assert.rejects(()=>service.uploadFiles([new File(['private text'],'book.txt')]),/администратора/);
    session.admin=true;
    const abort=new AbortController();abort.abort();
    await assert.rejects(()=>service.importVideo({...options,signal:abort.signal},fetcher),{name:'AbortError'});
    assert.equal(requests,0);
  }finally{service.cancel();globalThis.fetch=originalFetch;}
});
