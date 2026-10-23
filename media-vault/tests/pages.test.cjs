// Multi-page React integration test with mocked public Jikan metadata; no Google credentials.
const assert=require("node:assert/strict");
const http=require("node:http");
const fs=require("node:fs/promises");
const path=require("node:path");
const {chromium}=require("playwright");
const root=path.resolve(__dirname,"..");
const sample={mal_id:5114,title:"Fullmetal Alchemist: Brotherhood",title_english:"Fullmetal Alchemist: Brotherhood",
 synopsis:"A story of two brothers.",episodes:64,images:{webp:{large_image_url:""}},score:9.1,type:"TV",status:"Finished Airing",
 url:"https://myanimelist.net/anime/5114/Fullmetal_Alchemist_Brotherhood"};
const types={".html":"text/html",".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml",".webmanifest":"application/manifest+json"};
async function main(){
 const server=http.createServer(async(req,res)=>{
   try{
    const pathname=new URL(req.url,"http://127.0.0.1").pathname;
    const rel=pathname.replace(/^\/media-vault\/?/,"")||"index.html";
    if(!pathname.startsWith("/media-vault/")||rel.includes(".."))throw Error("bad path");
    let bytes,extension;
    for(const folder of ["dist",""]){
      const base=path.join(root,folder),f=path.resolve(base,rel);
      if(!f.startsWith(base+path.sep))continue;
      try{bytes=await fs.readFile(f);extension=path.extname(f);break;}catch{}
    }
    if(!bytes)throw Error("not found");
    res.writeHead(200,{"content-type":types[extension]||"application/octet-stream"}).end(bytes);
   }catch{res.writeHead(404).end("Not Found");}
 });
 await new Promise(ok=>server.listen(0,"127.0.0.1",ok));
 const base="http://127.0.0.1:"+server.address().port+"/media-vault/";
 let browser;
 try{
   browser=await chromium.launch({headless:true,args:["--no-sandbox"],executablePath:process.env.CHROMIUM_PATH||undefined});
   for(const width of [390,1280]){
    const context=await browser.newContext({viewport:{width,height:850},serviceWorkers:"block",reducedMotion:"reduce"});
    await context.route("https://accounts.google.com/**",r=>r.fulfill({status:200,contentType:"text/javascript",body:"window.google={accounts:{oauth2:{initTokenClient:()=>({requestAccessToken(){}})}}};"}));
    await context.route("https://cdn.jsdelivr.net/**",r=>r.fulfill({status:200,contentType:"text/javascript",body:""}));
    await context.route("https://shikimori.one/**",r=>r.fulfill({status:200,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify({data:{animes:[{malId:5114,russian:"Стальной алхимик: Братство",poster:{mainUrl:""}}]}})}));
    await context.route("https://api.jikan.moe/**",r=>{
      const u=new URL(r.request().url());
      let payload;
      if(u.pathname.includes("/episodes"))payload={data:[{mal_id:1,title:"Episode 1",aired:"2024-01-01T00:00:00Z"}],pagination:{has_next_page:false}};
      else if(u.pathname.startsWith("/v4/anime/"))payload={data:sample};
      else payload={data:[sample,sample]};
      return r.fulfill({status:200,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(payload)});
    });
    const page=await context.newPage(),errs=[];
    page.on("pageerror",e=>errs.push(e.message));
    await page.goto(base,{waitUntil:"domcontentloaded"});
    await page.getByRole("heading",{name:/Твоя коллекция/}).waitFor();
    await page.locator(".discover-banner").click();
    await page.waitForURL(/#\/discover/);
    await page.getByRole("heading",{name:"Найти новое"}).waitFor();
    await page.locator(".directory-card").filter({hasText:"Стальной алхимик"}).first().click();
    await page.waitForURL(/#\/title\/5114/);
    await page.getByRole("heading",{name:"Подробности"}).waitFor();
    await page.getByText("A story of two brothers.").waitFor();
    await page.getByText("Episode 1").waitFor();
    await page.getByRole("button",{name:/В мою библиотеку/}).click();
    await page.getByText(/Чтобы сохранить карточку/).waitFor();
    await page.goto(base+"#/import",{waitUntil:"domcontentloaded"});
    await page.getByRole("heading",{name:"Импорт карточки"}).waitFor();
    await page.locator("#importValue").fill("https://animelib.me/ru/anime/fullmetal-alchemist-brotherhood");
    await page.getByRole("button",{name:"Найти карточку"}).click();
    await page.getByText("Результаты поиска").waitFor();
    await page.goto(base+"#/upload",{waitUntil:"domcontentloaded"});
    await page.getByRole("heading",{name:"Загрузка файлов"}).waitFor();
    await page.getByText(/Сначала подключи библиотеку/).waitFor();
    await page.goto(base+"#/settings",{waitUntil:"domcontentloaded"});
    await page.getByRole("heading",{name:"Библиотека и доступ"}).waitFor();
    const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth}));
    assert.ok(dimensions.scroll<=dimensions.viewport+1,"No overflow "+width+"px");
    assert.deepEqual(errs,[],"No React errors at "+width+"px");
    await fs.mkdir(path.join(root,"test-output"),{recursive:true});
    await page.screenshot({path:path.join(root,"test-output","pages-"+width+".png"),fullPage:true});
    await context.close();
    console.log("PASS pages "+width+"px: routing, catalog, details, episodes, import, upload and settings");
   }
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
