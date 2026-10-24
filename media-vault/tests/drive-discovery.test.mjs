import test from 'node:test';
import assert from 'node:assert/strict';
import {findLibraries} from '../drive.js';

test('library discovery follows pagination and restricts owner search to owned catalogs',async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(value,options)=>{
    const url=new URL(value);calls.push(url);
    assert.equal(options.headers.Authorization,'Bearer test-token');
    assert.equal(options.method,undefined,'Discovery must never write to Drive');
    assert.ok(url.searchParams.get('q').includes("'me' in owners"));
    const body=url.searchParams.has('pageToken')?{files:[{id:'second'}]}:{files:[{id:'first'}],nextPageToken:'next-page'};
    return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
  };
  try{
    assert.deepEqual(await findLibraries('test-token',{ownedOnly:true}),[{id:'first'},{id:'second'}]);
    assert.equal(calls.length,2);assert.equal(calls[1].searchParams.get('pageToken'),'next-page');
  }finally{globalThis.fetch=original;}
});

test('an API permission error is never reported as an empty Drive',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'Permission denied'}}),{status:403,headers:{'content-type':'application/json'}});
  try{await assert.rejects(()=>findLibraries('test-token'),error=>error.status===403&&error.message.includes('Permission denied'));}
  finally{globalThis.fetch=original;}
});
