import test from "node:test";
import assert from "node:assert/strict";
import {parseSource,toCard,lookupTitles,episodeMetadata,validateSavedEntry} from "../src/metadata.js";
test("source allowlist and URL parsing prevent arbitrary fetches",()=>{
 assert.equal(parseSource("https://animelib.me/ru/anime/attack-on-titan").sourceName,"AnimeLIB");
 assert.equal(parseSource("https://yummyanime.tv/anime/one-piece").query,"one piece");
 assert.equal(parseSource("https://ru.yummyani.me/anime/sousou-no-frieren/episodes/1").query,"sousou no frieren");
 assert.equal(parseSource("https://ru.yummyani.me/catalog/item/blich").query,"blich");
 assert.equal(parseSource("https://animelib.me/ru/anime/frieren-season-2/episodes/3").query,"frieren season 2");
 assert.equal(parseSource("Наруто").query,"Наруто");
 assert.throws(()=>parseSource("http://animelib.me/anime/naruto"),/HTTPS/);
 assert.throws(()=>parseSource("https://animelib.me.evil.test/anime/naruto"),/Поддерживаются/);
});
test("normalize public metadata and avoid invented episodes",()=>{
 const c=toCard({mal_id:12,title:"Test title",synopsis:"A story",images:{webp:{large_image_url:"https://cdn.myanimelist.net/x.jpg"}},episodes:null});
 assert.equal(c.id,12);assert.equal(c.episodes,null);assert.equal(c.description,"A story");
});
test("search and episode list parse expected REST payload",async()=>{
 const orig=globalThis.fetch,urls=[];
 try{
  globalThis.fetch=async url=>{urls.push(url);return {ok:true,json:async()=>url.includes("/episodes?")?
    {data:[{mal_id:1,title:"Episode One"}],pagination:{has_next_page:true}}:
    {data:[{mal_id:20,title:"Found"}]}}};
  const out=await lookupTitles("Frieren");assert.equal(out.results[0].title,"Found");
  const eps=await episodeMetadata(20);assert.equal(eps.episodes[0].number,1);
  assert.equal(eps.hasNext,true);assert.equal(urls.length,3);
 }finally{globalThis.fetch=orig;}
});
test("saved metadata is bounded and does not accept arbitrary external poster hosts",()=>{
 const a=validateSavedEntry({id:11,title:"Example",description:"x".repeat(5000),image:"https://evil.test/pic.jpg",episodes:12,sourceUrl:"https://animelib.me/ru/anime/test"});
 assert.equal(a.description.length,4000);assert.equal(a.image,"");assert.equal(a.episodes,12);
});

test("Russian search uses Shikimori and localized posters",async()=>{
 const old=globalThis.fetch;const urls=[];
 try{
  globalThis.fetch=async url=>{urls.push(url);return {ok:true,json:async()=>[{
   id:20,name:"Naruto",russian:"Наруто",image:{original:"/system/animes/original/20.jpg"},
   episodes:220,score:"8.02",kind:"tv",aired_on:"2002-10-03"}]}};
  const out=await lookupTitles("Наруто");
  assert.equal(out.results[0].title,"Наруто");
  assert.match(out.results[0].image,/^https:\/\/shikimori\.one\/system\/animes/);
  assert.equal(out.results[0].episodes,220);
  assert.equal(urls.length,1);
 }finally{globalThis.fetch=old;}
});
