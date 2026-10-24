import test from "node:test";import assert from "node:assert/strict";
import {sourceUrl,seriesCounts,parsePageText} from "../src/yummy-html.js";
test("Yummy source URL allowlist",()=>{
 assert.equal(sourceUrl("https://ru.yummyani.me/catalog/item/blich"),"https://ru.yummyani.me/catalog/item/blich");
 assert.throws(()=>sourceUrl("https://ru.yummyani.me.evil.test/catalog/item/blich"),/HTTPS/);
 assert.throws(()=>sourceUrl("http://ru.yummyani.me/catalog/item/blich"),/HTTPS/);
 assert.throws(()=>sourceUrl("https://ru.yummyani.me/login"),/страница тайтла/);
});
test("visible episode counts are verified not fabricated",()=>{
 assert.deepEqual(seriesCounts("Озвучка 366 / 366 Плеер 366 / 366"),[{available:366,total:366}]);
 assert.deepEqual(seriesCounts("2500 / 2600"),[]);
 assert.equal(parsePageText("Количество серий\n366").total,366);
});
