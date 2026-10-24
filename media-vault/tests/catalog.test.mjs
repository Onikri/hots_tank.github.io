import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCatalog,mergeCatalog,matchesFilters,providerUrl,safeImage} from '../src/catalog.js';

test('metadata providers merge the same MAL title and preserve multilingual aliases and real dates',()=>{
  const shiki=normalizeCatalog('shikimori',[{id:20,russian:'Наруто',name:'Naruto',kind:'tv',aired_on:'2002-10-03',episodes:220,rating:'pg_13',image:{original:'/system/animes/original/20.jpg'},url:'/animes/20',genres:[{name:'Action',russian:'Экшен'}]}]);
  const ani=normalizeCatalog('anilist',{data:{Page:{media:[{id:20,idMal:20,title:{english:'Naruto',native:'ナルト'},synonyms:['火影忍者','나루토'],genres:['Action'],isAdult:false,startDate:{year:2002,month:10,day:3},airingSchedule:{nodes:[{episode:3,airingAt:1900000000}]}}]}}});
  const result=mergeCatalog([...shiki,...ani]);
  assert.equal(result.length,1);assert.equal(result[0].title,'Наруто');
  for(const alias of ['Naruto','Наруто','ナルト','火影忍者','나루토'])assert.ok(result[0].aliases.includes(alias));
  assert.equal(result[0].releases[0].episode,3);assert.equal(result[0].releases[0].date,new Date(1900000000*1000).toISOString());
  assert.equal(result[0].age,13);assert.equal(ani[0].age,null,'A non-adult boolean does not imply a specific certification');
  assert.equal(matchesFilters(result[0],{year:'2002',genre:'экшен'}),true);
  assert.equal(matchesFilters(result[0],{year:'2003'}),false);
});
test('Kitsu data produces real covers, genres and plain descriptions; dangerous image protocols are rejected',()=>{
  const [item]=normalizeCatalog('kitsu',{data:[{type:'manga',id:'1',attributes:{canonicalTitle:'物語',titles:{en:'Story',ja_jp:'物語'},synopsis:'<b>A story</b><script>bad()</script>',posterImage:{large:'javascript:bad()'},startDate:'2020-01-01',ageRating:'R18',chapterCount:12},relationships:{genres:{data:[{type:'genres',id:'2'}]}}}],included:[{type:'genres',id:'2',attributes:{name:'Fantasy'}}]},'manga');
  assert.equal(item.cover,'');assert.ok(!item.description.includes('<'));assert.deepEqual(item.genres,['Fantasy']);assert.equal(item.age,18);assert.equal(item.chapters,12);
  assert.equal(safeImage('https://user:password@example.com/a.jpg'),'');
});
test('matching names in different years or media types do not collapse into one title',()=>{
  const records=normalizeCatalog('imdb',{d:[{id:'tt1',l:'Example',qid:'movie',y:2001},{id:'tt2',l:'Example',qid:'movie',y:2020},{id:'tt3',l:'Example',qid:'tvSeries',y:2020}]},'movie');
  assert.equal(mergeCatalog(records).length,3);
  const url=new URL(providerUrl('kitsu',{query:'나루토 火影忍者',kind:'manga'}));assert.equal(url.searchParams.get('filter[text]'),'나루토 火影忍者');
  const relay=new URL(providerUrl('imdb',{query:'Матрица',kind:'movie',server:'https://import.example.com'}));assert.equal(relay.pathname,'/metadata/imdb');assert.equal(relay.searchParams.get('q'),'Матрица');
});
