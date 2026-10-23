import test from "node:test";
import assert from "node:assert/strict";
import {safeHls,normalizeEpisode,normalizeRelease,searchAniLibria,getAniLibriaRelease} from "../src/streaming.js";
test("HLS endpoint accepts HTTPS and rejects dangerous URLs",()=>{
 assert.equal(safeHls("https://cache.libria.fun/anime/series.m3u8"),"https://cache.libria.fun/anime/series.m3u8");
 for(const v of ["javascript:alert(1)","http://x.m3u8","ftp://example.com/x","https://localhost/video.m3u8","https://127.0.0.1/private",""]) assert.equal(safeHls(v),"");
});
test("AniLiberty release normalizer extracts only published streams",()=>{
 const ep=normalizeEpisode({ordinal:2,name:"Пробуждение",hls_720:"https://cache.libria.fun/2.m3u8"});
 assert.equal(ep.number,2);assert.equal(ep.title,"Пробуждение");
 assert.equal(ep.streams[0].quality,"720p");
 assert.equal(normalizeRelease({id:3,name:{main:"Русский тайтл"},episodes:[{ordinal:1,hls_480:"https://cache.libria.fun/1.m3u8"}]}).episodes.length,1);
});
test("search and detail use public API paths and handle responses",async()=>{
 const old=globalThis.fetch;const urls=[];
 try{
  globalThis.fetch=async url=>{urls.push(url);return {ok:true,json:async()=>url.includes("search")?[{id:34,name:{main:"Сказка"}}]:{id:34,name:{main:"Сказка"},episodes:[{ordinal:1,hls_480:"https://cache.libria.fun/1.m3u8"}]}}};
  const list=await searchAniLibria("naruto");assert.equal(list[0].title,"Сказка");
  const detail=await getAniLibriaRelease(34);assert.equal(detail.episodes.length,1);
  assert.match(urls[0],/app\/search\/releases/);assert.match(urls[1],/anime\/releases\/34/);
 }finally{globalThis.fetch=old;}
});
