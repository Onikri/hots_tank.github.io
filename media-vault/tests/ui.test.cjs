// Visual and interaction smoke test for production React assets. No Google credentials.
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'..');
let server,browser;
async function createServer(){
  server=http.createServer(async(req,res)=>{
    const u=new URL(req.url,'http://127.0.0.1');
    const relative=u.pathname.replace(/^\/media-vault\/?/,'')||'index.html';
    if(!u.pathname.startsWith('/media-vault/')||relative.includes('..')){res.writeHead(404).end();return;}
    let body,file;
    for(const dir of [path.join(ROOT,'dist'),ROOT]){
      const candidate=path.resolve(dir,relative);
      if(!candidate.startsWith(dir+path.sep))continue;
      try{body=await fs.readFile(candidate);file=candidate;break;}catch{}
    }
    if(!body){res.writeHead(404).end();return;}
    const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'}).end(body);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return 'http://127.0.0.1:'+server.address().port+'/media-vault/';
}
async function run(){
  const base=await createServer();
  browser=await chromium.launch({headless:true,args:['--no-sandbox'],executablePath:process.env.CHROMIUM_PATH||undefined});
  const output=path.join(ROOT,'test-output');await fs.mkdir(output,{recursive:true});
  for(const width of [320,390,768,1280]){
    const context=await browser.newContext({viewport:{width,height:860},reducedMotion:'reduce',serviceWorkers:'block'});
    await context.route('https://accounts.google.com/**',route=>route.fulfill({status:200,body:'window.google={accounts:{oauth2:{initTokenClient:()=>({requestAccessToken:()=>{}})}}};',contentType:'text/javascript'}));
    await context.route('https://cdn.jsdelivr.net/**',route=>route.fulfill({status:200,body:'',contentType:'text/javascript'}));
    const page=await context.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const response=await page.goto(base,{waitUntil:'domcontentloaded'});
    assert.equal(response.status(),200,'React page must load');
    await page.getByRole('heading',{name:/Твоя коллекция/}).waitFor();
    await page.locator('#libraryGrid .empty').waitFor({timeout:10000});
    await page.locator('button[aria-label="Фильтры и сортировка"]').click();
    await page.getByRole('dialog',{name:'Сортировка'}).waitFor();
    await page.getByRole('button',{name:'По названию'}).click();
    assert.equal(await page.locator('#sortSelect').inputValue(),'name');
    const manga=page.locator('.category-tabs [data-category=manga]');
    await manga.click();
    await page.waitForFunction(()=>document.querySelector('#sectionTitle').textContent==='Манга');
    const account=page.locator('.header-actions button[aria-label="Аккаунт"]');
    await account.click();
    await page.getByRole('dialog',{name:'Аккаунт'}).waitFor();
    assert.equal(await page.locator('.account-drawer .solid-button').isVisible(),true);
    await page.locator('.account-drawer button[aria-label="Закрыть"]').click();
    await page.getByRole('dialog',{name:'Аккаунт'}).waitFor({state:'hidden'});
    const size=await page.evaluate(()=>{
      const brand=document.querySelector('.mobile-only-header .brand-wordmark');
      const search=document.querySelector('.header-actions button[aria-label="Перейти к поиску"]');
      const a=brand?.getBoundingClientRect(),b=search?.getBoundingClientRect();
      return {viewport:innerWidth,scroll:document.documentElement.scrollWidth,
        brandRight:a?.right,searchLeft:b?.left};
    });
    assert.ok(size.scroll<=size.viewport+1,'No horizontal overflow at width '+width+': '+JSON.stringify(size));
    if(width<=760)assert.ok(size.brandRight<size.searchLeft,'Mobile header wordmark must not overlap the search control');
    assert.equal(await page.locator('.bottom-nav').isVisible(),width<=760);
    assert.equal(await page.locator('.desktop-rail').isVisible(),width>760);
    assert.deepEqual(errors,[],'No runtime errors at width '+width);
    await page.screenshot({path:path.join(output,`react-${width}.png`),fullPage:true});
    console.log('PASS UI',width,'px; controls, filter, category, account, no overflow');
    await context.close();
  }
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});