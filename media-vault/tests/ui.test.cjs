// Responsive smoke test for the restored React interface. Google is a fake provider.
// Run after npm run build; no account credentials or external catalog are needed.
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {chromium}=require('playwright');
const {createHash}=require('node:crypto');
const OWNER='owner@example.test';
const ROOT=path.resolve(__dirname,'..');
let server,browser;

async function run(){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mediavault-ui-'));
  const served=path.join(temp,'site');
  await fs.cp(path.join(ROOT,'dist'),served,{recursive:true});
  server=http.createServer(async(req,res)=>{
    try{
      const pathname=new URL(req.url,'http://localhost').pathname;
      if(!pathname.startsWith('/media-vault/'))throw Error('Invalid path');
      const relative=pathname.slice('/media-vault/'.length)||'index.html';
      const file=path.resolve(served,relative);
      if(!file.startsWith(served+path.sep))throw Error('Invalid path');
      const body=await fs.readFile(file);
      const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
      res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream'}).end(body);
    }catch{res.writeHead(404).end('Not found');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port+'/media-vault/';
  browser=await chromium.launch({headless:true,args:['--no-sandbox'],executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
  const output=path.join(ROOT,'test-output');await fs.mkdir(output,{recursive:true});
  for(const width of [320,390,768,1280]){
    const context=await browser.newContext({viewport:{width,height:860},reducedMotion:'reduce',serviceWorkers:'block'});
    context.setDefaultTimeout(20000);
    await context.route('**/media-vault/config.js',route=>route.fulfill({contentType:'text/javascript',body:'window.MEDIA_VAULT_CONFIG='+JSON.stringify({googleClientId:'test.apps.googleusercontent.com',adminEmailSha256:createHash('sha256').update(OWNER).digest('hex'),storageFolderId:''})}));
    await context.route('https://accounts.google.com/**',route=>route.fulfill({contentType:'text/javascript',body:`window.google={accounts:{oauth2:{initTokenClient:options=>({requestAccessToken(){options.callback({access_token:'ui-test-token',expires_in:3600,scope:options.scope})}})}}};`}));
    await context.route('https://www.googleapis.com/**',route=>route.fulfill({headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*'},contentType:'application/json',body:JSON.stringify(route.request().url().includes('/userinfo')?{sub:'owner',email:OWNER,email_verified:true,given_name:'Owner'}:{files:[]})}));
    await context.route('https://cdn.jsdelivr.net/**',route=>route.fulfill({contentType:'text/javascript',body:''}));
    await context.route(/https:\/\/(?:kitsu\.io|shikimori\.one|graphql\.anilist\.co|api\.jikan\.moe|api\.tvmaze\.com|www\.wikidata\.org)\//,route=>{
      const url=new URL(route.request().url());
      const body=url.hostname==='kitsu.io'?{data:[{id:'20',type:'anime',attributes:{canonicalTitle:'Naruto',titles:{en:'Naruto',ja_jp:'ナルト'},synopsis:'Test catalogue description',subtype:'TV',episodeCount:220,startDate:'2002-10-03',ageRating:'PG'}}]}:url.hostname==='graphql.anilist.co'?{data:{Page:{media:[]}}}:{data:[]};
      return route.fulfill({headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*'},contentType:'application/json',body:JSON.stringify(body)});
    });
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const response=await page.goto(base+(width===390?'#import':'#home'),{waitUntil:'domcontentloaded'});
    assert.equal(response.status(),200);
    if(width===390){
      await page.getByRole('heading',{name:'Каталог и импорт',exact:true}).waitFor();
      await page.goto(base+'#home',{waitUntil:'domcontentloaded'});
    }
    await page.getByRole('heading',{name:'Твоё пространство',exact:true}).waitFor();
    const noOverflow=async view=>{
      const size=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth,
        overflow:[...document.querySelectorAll('body *')].map(element=>({element:element.tagName+'.'+element.className,
          right:Math.round(element.getBoundingClientRect().right),width:Math.round(element.getBoundingClientRect().width)}))
          .filter(rect=>rect.width>0&&rect.right>innerWidth+1).slice(0,12)}));
      assert.ok(size.scroll<=size.viewport+1,view+' has no overflow at '+width+'px: '+JSON.stringify(size));
    };
    await noOverflow('Home');
    assert.equal(await page.locator('.bottom-nav').isVisible(),width<900);
    assert.equal(await page.locator('.desktop-nav').isVisible(),width>=900);
    await page.screenshot({path:path.join(output,'react-'+width+'.png'),fullPage:true});
    const nav=width<900?page.getByRole('navigation',{name:'Мобильная навигация'}):page.getByRole('navigation',{name:'Основная навигация'});
    await nav.getByRole('button',{name:'Библиотека',exact:true}).click();
    await page.getByRole('heading',{name:'Моя библиотека',exact:true}).waitFor();
    await page.locator('#searchInput').fill('Тестовый поиск');
    assert.equal(await page.locator('#searchInput').inputValue(),'Тестовый поиск');
    await page.getByRole('button',{name:'Манга',exact:true}).click();
    assert.ok((await page.locator('.chip-active').textContent()).includes('Манга'));
    await page.getByRole('button',{name:'Избранное',exact:true}).click();
    assert.ok((await page.locator('.chip-active').textContent()).includes('Избранное'));
    await noOverflow('Library');
    await nav.getByRole('button',{name:'Импорт',exact:true}).click();
    await page.getByRole('heading',{name:'Каталог и импорт',exact:true}).waitFor();
    await page.getByRole('button',{name:'Фильтры каталога',exact:true}).click();
    await noOverflow('Catalogue filters');
    await page.locator('#catalogSearch').fill('Наруто');
    await page.getByRole('option').first().waitFor();
    const popup=await page.locator('#catalogPredictions').boundingBox();
    const navBox=await page.locator('.bottom-nav').boundingBox();
    assert.ok(popup.y>=0&&popup.y+popup.height<=860-(navBox?.height||0),'Autocomplete stays inside the visible area at '+width+'px');
    await page.locator('#catalogSearch').press('ArrowDown');
    await page.locator('#catalogSearch').press('Enter');
    await page.getByRole('heading',{name:'Naruto',exact:true}).waitFor();
    assert.equal(await page.locator('#importVideoBtn').isDisabled(),true,'Locked users cannot start an import');
    await noOverflow('Catalogue title detail');
    await page.getByRole('button',{name:'К результатам поиска'}).click();
    await noOverflow('Server import');
    await page.screenshot({path:path.join(output,'import-'+width+'.png'),fullPage:true});
    if(width===390)await require('./catalog-browser.cjs')(page);
    await page.locator('#profileBtn').click();
    await page.getByRole('heading',{name:'Мой профиль',exact:true}).waitFor();
    assert.equal(await page.locator('#loginBtn').isVisible(),true);
    await noOverflow('Profile');
    await page.locator('#loginBtn').click();
    await page.locator('#createBtn').waitFor();
    assert.equal(await page.locator('#libraryId').count(),0);
    assert.equal(await page.locator('#driveBtn').isVisible(),false);
    await noOverflow('Automatic library setup');
    await page.screenshot({path:path.join(output,'setup-'+width+'.png'),fullPage:true});
    await nav.getByRole('button',{name:'История',exact:true}).click();
    await page.getByRole('heading',{name:'Недавно открытое',exact:true}).waitFor();
    await page.getByRole('heading',{name:'Здесь продолжится твоя история',exact:true}).waitFor();
    await noOverflow('History');
    assert.deepEqual(errors,[],'No runtime errors at '+width+'px');
    await context.close();
    console.log('PASS UI '+width+'px: restored home/library/profile/history, filters, search, responsive layout');
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
