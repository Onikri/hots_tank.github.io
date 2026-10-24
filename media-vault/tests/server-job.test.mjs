import test from 'node:test';
import assert from 'node:assert/strict';
import {buildServerJob,validateEpisodeSelection,publicSourceUrl,NOTEBOOK_URL} from '../src/server-job.js';

test('server job contains only control information, never credentials or keys',()=>{
  const job=buildServerJob({libraryId:'catalog-test',urls:'https://example.com/season#player\nhttps://example.com/season',
    collection:'  Сезон 1  ',episodes:'1, 3-8',quality:'720',token:'DO-NOT-EXPORT',passphrase:'PRIVATE',key:{private:true}});
  assert.deepEqual(job,{version:1,library_id:'catalog-test',sources:['https://example.com/season'],collection:'Сезон 1',season:1,episodes:'1,3-8',quality:'720',resume:true});
  assert.ok(NOTEBOOK_URL.endsWith('/media-vault/notebooks/MediaVault_Server_Import.ipynb'));
});

test('job rejects local URLs, missing libraries, malformed episode ranges and quality',()=>{
  for(const url of ['http://example.com/video','https://user:password@example.com/video','https://127.0.0.1/a','https://localhost/a','https://[::1]/a','https://example.com:999/a'])assert.throws(()=>publicSourceUrl(url));
  for(const value of ['0','9-2','1,,2','1-99999','<script>'])assert.throws(()=>validateEpisodeSelection(value));
  assert.equal(validateEpisodeSelection('все'),'all');
  assert.throws(()=>buildServerJob({libraryId:'',urls:'https://example.com/'}));
  assert.throws(()=>buildServerJob({libraryId:'catalog',urls:'https://example.com/',quality:'4k'}));
});
