const assert=require('node:assert/strict');
const catalogueHosts=/https:\/\/(?:kitsu\.io|shikimori\.one|graphql\.anilist\.co|api\.jikan\.moe|api\.tvmaze\.com|www\.wikidata\.org)\//;
const cors={'access-control-allow-origin':'*','access-control-allow-headers':'*'};
const title=(id,name,resource='anime')=>({id:String(id),type:resource,attributes:{canonicalTitle:name,titles:{en:name},subtype:resource==='manga'?'manga':'TV',startDate:'2020-01-01',episodeCount:12}});
const gate=()=>{let release;const promise=new Promise(resolve=>release=resolve);return {promise,release};};

module.exports=async function checkDynamicCatalogue(page){
  const requests=[],slow=gate(),late=gate();let retryAttempts=0;
  const route=async route=>{
    const url=new URL(route.request().url()),provider=url.hostname;
    const query=url.searchParams.get('filter[text]')||url.searchParams.get('search')||url.searchParams.get('q')||route.request().postDataJSON()?.variables?.search||'';
    requests.push({provider,query});let body={data:[]},status=200;
    if(provider==='graphql.anilist.co')body={data:{Page:{media:[]}}};
    if(provider==='shikimori.one'){
      body=[];
      if(query==='Star'){
        await late.promise;
        body=[{id:50,russian:'Star',name:'Star',kind:'tv',aired_on:'2021-01-01'}];
      }
    }
    if(provider==='kitsu.io'){
      const resource=url.pathname.includes('/manga')?'manga':'anime';
      let values=[];
      if(query==='Star'||/\/42$/.test(url.pathname))values=[title(42,'Star Quest')];
      if(query==='Old'){await slow.promise;values=[title(43,'Old result')];}
      if(query==='New')values=[title(44,'New result')];
      if(query==='Retry'){
        retryAttempts++;
        if(retryAttempts===1)status=503;else values=[title(45,'Recovered result')];
      }
      if(query==='ナルト')values=[title(46,'Japanese match')];
      if(query==='naruto')values=[title(20,'Naruto',resource)];
      if(query==='Typecheck')values=[title(60,'Typed '+resource,resource)];
      body={data:values};
    }
    await route.fulfill({status,headers:cors,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
  };
  await page.route(catalogueHosts,route);
  try{
    const input=page.locator('#catalogSearch');
    await input.fill('S');await input.fill('St');await input.fill('Star');
    await page.getByRole('option').filter({hasText:'Star Quest'}).waitFor();
    assert.ok(!requests.some(x=>['S','St'].includes(x.query)),'Only the settled query is requested');
    assert.equal(await input.getAttribute('aria-expanded'),'true','Typing opens predictions without Enter');
    await input.press('ArrowDown');late.release();
    await page.waitForFunction(()=>document.querySelector('[role=option] strong')?.textContent==='Star');
    assert.ok((await page.locator('[role=option][aria-selected=true]').innerText()).includes('Star Quest'),'Late results do not change the keyboard choice');
    await input.press('Enter');
    await page.getByRole('heading',{name:'Star Quest',exact:true}).waitFor();
    await page.getByRole('button',{name:'К результатам поиска'}).click();

    await input.fill('Old');
    await page.waitForRequest(request=>request.url().includes('filter%5Btext%5D=Old'));
    await input.fill('New');
    assert.equal(await page.locator('#catalogPredictions [role=option]').count(),0,'Stale predictions disappear immediately');
    await page.getByRole('option').filter({hasText:'New result'}).waitFor();
    slow.release();await page.waitForTimeout(100);
    assert.deepEqual(await page.locator('.catalog-card .media-name').allTextContents(),['New result'],'An old response cannot replace the new query');

    await input.fill('Retry');
    await page.getByRole('button',{name:'Повторить поиск'}).waitFor();
    await page.getByRole('button',{name:'Повторить поиск'}).click();
    await page.getByRole('button',{name:'Выбрать Recovered result',exact:true}).waitFor();
    assert.equal(retryAttempts,2,'Retry bypasses failed cached responses');

    await input.focus();await input.dispatchEvent('compositionstart');
    await input.fill('ナ');await page.waitForTimeout(400);
    assert.ok(!requests.some(x=>x.query==='ナ'),'IME intermediate text is not queried');
    await input.fill('ナルト');await input.dispatchEvent('compositionend',{data:'ナルト'});
    await page.getByRole('option').filter({hasText:'Japanese match'}).waitFor();
    await input.press('Escape');assert.equal(await input.getAttribute('aria-expanded'),'false');
    assert.equal(await input.getAttribute('aria-activedescendant'),null);

    await input.fill('НАРУТО');
    await page.getByRole('option').filter({hasText:'Naruto'}).waitFor();
    await page.getByText('Также ищем по написанию «naruto»',{exact:true}).waitFor();

    await input.fill('Typecheck');
    await page.getByRole('button',{name:'Выбрать Typed anime',exact:true}).waitFor();
    await page.locator('.catalog-kind-row').getByRole('button',{name:'Манга',exact:true}).click();
    await page.getByRole('button',{name:'Выбрать Typed manga',exact:true}).waitFor();
    assert.ok(!(await page.locator('.catalog-card .media-name').allTextContents()).includes('Typed anime'));
    await page.locator('.catalog-kind-row').getByRole('button',{name:'Фильмы',exact:true}).click();
    await page.getByText('Пока ничего не нашлось',{exact:true}).waitFor();
    await page.locator('.catalog-kind-row').getByRole('button',{name:'Аниме',exact:true}).click();
    await page.getByRole('button',{name:'Выбрать Typed anime',exact:true}).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Search has no horizontal overflow');
    console.log('PASS dynamic catalogue: debounce, partial results, ranking, stable keyboard selection, cancellation, retry, IME, Cyrillic fallback and type switches.');
  }finally{
    slow.release();late.release();await page.unroute(catalogueHosts,route);
  }
};
