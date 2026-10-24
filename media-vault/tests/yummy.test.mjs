import test from "node:test";
import assert from "node:assert/strict";
import {parseYummyLink,normalizeYummyTitle,normalizeYummyVideos,getYummyAnime} from "../src/yummy-api.js";
test("allowlisted YummyAnime URLs and safe slug",()=>{
 assert.equal(parseYummyLink("https://ru.yummyani.me/catalog/item/blich").alias,"blich");
 assert.throws(()=>parseYummyLink("https://ru.yummyani.me.attacker.test/catalog/item/blich"),/не HTTPS/);
 assert.throws(()=>parseYummyLink("http://ru.yummyani.me/catalog/item/blich"),/не HTTPS/);
 assert.throws(()=>parseYummyLink("https://ru.yummyani.me/catalog/item/%2Fetc"),/идентификатор/);
});
test("normalize API title and only real episode records",()=>{
 const t=normalizeYummyTitle({response:{anime:{id:8,title:{ru:"Блич"},episodes_count:366}}});
 assert.equal(t.title,"Блич");assert.equal(t.episodes,366);
 const v=normalizeYummyVideos({response:{videos:[{id:13,name:"Озвучка",episodes:[{number:1,title:"Первая серия"}],url:"https://ru.yummyani.me/video/13"}]}});
 assert.equal(v[0].episodes[0].title,"Первая серия");assert.equal(v[0].episodeCount,1);
});
test("official endpoints and required token",async()=>{
 const prev=globalThis.fetch, calls=[];
 try{
  globalThis.fetch=async (u,opts)=>{calls.push([u,opts.headers]);return {ok:true,json:async()=>u.includes("/videos")?
   {response:{videos:[{id:1,name:"Source"}]}}:{response:{anime:{id:123,title:{ru:"Аниме"}}}}};};
  const data=await getYummyAnime("https://ru.yummyani.me/catalog/item/my-anime","public-token");
  assert.equal(data.title.title,"Аниме");
  assert.equal(calls.length,2);
  assert.equal(calls[1][0],"https://api.yani.tv/anime/123/videos");
  assert.equal(calls[0][1]["X-Application"],"public-token");
  await assert.rejects(getYummyAnime("https://ru.yummyani.me/catalog/item/my-anime",""),/токен/);
 }finally{globalThis.fetch=prev;}
});
