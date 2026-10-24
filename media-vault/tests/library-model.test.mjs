import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadPlacement,buildTitles,titleParts,sectionForItem} from '../src/library-model.js';

test('directory upload separates section, title and season instead of making one title per season',()=>{
  assert.deepEqual(uploadPlacement({name:'01.mp4',category:'video',sourcePath:'Аниме/Наруто/Сезон 1/01.mp4'}),{section:'anime',collectionName:'Наруто',partName:'Сезон 1'});
  assert.deepEqual(uploadPlacement({name:'02.cbz',category:'manga',sourcePath:'MediaVault/Манга/Наруто/Том 2/02.cbz'}),{section:'manga',collectionName:'Наруто',partName:'Том 2'});
  assert.deepEqual(uploadPlacement({name:'Том 1.epub',category:'book',sourcePath:'Ранобэ/Мой тайтл/Том 1.epub'}),{section:'ranobe',collectionName:'Мой тайтл',partName:''});
  assert.equal(uploadPlacement({name:'novel.epub',category:'book',section:'ranobe',collection:'Пример'}).section,'ranobe');
  assert.equal(uploadPlacement({name:'novel.epub',category:'book',section:'book',collection:'Пример'}).section,'book');
  assert.throws(()=>uploadPlacement({name:'movie.mp4',category:'video',section:'ranobe'}));
});

test('title browsing groups episodes and volumes, keeps matching names in separate sections, and reads old catalogs',()=>{
  const catalog={folderId:'root',storage:{collections:[{id:'anime',name:'Наруто',section:'anime',parts:[{id:'s1',name:'Сезон 1'},{id:'s2',name:'Сезон 2'}]},{id:'manga',name:'Наруто',section:'manga'}]},items:[
    {id:'a2',collectionId:'anime',section:'anime',category:'video',partId:'s1',episode:2,name:'02.mp4',size:10},
    {id:'a1',collectionId:'anime',section:'anime',category:'video',partId:'s1',episode:1,name:'01.mp4',size:10},
    {id:'a3',collectionId:'anime',section:'anime',category:'video',partId:'s2',episode:1,name:'01.mp4',size:10},
    {id:'m1',collectionId:'manga',section:'manga',category:'manga',name:'Том 1.cbz',size:20},
    {id:'old',category:'book',name:'Old.txt',size:4}]};
  const before=JSON.stringify(catalog),titles=buildTitles(catalog);
  assert.equal(titles.length,3);assert.equal(titles[0].size,30);
  assert.deepEqual(titleParts(titles[0]).map(part=>[part.name,part.items.map(item=>item.id)]),[['Сезон 1',['a1','a2']],['Сезон 2',['a3']]]);
  assert.notEqual(titles[0].id,titles[1].id);assert.equal(titles[2].name,'Old');
  assert.equal(sectionForItem({category:'video',importFingerprint:'old-import'}),'anime');
  assert.equal(JSON.stringify(catalog),before,'Reading the old catalog must not rewrite or move existing data');
});
