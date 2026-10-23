// Local integration test: Google Identity and Drive are fake providers; no live credentials.
// Run: node media-vault/tests/browser.test.cjs (requires Playwright, Chromium and ffmpeg).
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {execFileSync} = require('node:child_process');
const {webcrypto, createHash} = require('node:crypto');
const {chromium} = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const OWNER = 'owner@example.test';
const READER = 'reader@example.test';
const PHRASE = 'integration test phrase only';
const files = new Map();
const writes = [];
let nextId = 0;
let server;
let browser;
let temp;
const cors = {'access-control-allow-origin':'*', 'access-control-allow-headers':'*', 'access-control-allow-methods':'*'};

function multipart(request) {
  const boundary = request.headers()['content-type'].match(/boundary=(.+)$/)[1];
  const body = request.postDataBuffer();
  const first = body.indexOf('\r\n\r\n') + 4;
  const divider = body.indexOf('\r\n--'+boundary, first);
  const dataStart = body.indexOf('\r\n\r\n', divider) + 4;
  const dataEnd = body.lastIndexOf('\r\n--'+boundary+'--');
  return {metadata:JSON.parse(body.subarray(first,divider).toString()), data:body.subarray(dataStart,dataEnd)};
}

async function installProvider(context, identity) {
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body,status=200) => route.fulfill({status, headers:cors, contentType:'application/json', body:JSON.stringify(body)});
    if(url.pathname === '/media-vault/config.js') return route.fulfill({contentType:'text/javascript',body:'window.MEDIA_VAULT_CONFIG=Object.freeze('+JSON.stringify({googleClientId:'123-test.apps.googleusercontent.com',adminEmailSha256:createHash('sha256').update(OWNER).digest('hex'),storageFolderId:'',applicationName:'MediaVault'})+');'});
    if(url.hostname === 'accounts.google.com') return route.fulfill({contentType:'text/javascript',body:`window.google={accounts:{oauth2:{initTokenClient(options){return {requestAccessToken(){window.__grants=(window.__grants||[]).concat(options.scope);options.callback({access_token:${JSON.stringify(identity)},expires_in:window.__tokenDuration||3600,scope:options.scope});}};},revoke(token,callback){callback?.({});}}}};`});
    if(url.hostname === 'cdn.jsdelivr.net') return route.fulfill({contentType:'text/javascript',body:''});
    if(url.hostname !== 'www.googleapis.com') return route.continue();
    if(request.method() === 'OPTIONS') return route.fulfill({status:204,headers:cors});
    const email = request.headers().authorization?.endsWith(READER) ? READER : OWNER;
    if(url.pathname === '/oauth2/v3/userinfo') return json({sub:email,email,email_verified:true,given_name:email===OWNER?'Owner':'Reader'});
    if(request.method() !== 'GET' && email === READER) return json({error:{message:'Reader cannot write'}},403);
    if(url.pathname.startsWith('/upload/drive/v3/files')) {
      writes.push({email,method:request.method(),url:url.pathname});
      if(request.method()==='POST') {
        const {metadata,data}=multipart(request);
        const id='file-'+(++nextId);
        files.set(id,{...metadata,id,data});
        return json({id,name:metadata.name});
      }
      const id=url.pathname.split('/').at(-1);
      const file=files.get(id);
      if(!file) return json({error:{message:'Missing file'}},404);
      file.data=request.postDataBuffer();
      return json({id});
    }
    if(url.pathname === '/drive/v3/files' && request.method()==='POST') {
      writes.push({email,method:'POST',url:url.pathname});
      const metadata=request.postDataJSON();
      const id='folder-'+(++nextId);
      files.set(id,{...metadata,id});
      return json({id,name:metadata.name});
    }
    const id=url.pathname.split('/')[4];
    const file=files.get(id);
    if(!file) return json({error:{message:'Missing file'}},404);
    if(url.pathname.endsWith('/permissions')) {
      writes.push({email,method:request.method(),url:url.pathname});
      return json({id:'reader-permission'});
    }
    if(url.searchParams.get('alt')==='media') return route.fulfill({headers:cors,contentType:'application/octet-stream',body:file.data});
    return json({...file,data:undefined,capabilities:{canAddChildren:email===OWNER,canEdit:email===OWNER},owners:[{emailAddress:OWNER,me:email===OWNER}]});
  });
}

async function signIn(page) {
  await page.locator('.header-actions button[aria-label="Аккаунт"]').click();
  await page.locator('.account-drawer').waitFor({state:'visible'});
  await page.locator('.account-drawer .solid-button').click();
  await page.waitForFunction(()=>document.querySelector('#loginBtn').disabled);
  await page.locator('.account-drawer .solid-button').click();
  await page.locator('#setupPanel').waitFor({state:'visible'});
  await page.locator('.account-drawer').waitFor({state:'hidden'});
  assert.equal(await page.locator('#driveBtn').isVisible(),true,'Drive reconnect remains available');
}

async function decryptCatalog(file) {
  const envelope=JSON.parse(file.data.toString());
  const raw=await webcrypto.subtle.importKey('raw',Buffer.from(PHRASE),'PBKDF2',false,['deriveKey']);
  const key=await webcrypto.subtle.deriveKey({name:'PBKDF2',salt:Buffer.from(envelope.salt,'base64'),iterations:310000,hash:'SHA-256'},raw,{name:'AES-GCM',length:256},false,['decrypt']);
  const data=await webcrypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(envelope.iv,'base64'),additionalData:Buffer.from('mediavault-catalog-v1')},key,Buffer.from(envelope.data,'base64'));
  return JSON.parse(Buffer.from(data).toString());
}

async function main() {
  temp=await fs.mkdtemp(path.join(os.tmpdir(),'mediavault-browser-'));
  const mp4=path.join(temp,'sample.mp4');
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=32x32:d=2:r=10','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-y',mp4]);
  server=http.createServer(async(req,res)=>{
    try {
      const pathname=new URL(req.url,'http://localhost').pathname;
      const relative=pathname.replace(/^\/media-vault\/?/,'')||'index.html';
      if(!pathname.startsWith('/media-vault/')||relative.includes('..'))throw Error('Invalid path');
      let file=path.resolve(ROOT,'media-vault','dist',relative);
      let body;
      try{body=await fs.readFile(file);}catch{
        file=path.resolve(ROOT,'media-vault',relative);
        body=await fs.readFile(file);
      }
      const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
      res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});res.end(body);
    } catch {res.writeHead(404);res.end('Not found');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port+'/media-vault/';
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const ownerContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'allow'});
  await installProvider(ownerContext,OWNER);
  const owner=await ownerContext.newPage();
  await owner.goto(base);
  await signIn(owner);
  await owner.locator('#passphrase').fill(PHRASE);
  await owner.locator('#passphraseAgain').fill(PHRASE);
  await owner.locator('#createBtn').click();
  await owner.locator('#adminPanel').waitFor({state:'visible'});
  const catalogId=await owner.evaluate(()=>localStorage.getItem('mediavault_library'));
  assert.ok(catalogId,'Catalog ID saved');
  await owner.locator('#filesInput').setInputFiles([
    {name:'private-note.txt',mimeType:'text/plain',buffer:Buffer.from('Encrypted hello from mobile')},
    {name:'private-image.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+kkAAAAASUVORK5CYII=','base64')},
    {name:'private-video.mp4',mimeType:'video/mp4',buffer:await fs.readFile(mp4)}
  ]);
  await owner.waitForFunction(()=>document.querySelector('#count').textContent==='3 файлов',null,{timeout:30000});
  assert.equal(await owner.locator('#uploadQueue').innerText().then(s=>(s.match(/✓/g)||[]).length),3,'All three files uploaded');
  const catalog=await decryptCatalog(files.get(catalogId));
  assert.equal(catalog.items.length,3);
  assert.equal(files.get(catalog.folderId).mimeType,'application/vnd.google-apps.folder','First launch creates a folder in the signed-in owner Drive');
  for(const item of catalog.items) {
    assert.ok(!files.get(catalogId).data.includes(Buffer.from(item.name)),'Catalog encrypts filenames');
    for(const chunk of item.chunks) assert.ok(!files.get(chunk.fileId).data.includes(Buffer.from('Encrypted hello')),'Stored chunk is encrypted');
  }
  await owner.locator('.media-card').filter({hasText:'private-note.txt'}).click();
  await owner.locator('#viewerContent pre').waitFor();
  assert.equal(await owner.locator('#viewerContent pre').innerText(),'Encrypted hello from mobile');
  await owner.locator('#closeViewer').click();
  await owner.locator('.media-card').filter({hasText:'private-image.png'}).click();
  await owner.waitForFunction(()=>document.querySelector('#viewerContent img')?.naturalWidth===1);
  await owner.locator('#closeViewer').click();
  await owner.locator('.media-card').filter({hasText:'private-video.mp4'}).click();
  await owner.waitForFunction(()=>document.querySelector('#viewerContent video')?.readyState>=2);
  assert.equal(await owner.locator('video').evaluate(video=>Math.round(video.duration)),2,'Service Worker streams playable MP4');
  await owner.getByRole('button',{name:'Загрузить файл целиком (резервный режим)'}).click();
  await owner.waitForFunction(()=>document.querySelector('#viewerContent video')?.readyState>=2);
  assert.equal(await owner.locator('video').evaluate(video=>Math.round(video.duration)),2);
  await owner.locator('video').evaluate(video=>video.currentTime=1);
  await owner.waitForFunction(()=>document.querySelector('video').currentTime>=1);
  await owner.locator('#closeViewer').click();
  assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile viewport has no horizontal overflow');
  await owner.screenshot({path:path.join(temp,'mobile-owner.png'),fullPage:true});
  await owner.reload();
  await signIn(owner);
  await owner.locator('#passphrase').fill('deliberately wrong phrase');
  await owner.locator('#unlockBtn').click();
  await owner.waitForFunction(()=>document.querySelector('#status').textContent==='Ошибка открытия');
  assert.equal(await owner.locator('#adminPanel').isVisible(),false,'Wrong phrase does not open library');
  await owner.locator('#passphrase').fill(PHRASE);
  await owner.locator('#unlockBtn').click();
  await owner.locator('#adminPanel').waitFor({state:'visible'});
  await owner.waitForFunction(()=>document.querySelectorAll('.media-card').length===3);
  await owner.evaluate(()=>window.__tokenDuration=16);
  await owner.locator('#driveBtn').click();
  await owner.waitForFunction(()=>document.querySelector('#status').textContent==='Обнови доступ к Drive');
  await owner.evaluate(()=>window.__tokenDuration=3600);
  await owner.locator('#driveBtn').click();
  await owner.waitForFunction(()=>document.querySelector('#status').textContent.includes('библиотека открыта'));
  assert.equal(await owner.locator('#setupPanel').isVisible(),false,'Reconnect preserves unlocked library without another phrase');
  assert.equal(await owner.locator('.media-card').count(),3);
  const cdp=await ownerContext.newCDPSession(owner);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  const streamed=await owner.evaluate(async id=>{
    const response=await fetch('./__media__/'+id,{headers:{Range:'bytes=-16'}});
    return {status:response.status,data:Array.from(new Uint8Array(await response.arrayBuffer()))};
  },catalog.items.find(item=>item.name==='private-video.mp4').id);
  assert.equal(streamed.status,206,'Worker restores session after being stopped');
  assert.deepEqual(Buffer.from(streamed.data),(await fs.readFile(mp4)).subarray(-16),'Restarted worker returns exact decrypted suffix');
  const writesBefore=writes.length;
  const readerContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'allow'});
  await installProvider(readerContext,READER);
  const reader=await readerContext.newPage();
  await reader.goto(base+'?library='+catalogId);
  await signIn(reader);
  assert.equal(await reader.locator('#createBtn').isVisible(),false);
  await reader.locator('#passphrase').fill(PHRASE);
  await reader.locator('#unlockBtn').click();
  await reader.waitForFunction(()=>document.querySelectorAll('.media-card').length===3);
  assert.equal(await reader.locator('#adminPanel').isVisible(),false);
  assert.equal(await reader.locator('#uploadBtn').isVisible(),false);
  await reader.locator('.media-card').filter({hasText:'private-note.txt'}).click();
  await reader.locator('#viewerContent pre').waitFor();
  assert.equal(await reader.locator('#viewerContent pre').innerText(),'Encrypted hello from mobile');
  const scopes=await reader.evaluate(()=>window.__grants);
  assert.ok(scopes.some(scope=>scope.includes('/auth/drive.readonly')));
  assert.ok(!scopes.some(scope=>/\/auth\/drive(?:\s|$)/.test(scope)));
  assert.equal(writes.length,writesBefore,'Reader operations produce no Drive writes');
  const forbidden=await reader.evaluate(async token=>(await fetch('https://www.googleapis.com/drive/v3/files',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'})).status,READER);
  assert.equal(forbidden,403,'Fake Drive provider enforces reader ACL');
  console.log('PASS: mocked Google login; encrypted catalog/TXT/PNG/MP4 upload; mobile text/image/streaming MP4/fallback and seek; wrong/correct phrase after refresh; expiring token/reconnect; stopped worker recovery; reader scopes and UI; no reader writes.');
  console.log('Screenshot: '+path.join(temp,'mobile-owner.png'));
  console.log('Live Google OAuth, real Drive ACL and physical Android/iOS playback remain outside this test.');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
