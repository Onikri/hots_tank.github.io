// Local integration test: Google Identity and Drive are fake providers; no live credentials.
// Run: npm run test:browser (builds the production React app; requires Chromium).
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {execFileSync} = require('node:child_process');
const {webcrypto, createHash} = require('node:crypto');
const {chromium} = require('playwright');

const PROJECT = path.resolve(__dirname, '..');
const ROOT = path.join(PROJECT, 'dist');
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
    await (async()=>{
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
    if(url.pathname === '/drive/v3/files' && request.method()==='GET'){
      assert.ok(url.searchParams.get('q').includes("name = 'vault-catalog.enc.json'"));
      return json({files:[...files.values()].filter(file=>file.name==='vault-catalog.enc.json').map(file=>({id:file.id,name:file.name,ownedByMe:email===OWNER,modifiedTime:'2026-10-24T00:00:00Z',owners:[{emailAddress:OWNER}]}))});
    }
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
    })().catch(error=>{
      if(/Route is already handled|Target page, context or browser has been closed/i.test(error.message))return;
      throw error;
    });
  });
}

async function signIn(page) {
  await page.locator('#profileBtn').click();
  await page.locator('#loginBtn').click();
  await page.waitForFunction(()=>document.querySelector('#loginBtn').disabled);
  await page.locator('#setupPanel').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#setupPanel')?.getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('#driveBtn').isVisible(),false,'Drive connects with login; no extra connection click is required');
  assert.equal(await page.locator('#libraryId').count(),0,'Normal setup never asks the user for a Drive ID');
}

async function decryptCatalog(file) {
  const envelope=JSON.parse(file.data.toString());
  const raw=await webcrypto.subtle.importKey('raw',Buffer.from(PHRASE),'PBKDF2',false,['deriveKey']);
  const key=await webcrypto.subtle.deriveKey({name:'PBKDF2',salt:Buffer.from(envelope.salt,'base64'),iterations:310000,hash:'SHA-256'},raw,{name:'AES-GCM',length:256},false,['decrypt']);
  const data=await webcrypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(envelope.iv,'base64'),additionalData:Buffer.from('mediavault-catalog-v1')},key,Buffer.from(envelope.data,'base64'));
  return JSON.parse(Buffer.from(data).toString());
}

async function main() {
  if(!process.env.MEDIA_VAULT_SKIP_BUILD)execFileSync('npm',['run','build'],{cwd:PROJECT,stdio:'inherit'});
  temp=await fs.mkdtemp(path.join(os.tmpdir(),'mediavault-browser-'));
  const testRoot=path.join(temp,'site');
  await fs.cp(ROOT,testRoot,{recursive:true});
  const mp4=path.join(temp,'sample.mp4');
  // Two-second 32×32 H.264 fixture keeps this test independent of video encoders.
  await fs.writeFile(mp4,Buffer.from('AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAQgbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAA0t0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAgAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAIAAABAAAAAALDbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAUABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACbm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAi5zdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAACAAIABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2UlsBEAAAAMAQAAABQPEiWWAAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAA9kAAAAAAAAABhzdHRzAAAAAAAAAAEAAAAUAAAEAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAqGN0dHMAAAAAAAAAEwAAAAEAAAgAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAQAAAAAAIAAAQAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAUAAAAAQAAAGRzdHN6AAAAAAAAAAAAAAAUAAAC0QAAAA0AAAAMAAAADAAAAAwAAAATAAAADgAAAAwAAAAMAAAAEwAAAA4AAAAMAAAADAAAABMAAAAOAAAADAAAAAwAAAASAAAADgAAAAwAAAAUc3RjbwAAAAAAAAABAAAEUAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDMAAAAIZnJlZQAAA+FtZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTEwIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAG2WIhAAR//7n4/wKbXzEcTp2GPr31tds+/BvgQAAAAlBmiRsQR/+tcAAAAAIQZ5CeId/RsEAAAAIAZ5hdEN/TEAAAAAIAZ5jakN/TEEAAAAPQZpoSahBaJlMCCP//rXBAAAACkGehkURLDv/RsEAAAAIAZ6ldEN/TEEAAAAIAZ6nakN/TEAAAAAPQZqsSahBbJlMCCH//quAAAAACkGeykUVLDv/RsEAAAAIAZ7pdEN/TEAAAAAIAZ7rakN/TEAAAAAPQZrwSahBbJlMCH///quBAAAACkGfDkUVLDv/RsEAAAAIAZ8tdEN/TEEAAAAIAZ8vakN/TEAAAAAOQZszSahBbJlMCG///qsAAAAKQZ9RRRUsN/9MQQAAAAgBn3JqQ39MQA==','base64'));
  server=http.createServer(async(req,res)=>{
    try {
      const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/media-vault\//,'/');
      const file=path.join(testRoot,pathname.endsWith('/')?pathname+'index.html':pathname);
      if(!file.startsWith(testRoot+path.sep)) throw Error('Invalid path');
      const body=await fs.readFile(file);
      const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
      res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});res.end(body);
    } catch {res.writeHead(404);res.end('Not found');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port+'/media-vault/';
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const ownerContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'allow'});
  ownerContext.setDefaultTimeout(20000);
  await installProvider(ownerContext,OWNER);
  const owner=await ownerContext.newPage();
  await owner.goto(base);
  await owner.getByRole('heading',{name:'Твоё пространство',exact:true}).waitFor();
  await owner.screenshot({path:path.join(temp,'mobile-home.png'),fullPage:true});
  await signIn(owner);
  assert.equal(await owner.locator('#createBtn').isVisible(),true);
  assert.equal(await owner.locator('#unlockBtn').isVisible(),false,'First launch only asks to choose a phrase');
  assert.equal((await owner.evaluate(()=>window.__grants)).length,1,'One OAuth request connects identity and read access');
  await owner.locator('#passphrase').fill(PHRASE);
  await owner.locator('#passphraseAgain').fill(PHRASE);
  await owner.locator('#createBtn').click();
  await owner.locator('#adminPanel').waitFor({state:'visible'});
  await owner.locator('#showFilesBtn').click();
  const catalogId=await owner.evaluate(()=>localStorage.getItem('mediavault_library'));
  assert.ok(catalogId,'Catalog ID saved');
  assert.ok((await owner.evaluate(()=>window.__grants)).some(scope=>/\/auth\/drive(?:\s|$)/.test(scope)),'Creating the encrypted library obtains the owner write permission');
  await owner.locator('#filesInput').setInputFiles([
    {name:'private-note.txt',mimeType:'text/plain',buffer:Buffer.from('Encrypted hello from mobile')},
    {name:'private-image.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+kkAAAAASUVORK5CYII=','base64')},
    {name:'private-video.mp4',mimeType:'video/mp4',buffer:await fs.readFile(mp4)}
  ]);
  try{await owner.waitForFunction(()=>document.querySelectorAll('.media-card').length===3,null,{timeout:30000});}
  catch(error){
    console.error('Upload state:',await owner.locator('#uploadQueue').innerText(),await owner.locator('#toast').allTextContents());
    throw error;
  }
  const catalog=await decryptCatalog(files.get(catalogId));
  assert.equal(catalog.items.length,3);
  assert.equal(files.get(catalog.folderId).mimeType,'application/vnd.google-apps.folder','First launch creates a folder in the signed-in owner Drive');
  for(const item of catalog.items) {
    assert.ok(!files.get(catalogId).data.includes(Buffer.from(item.name)),'Catalog encrypts filenames');
    for(const chunk of item.chunks) assert.ok(!files.get(chunk.fileId).data.includes(Buffer.from('Encrypted hello')),'Stored chunk is encrypted');
  }
  const textItem=catalog.items.find(item=>item.name==='private-note.txt');
  // The automatic import sends only control data/key to the owner's server, never source bytes.
  const sourceRequests=[],submitted=[];let fakeTask=null;
  owner.on('request',request=>{if(new URL(request.url()).hostname==='source.example.com')sourceRequests.push(request.url());});
  await owner.route('https://import.example.com/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    const respond=(data,status=200)=>route.fulfill({status,headers:cors,contentType:'application/json',body:JSON.stringify(data)});
    if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
    if(url.pathname==='/health')return respond({application:'MediaVault',version:4,origin:new URL(base).origin,oauthConfigured:true});
    if(url.pathname==='/auth/session')return respond({token:'fixture-server-session',driveConnected:true,oauthConfigured:true});
    if(url.pathname==='/jobs'&&request.method()==='POST'){
      const body=request.postDataJSON();submitted.push(body);
      fakeTask={id:'task-1',created:Date.now()/1000,status:'queued',progress:{title:body.job.collection,total:2,saved:0,phase:'queued'}};
      return respond(fakeTask,202);
    }
    if(url.pathname==='/jobs/task-1/cancel'){fakeTask={...fakeTask,status:'cancelled'};return respond(fakeTask);}
    if(url.pathname==='/jobs')return respond({jobs:fakeTask?[fakeTask]:[]});
    if(url.pathname==='/sources/inspect')return respond({provider:'fixture',dubs:[],seasons:[],releases:[],episodes:[{number:1,url:'https://source.example.com/episode-1'},{number:3,url:'https://source.example.com/episode-3'}]});
    if(url.pathname.startsWith('/metadata/'))return respond({data:[]});
    return respond({detail:'Not found'},404);
  });
  await owner.getByRole('navigation',{name:'Мобильная навигация'}).getByRole('button',{name:'Импорт',exact:true}).click();
  await owner.locator('.server-settings > summary').click();
  await owner.locator('#importServer').fill('https://import.example.com');
  await owner.locator('.server-address-form').getByRole('button',{name:'Подключить',exact:true}).click();
  await owner.getByText('Drive подключён',{exact:true}).waitFor();
  await owner.getByRole('tab',{name:'По ссылке',exact:true}).click();
  await owner.locator('#streamUrl').fill('https://source.example.com/season');
  await owner.getByRole('button',{name:'Проверить',exact:true}).click();
  await owner.getByText('Найдено опубликованных файлов: 2.',{exact:false}).waitFor();
  await owner.locator('#serverCollection').fill('Мой сезон');
  await owner.getByRole('button',{name:'Диапазон',exact:true}).click();
  await owner.getByRole('spinbutton',{name:'Первая серия',exact:true}).fill('1');
  await owner.getByRole('spinbutton',{name:'Последняя серия',exact:true}).fill('3');
  await owner.locator('#importVideoBtn').click();
  await owner.getByRole('heading',{name:'Очередь импорта',exact:true}).waitFor();
  assert.equal(submitted.length,1);
  const serverJob=submitted[0].job;
  assert.equal(serverJob.version,2);assert.equal(serverJob.library_id,catalogId);assert.equal(serverJob.episodes,'1-3');
  assert.deepEqual(serverJob.entries.map(e=>e.number),[1,3]);
  assert.ok(!JSON.stringify(serverJob).includes(PHRASE));assert.ok(!JSON.stringify(serverJob).includes(OWNER));
  assert.equal(Buffer.from(submitted[0].vault_key,'base64').length,32,'Only the derived encryption key goes to the configured owner server');
  assert.deepEqual(sourceRequests,[],'The device never fetches source HTML, playlists or video during import');
  assert.equal(await owner.locator('#openColab').count(),0,'No manual notebook hand-off remains');
  await owner.getByRole('button',{name:'Остановить после файла'}).click();
  await owner.getByText('Остановлено',{exact:true}).waitFor();
  await owner.locator('#libraryNav').click();
  await owner.waitForFunction(()=>document.querySelectorAll('.media-card').length===3);
  const delayedPattern='**/drive/v3/files/'+textItem.chunks[0].fileId+'?alt=media';
  let releaseDownload,downloadStarted,downloadFailed;
  const downloadGate=new Promise(resolve=>releaseDownload=resolve);
  const downloading=new Promise((resolve,reject)=>{downloadStarted=resolve;downloadFailed=reject;});
  await owner.route(delayedPattern,async route=>{
    downloadStarted();await downloadGate;
    try{await route.fallback();}catch{} // Closing the viewer may already have aborted this request.
  });
  await owner.locator('.media-card').filter({hasText:'private-note.txt'}).click();
  const startTimer=setTimeout(()=>downloadFailed(Error('Viewer did not request the encrypted text chunk')),10000);
  try{await downloading;}finally{clearTimeout(startTimer);}
  await owner.locator('#closeViewer').click();
  releaseDownload();
  await owner.unroute(delayedPattern);
  assert.equal(await owner.locator('#viewer').isVisible(),false,'Closing during a download leaves the viewer closed');
  await owner.locator('.media-card').filter({hasText:'private-note.txt'}).click();
  await owner.locator('#viewerContent pre').waitFor();
  assert.equal(await owner.locator('#viewerContent pre').innerText(),'Encrypted hello from mobile');
  await owner.locator('#closeViewer').click();
  await owner.locator('.media-card').filter({hasText:'private-image.png'}).click();
  await owner.waitForFunction(()=>document.querySelector('#viewerContent img')?.naturalWidth===1);
  await owner.keyboard.press('Escape');
  assert.equal(await owner.locator('#viewer').isVisible(),false,'Escape closes the React viewer');
  await owner.locator('.media-card').filter({hasText:'private-video.mp4'}).click();
  await owner.waitForFunction(()=>document.querySelector('#viewerContent video')?.readyState>=2);
  assert.equal(await owner.locator('video').evaluate(video=>Math.round(video.duration)),2,'Service Worker streams playable MP4');
  await owner.getByRole('button',{name:'Загрузить файл целиком (резервный режим)'}).click();
  await owner.waitForFunction(()=>document.querySelector('#viewerContent video')?.readyState>=2);
  assert.equal(await owner.locator('video').evaluate(video=>Math.round(video.duration)),2);
  await owner.locator('video').evaluate(video=>video.currentTime=1);
  await owner.waitForFunction(()=>document.querySelector('video').currentTime>=1);
  await owner.locator('#closeViewer').click();
  await owner.locator('#searchInput').fill('private-note');
  await owner.waitForFunction(()=>document.querySelectorAll('.media-card').length===1);
  assert.ok((await owner.locator('.media-card').innerText()).includes('private-note.txt'),'Search filters real catalog entries');
  await owner.locator('#searchInput').fill('no-such-file');
  await owner.getByRole('heading',{name:'Ничего не нашлось'}).waitFor();
  await owner.locator('#searchInput').fill('');
  await owner.getByRole('button',{name:'Видео',exact:true}).click();
  await owner.waitForFunction(()=>document.querySelectorAll('.media-card').length===1);
  assert.ok((await owner.locator('.media-card').innerText()).includes('private-video.mp4'),'Category filter selects video');
  await owner.getByRole('button',{name:'Всё',exact:true}).click();
  await owner.locator('.media-card').filter({hasText:'private-note.txt'}).getByRole('button',{name:'В избранное'}).click();
  await owner.getByRole('button',{name:'Избранное',exact:true}).click();
  assert.equal(await owner.locator('.media-card').count(),1,'Favorites show only bookmarked material');
  assert.ok((await owner.locator('.media-card').innerText()).includes('private-note.txt'));
  await owner.getByRole('button',{name:'Всё',exact:true}).click();
  await owner.getByRole('combobox',{name:'Порядок материалов'}).selectOption('name');
  assert.deepEqual(await owner.locator('.media-name').allTextContents(),['private-image.png','private-note.txt','private-video.mp4'],'Name sort orders the library');
  await owner.getByRole('navigation',{name:'Мобильная навигация'}).getByRole('button',{name:'История',exact:true}).click();
  assert.equal(await owner.locator('.history-item').count(),3,'History records the three opened files');
  await owner.locator('.history-item').filter({hasText:'private-note.txt'}).click();
  await owner.locator('#viewerContent pre').waitFor();
  await owner.locator('#closeViewer').click();
  await owner.locator('#libraryNav').click();
  assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile viewport has no horizontal overflow');
  await owner.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
  await owner.screenshot({path:path.join(temp,'mobile-owner.png'),fullPage:true});
  await owner.reload();
  await signIn(owner);
  await owner.locator('#passphrase').fill('deliberately wrong phrase');
  await owner.locator('#unlockBtn').click();
  await owner.getByText('Неверная секретная фраза или повреждённый каталог.',{exact:true}).waitFor();
  assert.equal(await owner.locator('#adminPanel').isVisible(),false,'Wrong phrase does not open library');
  await owner.locator('#passphrase').fill(PHRASE);
  await owner.locator('#unlockBtn').click();
  await owner.locator('#adminPanel').waitFor({state:'visible'});
  await owner.waitForFunction(()=>document.querySelectorAll('.media-card').length===3);
  await owner.getByRole('button',{name:'Избранное',exact:true}).click();
  assert.equal(await owner.locator('.media-card').count(),1,'Favorites persist after refresh and unlocking');
  await owner.getByRole('button',{name:'Всё',exact:true}).click();
  await owner.locator('#profileBtn').click();
  await owner.evaluate(()=>window.__tokenDuration=16);
  await owner.locator('#driveBtn').click();
  await owner.waitForFunction(()=>document.querySelectorAll('.media-card').length===3);
  await owner.locator('#profileBtn').click();
  await owner.waitForFunction(()=>document.querySelector('#driveBtn')?.textContent.includes('заново'));
  await owner.evaluate(()=>window.__tokenDuration=3600);
  await owner.locator('#driveBtn').click();
  await owner.waitForFunction(()=>document.querySelectorAll('.media-card').length===3);
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
  readerContext.setDefaultTimeout(20000);
  await installProvider(readerContext,READER);
  const reader=await readerContext.newPage();
  await reader.goto(base+'?library='+catalogId);
  await signIn(reader);
  assert.equal(await reader.locator('#createBtn').isVisible(),false);
  await reader.locator('#passphrase').fill(PHRASE);
  await reader.locator('#unlockBtn').click();
  await reader.locator('#showFilesBtn').click();
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
  const directory=path.join(temp,'Private folder');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory,'directory-note.txt'),'Encrypted directory picker test');
  await owner.locator('#foldersInput').setInputFiles(directory);
  await owner.waitForFunction(()=>document.querySelectorAll('.media-card').length===4);
  const folderCatalog=await decryptCatalog(files.get(catalogId));
  const folderItem=folderCatalog.items.find(item=>item.name==='directory-note.txt');
  assert.equal(folderItem.sourcePath,'Private folder/directory-note.txt');
  assert.equal(folderCatalog.storage.collections.find(entry=>entry.id===folderItem.collectionId).name,'Private folder');
  assert.ok(!files.get(catalogId).data.includes(Buffer.from('Private folder')),'Directory names also stay encrypted');
  // A new phone/browser has no saved ID and must find the existing vault itself.
  const freshContext=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'allow'});
  await installProvider(freshContext,OWNER);
  const fresh=await freshContext.newPage();
  await fresh.goto(base);
  assert.equal(await fresh.evaluate(()=>localStorage.getItem('mediavault_library')),null);
  const writesBeforeDiscovery=writes.length;
  await signIn(fresh);
  assert.equal(await fresh.evaluate(()=>localStorage.getItem('mediavault_library')),catalogId,'A new device discovers and remembers the existing catalog');
  assert.equal(await fresh.locator('#createBtn').isVisible(),false,'Discovery prevents accidental duplicate creation');
  assert.equal(writes.length,writesBeforeDiscovery,'Login and discovery perform no Drive writes');
  await fresh.locator('#passphrase').fill(PHRASE);
  await fresh.locator('#unlockBtn').click();
  await fresh.locator('#showFilesBtn').click();
  await fresh.waitForFunction(()=>document.querySelectorAll('.media-card').length===4);
  assert.equal(writes.length,writesBeforeDiscovery,'Opening a library does not need write access');
  assert.equal((await fresh.evaluate(()=>window.__grants)).length,1,'An existing library opens after a single Google sign-in');
  await fresh.locator('#filesInput').setInputFiles([{name:'new-device.txt',mimeType:'text/plain',buffer:Buffer.from('New device upload')}]);
  await fresh.waitForFunction(()=>document.querySelectorAll('.media-card').length===5);
  assert.ok((await fresh.evaluate(()=>window.__grants)).some(scope=>/\/auth\/drive(?:\s|$)/.test(scope)),'First modification requests owner write permission automatically');
  await freshContext.close();
  // A failed Drive scan must not be mistaken for an empty account.
  const blockedContext=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await installProvider(blockedContext,OWNER);
  let blockDiscovery=true;
  await blockedContext.route('https://www.googleapis.com/drive/v3/files?**',route=>{
    if(blockDiscovery&&route.request().method()==='GET')return route.fulfill({status:403,headers:cors,contentType:'application/json',body:JSON.stringify({error:{message:'Drive API disabled fixture'}})});
    return route.fallback();
  });
  const blocked=await blockedContext.newPage();await blocked.goto(base);
  const writesBeforeError=writes.length;
  await signIn(blocked);
  await blocked.locator('#findLibrariesBtn').waitFor();
  assert.equal(await blocked.locator('#createBtn').isVisible(),false,'A scan failure never offers to create another empty vault');
  assert.equal(writes.length,writesBeforeError);
  blockDiscovery=false;await blocked.locator('#findLibrariesBtn').click();
  await blocked.locator('#unlockBtn').waitFor();
  assert.equal(await blocked.evaluate(()=>localStorage.getItem('mediavault_library')),catalogId);
  await blockedContext.close();
  // Each anime gets one title card and one folder, containing its season folders.
  await owner.locator('.upload-options > summary').click();
  await owner.locator('#uploadSection').selectOption('anime');
  await owner.locator('#uploadCollection').fill('Наруто');
  await owner.locator('#uploadPart').fill('Сезон 1');
  const videoBytes=await fs.readFile(mp4);
  await owner.locator('#filesInput').setInputFiles([
    {name:'01.mp4',mimeType:'video/mp4',buffer:videoBytes},
    {name:'02.mp4',mimeType:'video/mp4',buffer:videoBytes}
  ]);
  await owner.waitForFunction(()=>document.querySelectorAll('.media-card').length===7);
  await owner.locator('#uploadPart').fill('Сезон 2');
  await owner.locator('#filesInput').setInputFiles([{name:'01.mp4',mimeType:'video/mp4',buffer:videoBytes}]);
  await owner.waitForFunction(()=>document.querySelectorAll('.media-card').length===8);
  await owner.locator('#uploadSection').selectOption('manga');
  await owner.locator('#uploadPart').fill('Том 1');
  await owner.locator('#filesInput').setInputFiles([{name:'страница-01.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+kkAAAAASUVORK5CYII=','base64')}]);
  await owner.waitForFunction(()=>document.querySelectorAll('.media-card').length===9);
  await owner.locator('#showTitlesBtn').click();
  assert.equal(await owner.locator('.title-card[data-title-name="Наруто"]').count(),2,'Same-named anime and manga have separate title cards');
  await owner.getByRole('button',{name:'Аниме',exact:true}).click();
  assert.equal(await owner.locator('.title-card').count(),1,'Three episodes appear as one anime title');
  await owner.locator('.title-card').click();
  assert.equal(await owner.locator('.title-part').count(),2,'Seasons appear inside the title');
  assert.equal(await owner.locator('.title-part').filter({hasText:'Сезон 1'}).locator('.media-card').count(),2);
  await owner.locator('.title-part').filter({hasText:'Сезон 1'}).locator('.media-card').first().click();
  await owner.waitForFunction(()=>document.querySelector('#viewerContent video')?.readyState>=2);
  await owner.locator('#closeViewer').click();
  await owner.locator('#backToTitles').click();
  await owner.getByRole('button',{name:'Манга',exact:true}).click();
  assert.equal(await owner.locator('.title-card').count(),1);
  await owner.locator('#searchInput').fill('Наруто');
  assert.equal(await owner.locator('.title-card').count(),1,'Title search finds files even when filenames do not contain the title');
  await owner.getByRole('button',{name:'Ранобэ',exact:true}).click();
  await owner.locator('#uploadSection').selectOption('ranobe');
  await owner.locator('#filesInput').setInputFiles([{name:'Том-01.txt',mimeType:'text/plain',buffer:Buffer.from('Light novel volume text')}]);
  await owner.waitForFunction(()=>document.querySelector('#count').textContent==='10 файлов');
  await owner.locator('.title-card').click();
  await owner.locator('.title-part .media-card').click();
  await owner.locator('#viewerContent pre').waitFor();
  assert.equal(await owner.locator('#viewerContent pre').innerText(),'Light novel volume text','A light novel keeps the working book reader');
  await owner.locator('#closeViewer').click();
  await owner.locator('#backToTitles').click();
  await fs.mkdir(path.join(PROJECT,'test-output'),{recursive:true});
  await owner.locator('.upload-options > summary').click();
  await owner.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
  await owner.screenshot({path:path.join(PROJECT,'test-output','title-library-mobile.png'),fullPage:true});
  const organized=await decryptCatalog(files.get(catalogId));
  const animeTitle=organized.storage.collections.find(group=>group.name==='Наруто'&&group.section==='anime');
  const mangaTitle=organized.storage.collections.find(group=>group.name==='Наруто'&&group.section==='manga');
  const ranobeTitle=organized.storage.collections.find(group=>group.name==='Наруто'&&group.section==='ranobe');
  assert.equal(animeTitle.parts.length,2);assert.notEqual(animeTitle.folderId,mangaTitle.folderId);assert.notEqual(mangaTitle.folderId,ranobeTitle.folderId);
  assert.deepEqual(files.get(animeTitle.folderId).parents,[organized.storage.sectionFolders.anime]);
  console.log('PASS: React production build; mocked Google login; encrypted catalog/TXT/PNG/MP4 upload; automatic server job without device video traffic or phrase export; catalog refresh; mobile viewer/abort/Escape; MP4 stream/fallback/seek; search/category/name sort/favorites/history; phrase unlock; token reconnect; stopped worker recovery; reader scopes and UI without writes.');
  console.log('Screenshot: '+path.join(temp,'mobile-owner.png'));
  console.log('Live Google OAuth, real Drive ACL and physical Android/iOS playback remain outside this test.');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
