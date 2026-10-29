const $ = (id) => document.getElementById(id);
const E = {
  upload: $('fileImage'),
  depth: $('fileDepth'),
  mask: $('fileMask'),
  stage: $('stage'),
  fallback: $('fallback'),
  gl: $('glCanvas'),
  overlay: $('overlayCanvas'),
  hint: $('stageHint'),
  status: $('aiStatus'),
};

const state = {
  image: null,
  depth: null,
  mask: null,
  scene: null,
  quality: 'mobile',
  view: 'scene',
  edge: 0.55,
  strength: 0.32,
  invert: false,
  player: null,
  source: '',
  useSmartFill: true,
  inpaintModel: 'migan',
  brushMode: '', brushRadius: 24, brushActive: false,
};

function status(msg, error = false) {
  E.status.textContent = msg;
  E.status.classList.toggle('error', !!error);
}
function setBusy(b, msg) {
  for (const id of ['runAi', 'build']) $(id).disabled = b;
  $('aiProgress').hidden = !b;
  $('progressBar').style.width = b ? '42%' : '0%';
  if (msg) status(msg);
}
function clamp(v, a = 0, b = 1) { return Math.min(b, Math.max(a, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(a, b, x) { x = clamp((x - a) / (b - a)); return x * x * (3 - 2 * x); }
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function fitDimensions(w, h, max) { const s = Math.min(1, max / Math.max(w, h)); return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]; }
function download(name, href) { const a = document.createElement('a'); a.href = href; a.download = name; a.click(); }
function stopPlayer() { try { state.player?.dispose?.(); } catch (_) {} state.player = null; }

function imageFromFile(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 25 * 1024 * 1024) return reject(new Error('Файл больше 25 МБ'));
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть изображение')); };
    im.src = url;
  });
}
function imageToCanvas(im, max = 1200) {
  const [w, h] = fitDimensions(im.naturalWidth || im.width, im.naturalHeight || im.height, max);
  const c = makeCanvas(w, h);
  c.getContext('2d', { willReadFrequently: true }).drawImage(im, 0, 0, w, h);
  return c;
}
function resizeGray(im, w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(im, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 765;
  return out;
}
function getImageRGBA(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
}
function showRasterFromCanvas(canvas, label = 'Изображение') {
  stopPlayer();
  E.hint.classList.add('hidden');
  E.fallback.src = canvas.toDataURL('image/webp', 0.92);
  E.fallback.classList.add('visible');
  E.gl.classList.remove('visible');
  E.overlay.classList.remove('visible');
  $('imageSize').textContent = `${canvas.width} × ${canvas.height}`;
  $('renderMode').textContent = label;
}
function showOriginal() {
  if (!state.image) return;
  $('meshCount').textContent = '—';
  $('layerCount').textContent = '—';
  showRasterFromCanvas(state.image, 'Исходник');
}
function showDepth() {
  if (!state.depth || !state.image) return;
  const { width: w, height: h } = state.image;
  const c = makeCanvas(w, h), ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.round(clamp(state.invert ? 1 - state.depth[i] : state.depth[i]) * 255);
    id.data.set([v, v, v, 255], i * 4);
  }
  ctx.putImageData(id, 0, 0);
  showRasterFromCanvas(c, 'Карта глубины');
}
function showMask() {
  if (!state.scene) return showOriginal();
  const { width: w, height: h } = state.scene;
  const c = makeCanvas(w, h), ctx = c.getContext('2d');
  ctx.drawImage(state.scene.background, 0, 0);
  const palette = ['#77d5ff', '#ffd778', '#b4a3ff', '#ff84ab', '#8cf2bf', '#ffb2f0'];
  state.scene.layers.slice(1).forEach((L, idx) => {
    const src = L.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const over = ctx.createImageData(w, h);
    const rgb = palette[idx % palette.length].match(/\w\w/g).map(x => parseInt(x, 16));
    for (let i = 0; i < w * h; i++) {
      over.data[i * 4] = rgb[0];
      over.data[i * 4 + 1] = rgb[1];
      over.data[i * 4 + 2] = rgb[2];
      over.data[i * 4 + 3] = Math.round(src[i * 4 + 3] * 0.75);
    }
    const lay = makeCanvas(w, h);
    lay.getContext('2d').putImageData(over, 0, 0);
    ctx.drawImage(lay, 0, 0);
  });
  showRasterFromCanvas(c, 'Маски слоёв');
}
function setView(view) {
  state.view = view;
  document.querySelectorAll('#viewToggle button').forEach(b => b.classList.toggle('selected', b.dataset.view === view));
  if (view === 'depth') return showDepth();
  if (view === 'mask') return showMask();
  if (state.scene) return playScene();
  showOriginal();
}

function demoArt() {
  const w = 1100, h = 619, c = makeCanvas(w, h), g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#071947'); bg.addColorStop(0.45, '#2f6eb8'); bg.addColorStop(0.78, '#f4a870'); bg.addColorStop(1, '#10233f');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#79e8ff'; g.lineWidth = 10; g.shadowColor = '#3bc4ff'; g.shadowBlur = 18;
  g.beginPath(); g.moveTo(860, -40); g.bezierCurveTo(770, 55, 670, 135, 618, 378); g.stroke(); g.shadowBlur = 0; g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();
  g.fillStyle = '#12213c';
  for (let i = 0; i < 70; i++) { const x = i * 17, hh = 25 + ((i * 19) % 120); g.fillRect(x, 450 - hh, 14, hh + 150); }
  g.fillStyle = '#32526a'; g.beginPath(); g.moveTo(0, 619); g.lineTo(0, 505); g.lineTo(540, 440); g.lineTo(550, 619); g.fill();
  g.fillStyle = '#52885e'; g.beginPath(); g.moveTo(520, 619); g.lineTo(670, 475); g.lineTo(1100, 450); g.lineTo(1100, 619); g.fill();
  g.fillStyle = '#181b33'; g.beginPath(); g.arc(344, 392, 17, 0, 7); g.fill(); g.fillRect(331, 405, 28, 77);
  g.beginPath(); g.moveTo(333, 480); g.lineTo(317, 552); g.lineTo(332, 552); g.lineTo(347, 494); g.lineTo(358, 552); g.lineTo(372, 551); g.lineTo(363, 480); g.fill();
  g.fillStyle = '#28243a'; g.beginPath(); g.arc(808, 402, 17, 0, 7); g.fill(); g.fillRect(796, 416, 26, 67);
  g.beginPath(); g.moveTo(796, 481); g.lineTo(780, 532); g.lineTo(794, 532); g.lineTo(810, 494); g.lineTo(824, 531); g.lineTo(838, 531); g.lineTo(823, 481); g.fill();
  return c;
}
function demoDepth(c) {
  const w = c.width, h = c.height, d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0.12 + 0.42 * y / h;
    if (x > 630 && y > 465 - (x - 630) * 0.08) v = 0.72;
    if ((x > 312 && x < 372 && y > 370 && y < 558) || (x > 780 && x < 845 && y > 385 && y < 535)) v = 0.92;
    d[y * w + x] = v;
  }
  return d;
}
function previewDemo() {
  state.image = demoArt();
  state.depth = demoDepth(state.image);
  state.mask = null;
  state.scene = null;
  state.source = 'Демосцена';
  showOriginal();
  status('Демосцена готова. Нажми «Построить 2.5D-сцену».');
}

function rgbToLum(r, g, b) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }
function sampleBorderColor(pix, w, h) {
  let r = 0, g = 0, b = 0, n = 0;
  const bandX = Math.max(2, Math.floor(w * 0.04));
  const bandY = Math.max(2, Math.floor(h * 0.04));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= bandX && x < w - bandX && y >= bandY && y < h - bandY) continue;
    const i = (y * w + x) * 4; r += pix[i]; g += pix[i + 1]; b += pix[i + 2]; n++;
  }
  return [r / n, g / n, b / n];
}
function estimateSolidBgConfidence(pix, w, h, bg) {
  let acc = 0, n = 0;
  const bandX = Math.max(2, Math.floor(w * 0.04));
  const bandY = Math.max(2, Math.floor(h * 0.04));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= bandX && x < w - bandX && y >= bandY && y < h - bandY) continue;
    const i = (y * w + x) * 4;
    const dr = pix[i] - bg[0], dg = pix[i + 1] - bg[1], db = pix[i + 2] - bg[2];
    acc += Math.sqrt(dr * dr + dg * dg + db * db) / 441.67295593; n++;
  }
  return 1 - acc / Math.max(1, n);
}
function boxBlurFloat(src, w, h, radius = 1) {
  if (radius <= 0) return new Float32Array(src);
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length), size = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[y * w + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / size;
      const x0 = clamp(x - radius, 0, w - 1), x1 = clamp(x + radius + 1, 0, w - 1);
      sum += src[y * w + x1] - src[y * w + x0];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / size;
      const y0 = clamp(y - radius, 0, h - 1), y1 = clamp(y + radius + 1, 0, h - 1);
      sum += tmp[y1 * w + x] - tmp[y0 * w + x];
    }
  }
  return out;
}
function refineDepth(depth, rgba, w, h, strength) {
  const src = new Float32Array(depth), out = new Float32Array(depth.length);
  const iters = strength > 0.65 ? 2 : 1;
  let cur = src;
  for (let it = 0; it < iters; it++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4;
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      let sum = cur[i] * 3.0, wsum = 3.0;
      const ns = [[-1,0],[1,0],[0,-1],[0,1]];
      for (const [dx, dy] of ns) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx, q = j * 4;
        const cd = (Math.abs(r - rgba[q]) + Math.abs(g - rgba[q + 1]) + Math.abs(b - rgba[q + 2])) / 765;
        const dd = Math.abs(cur[i] - cur[j]);
        const wt = Math.exp(-cd * (7 + strength * 32) - dd * 18) * (0.6 + strength * 0.8);
        sum += cur[j] * wt; wsum += wt;
      }
      out[i] = sum / wsum;
    }
    cur = new Float32Array(out);
  }
  return cur;
}
function estimateForegroundMask(rgba, w, h, depth) {
  const bg = sampleBorderColor(rgba, w, h);
  const confidence = estimateSolidBgConfidence(rgba, w, h, bg);
  const alpha = new Float32Array(w * h);
  const lumBg = rgbToLum(bg[0], bg[1], bg[2]);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    const dr = r - bg[0], dg = g - bg[1], db = b - bg[2];
    const colorDist = Math.sqrt(dr * dr + dg * dg + db * db) / 441.67295593;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = (mx - mn) / 255;
    const lum = rgbToLum(r, g, b);
    const depthBoost = depth ? Math.max(0, depth[i] - 0.45) * 0.45 : 0;
    const lumSep = Math.abs(lum - lumBg);
    const score = colorDist * 0.75 + sat * 0.2 + lumSep * 0.15 + depthBoost;
    alpha[i] = smoothstep(0.035, 0.22, score);
  }
  const softened = boxBlurFloat(alpha, w, h, confidence > 0.84 ? 1 : 2);
  for (let i = 0; i < softened.length; i++) softened[i] = clamp(softened[i]);
  return { alpha: softened, bg, confidence };
}
function binaryFromAlpha(alpha, thr = 0.55) {
  const out = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) out[i] = alpha[i] >= thr ? 1 : 0;
  return out;
}
function expandMask(mask, w, h, radius = 1) {
  if (radius <= 0) return new Uint8Array(mask);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let dy = -radius; dy <= radius && !v; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      if (mask[yy * w + xx]) { v = 1; break; }
    }
    out[y * w + x] = v;
  }
  return out;
}
function decontaminate(rgba, alpha, bg) {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < alpha.length; i++) {
    const a = clamp(alpha[i]);
    const p = i * 4;
    if (a < 0.001) {
      out[p] = out[p + 1] = out[p + 2] = 0; out[p + 3] = 0; continue;
    }
    const aa = Math.max(0.08, a);
    out[p] = clamp((rgba[p] - bg[0] * (1 - aa)) / aa, 0, 255);
    out[p + 1] = clamp((rgba[p + 1] - bg[1] * (1 - aa)) / aa, 0, 255);
    out[p + 2] = clamp((rgba[p + 2] - bg[2] * (1 - aa)) / aa, 0, 255);
    out[p + 3] = Math.round(a * 255);
  }
  return out;
}
function inpaintNearest(original, w, h, holeMask) {
  const n = w * h;
  const out = new Uint8ClampedArray(original);
  const owner = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) if (!holeMask[i]) { owner[i] = i; queue[tail++] = i; }
  if (!tail) return out;
  while (head < tail) {
    const i = queue[head++], x = i % w, y = (i / w) | 0;
    const ns = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of ns) if (j >= 0 && owner[j] === -1) { owner[j] = owner[i]; queue[tail++] = j; }
  }
  for (let i = 0; i < n; i++) if (holeMask[i]) {
    const s = owner[i] * 4, d = i * 4;
    out[d] = original[s]; out[d + 1] = original[s + 1]; out[d + 2] = original[s + 2]; out[d + 3] = 255;
  }
  for (let pass = 0; pass < 3; pass++) {
    const prev = out.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!holeMask[i]) continue;
      const p = i * 4;
      for (let k = 0; k < 3; k++) {
        out[p + k] = Math.round((prev[p + k] * 2 + prev[p - 4 + k] + prev[p + 4 + k] + prev[p - w * 4 + k] + prev[p + w * 4 + k]) / 6);
      }
    }
  }
  return out;
}
function composeRGBAtoCanvas(data, w, h) {
  const c = makeCanvas(w, h), ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h); id.data.set(data); ctx.putImageData(id, 0, 0); return c;
}

const modelCache = { ort: null, migan: null };
async function ensureOrt() {
  if (modelCache.ort) return modelCache.ort;
  const ort = await import('https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.all.min.mjs');
  if (ort.env?.wasm) {
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';
    ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
  }
  modelCache.ort = ort;
  return ort;
}
function chwFromRGBA(rgba, w, h) {
  const out = new Uint8Array(3 * w * h);
  for (let i = 0; i < w * h; i++) {
    out[i] = rgba[i * 4];
    out[w * h + i] = rgba[i * 4 + 1];
    out[2 * w * h + i] = rgba[i * 4 + 2];
  }
  return out;
}
function chwMaskKeep(holeMask, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = holeMask[i] ? 0 : 255;
  return out;
}

function inpaintComponents(hole, w, h) {
  const seen = new Uint8Array(w*h), queue = new Int32Array(w*h), comps = [];
  for (let start = 0; start < hole.length; start++) {
    if (!hole[start] || seen[start]) continue;
    let head=0, tail=1, x0=w, y0=h, x1=0, y1=0;
    queue[0]=start; seen[start]=1;
    while(head<tail){
      const i=queue[head++], x=i%w, y=Math.floor(i/w);
      x0=Math.min(x0,x); x1=Math.max(x1,x); y0=Math.min(y0,y); y1=Math.max(y1,y);
      const ns=[x>0?i-1:-1,x+1<w?i+1:-1,y>0?i-w:-1,y+1<h?i+w:-1];
      for(const j of ns)if(j>=0&&!seen[j]&&hole[j]){seen[j]=1;queue[tail++]=j}
    }
    if(tail>=64)comps.push({x0,y0,x1,y1,area:tail});
  }
  comps.sort((a,b)=>b.area-a.area);
  return comps.slice(0,4);
}
function extractCrop(rgba,w,h,mask,bounds,dim=512){
  const cw=bounds.x1-bounds.x0+1, ch=bounds.y1-bounds.y0+1;
  const image=composeRGBAtoCanvas(rgba,w,h);
  const ci=makeCanvas(dim,dim),g=ci.getContext('2d',{willReadFrequently:true});
  g.drawImage(image,bounds.x0,bounds.y0,cw,ch,0,0,dim,dim);
  const rgbaSmall=g.getImageData(0,0,dim,dim).data;
  const mc=makeCanvas(w,h), mg=mc.getContext('2d');
  const mid=mg.createImageData(w,h);
  for(let i=0;i<mask.length;i++){let v=mask[i]?0:255;mid.data[i*4]=mid.data[i*4+1]=mid.data[i*4+2]=v;mid.data[i*4+3]=255}
  mg.putImageData(mid,0,0);
  const small=makeCanvas(dim,dim),sg=small.getContext('2d',{willReadFrequently:true});
  sg.imageSmoothingEnabled=false;
  sg.drawImage(mc,bounds.x0,bounds.y0,cw,ch,0,0,dim,dim);
  let m=sg.getImageData(0,0,dim,dim).data, kept=new Uint8Array(dim*dim);
  for(let i=0;i<kept.length;i++)kept[i]=m[i*4] > 127 ? 255 : 0;
  return {rgbaSmall,kept,cw,ch};
}
async function createMiganSession(ort){
  if(modelCache.migan) return modelCache.migan;
  const url='https://huggingface.co/edgetools/migan/resolve/main/migan_pipeline_v2.onnx';
  let err;
  for(const providers of (navigator.gpu?[['webgpu'],['wasm']]:[['wasm']])){
    try{
      modelCache.migan=await ort.InferenceSession.create(url,{executionProviders:providers,graphOptimizationLevel:'all'});
      return modelCache.migan;
    }catch(e){err=e;console.warn('MI-GAN '+providers.join(','),e)}
  }
  throw err||new Error('MI-GAN unavailable');
}
async function runSmartInpaint(rgba,w,h,holeMask){
  const areas=inpaintComponents(holeMask,w,h);
  if(!areas.length) return null;
  const ort=await ensureOrt();
  const model=await createMiganSession(ort);
  let restored=inpaintNearest(rgba,w,h,holeMask);
  const dim=512, out=makeCanvas(w,h),octx=out.getContext('2d',{willReadFrequently:true});
  octx.putImageData(new ImageData(restored,w,h),0,0);
  const holeSoft=boxBlurFloat(Float32Array.from(holeMask),w,h,2);
  for(let num=0;num<areas.length;num++){
    const comp=areas[num];
    let minSize=Math.max(comp.x1-comp.x0+1,comp.y1-comp.y0+1);
    const pad=Math.round(Math.max(24,minSize*.30));
    const x0=Math.max(0,comp.x0-pad), y0=Math.max(0,comp.y0-pad);
    const x1=Math.min(w-1,comp.x1+pad), y1=Math.min(h-1,comp.y1+pad);
    const bounds={x0,y0,x1,y1};
    status(`AI inpaint: область ${num+1}/${areas.length}…`);
    const {rgbaSmall,kept,cw,ch}=extractCrop(rgba,w,h,holeMask,bounds,dim);
    const imgTensor=new ort.Tensor('uint8',chwFromRGBA(rgbaSmall,dim,dim),[1,3,dim,dim]);
    const maskTensor=new ort.Tensor('uint8',kept,[1,1,dim,dim]);
    const result=await model.run({image:imgTensor,mask:maskTensor});
    const prediction=result.result||result.output||Object.values(result)[0];
    if(!prediction?.data||prediction.data.length<3*dim*dim)throw new Error('Некорректный выход MI-GAN');
    const pixels=new Uint8ClampedArray(dim*dim*4),plane=dim*dim;
    for(let i=0;i<plane;i++){
      pixels[i*4]=prediction.data[i];pixels[i*4+1]=prediction.data[plane+i];
      pixels[i*4+2]=prediction.data[plane*2+i];pixels[i*4+3]=255;
    }
    const small=composeRGBAtoCanvas(pixels,dim,dim),region=makeCanvas(cw,ch),rc=region.getContext('2d',{willReadFrequently:true});
    rc.drawImage(small,0,0,cw,ch);
    const regionPixels=rc.getImageData(0,0,cw,ch).data;
    const full=octx.getImageData(x0,y0,cw,ch),pix=full.data;
    for(let yy=0;yy<ch;yy++)for(let xx=0;xx<cw;xx++){
      const global=(y0+yy)*w+(x0+xx);if(!holeMask[global])continue;
      const p=(yy*cw+xx)*4,a=clamp(holeSoft[global]);
      for(let c=0;c<3;c++)pix[p+c]=Math.round(regionPixels[p+c]*a+pix[p+c]*(1-a));
    }
    octx.putImageData(full,x0,y0);
    await new Promise(r=>setTimeout(r,0));
  }
  return octx.getImageData(0,0,w,h).data;
}
async function buildSceneLayers(imageCanvas, depthArr, extraMaskImg) {
  const W = imageCanvas.width, H = imageCanvas.height;
  const max = state.quality === 'mobile' ? 900 : 1280;
  const [w, h] = fitDimensions(W, H, max);
  const srcCanvas = makeCanvas(w, h), srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  srcCtx.drawImage(imageCanvas, 0, 0, w, h);
  const rgba = srcCtx.getImageData(0, 0, w, h).data;

  let depth = depthArr;
  if (depth.length !== w * h) {
    const tmp = makeCanvas(W, H), tctx = tmp.getContext('2d');
    const id = tctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const v = Math.round(clamp(depth[i]) * 255);
      id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
    }
    tctx.putImageData(id, 0, 0);
    depth = resizeGray(tmp, w, h);
  }
  if (state.invert) depth = Float32Array.from(depth, v => 1 - v);
  depth = refineDepth(depth, rgba, w, h, state.edge);

  let bgInfo = { bg: [242, 242, 242], confidence: 0.0 };
  let maskFloat;
  if (extraMaskImg) {
    maskFloat = boxBlurFloat(resizeGray(extraMaskImg, w, h), w, h, 1);
  } else {
    bgInfo = estimateForegroundMask(rgba, w, h, depth);
    maskFloat = bgInfo.alpha;
  }

  let fgMask = binaryFromAlpha(maskFloat, 0.58);
  fgMask = expandMask(fgMask, w, h, state.quality === 'mobile' ? 1 : 2);
  for (let i = 0; i < fgMask.length; i++) if (depth[i] > 0.86) fgMask[i] = 1;

  const decont = decontaminate(rgba, maskFloat, bgInfo.bg);
  const hole = expandMask(fgMask, w, h, 2);

  let repaired = null;
  if (state.useSmartFill) {
    status('AI-инпейнт скрытого фона…');
    try { repaired = await runSmartInpaint(rgba,w,h,hole); } catch(e){console.warn('AI inpaint fallback',e);status('AI-fill недоступен; использую быстрый фон.');}
  }
  if (!repaired) {
    status('Локальное восстановление скрытого фона…');
    repaired = inpaintNearest(rgba, w, h, hole);
  }

  // True occlusion layering: far plate must not contain opaque copies of the
  // objects moved by nearer meshes. Inpaint them once, then draw once as layers.
  const farHole=new Uint8Array(w*h);
  for(let i=0;i<w*h;i++) farHole[i]=fgMask[i] || depth[i]>.26 ? 1:0;
  const farPlate=inpaintNearest(repaired,w,h,expandMask(farHole,w,h,1));
  const background = composeRGBAtoCanvas(farPlate, w, h);
  const layers = [{ canvas: background, depth: 0.04, depthMap: null }];

  const ranges = state.quality === 'mobile'
    ? [[0.10, 0.36, 0.12], [0.30, 0.64, 0.34], [0.58, 0.86, 0.58]]
    : [[0.08, 0.24, 0.10], [0.20, 0.40, 0.22], [0.36, 0.58, 0.38], [0.54, 0.76, 0.58], [0.72, 0.90, 0.76]];

  for (const [lo, hi, layerDepth] of ranges) {
    const data = new Uint8ClampedArray(w * h * 4);
    const dmap = new Float32Array(w * h);
    let has = false;
    const feather = 0.06;
    for (let i = 0; i < w * h; i++) {
      if (fgMask[i]) continue;
      const d = depth[i];
      const a = smoothstep(lo - feather, lo + feather, d) * (1.0 - smoothstep(hi - feather, hi + feather, d));
      if (a <= 0.025) continue;
      has = true;
      const p = i * 4;
      data[p] = rgba[p]; data[p+1] = rgba[p+1]; data[p+2] = rgba[p+2]; data[p+3] = Math.round(a * 255);
      dmap[i] = d;
    }
    if (has) layers.push({ canvas: composeRGBAtoCanvas(data, w, h), depth: layerDepth, depthMap: dmap });
  }

  const fgDepth = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) fgDepth[i] = fgMask[i] ? Math.max(depth[i], 0.82) : 0;
  layers.push({ canvas: composeRGBAtoCanvas(decont, w, h), depth: 0.96, depthMap: fgDepth, foreground: true });

  return { width: w, height: h, original: srcCanvas, background, layers, depth, fgMask, source: state.source };
}

async function reconstruct() {
  if (!state.image || !state.depth) return status('Сначала загрузи обложку и получи карту глубины.', true);
  setBusy(true, 'Строю выпуклую 2.5D-сцену и заполняю скрытые пиксели…');
  try {
    await new Promise(r => setTimeout(r, 20));
    setBrush('');
    state.scene = await buildSceneLayers(state.image, state.depth, state.mask);
    $('layerCount').textContent = String(state.scene.layers.length);
    $('meshCount').textContent = state.quality === 'mobile' ? '65 × 41' : '112 × 72';
    $('imageSize').textContent = `${state.scene.width} × ${state.scene.height}`;
    status('LDI-сцена готова: выпуклая depth-сетка, разрывы по контурам, заполненные скрытые области.');
    setView('scene');
  } catch (e) {
    console.error(e);
    status('Не удалось собрать сцену: ' + (e.message || e), true);
  } finally { setBusy(false); }
}

function buildDepthTexture(depthMap, w, h) {
  if (!depthMap) return null;
  if ((typeof HTMLCanvasElement !== 'undefined' && depthMap instanceof HTMLCanvasElement) || (typeof HTMLImageElement !== 'undefined' && depthMap instanceof HTMLImageElement) || (typeof ImageBitmap !== 'undefined' && depthMap instanceof ImageBitmap)) return depthMap;
  const c = makeCanvas(w, h), ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.round(clamp(depthMap[i]) * 255);
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

function startLDIPlayer(stage, scene, options = {}) {
  const canvas = options.canvas || document.createElement('canvas');
  const fallback = options.fallback || null;
  const overlay = options.overlay || null;
  const layers = scene.layers;
  const imgs = layers.map(L => L.canvas);
  const depths = layers.map(L => L.depth);
  const dmaps = layers.map(L => buildDepthTexture(L.depthMap, scene.width, scene.height));
  const strength = options.strength ?? 0.32;
  const quality = options.quality || 'quality';
  let gl = null, prog = null, vbo = null, buffers=[], textures = [], depthTextures = [];
  let current = { x: 0, y: 0 }, target = { x: 0, y: 0 }, alive = true, raf = 0;
  let orientationEnabled = false, neutral = null;

  function updateTargetFromEvent(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    target.x = clamp((clientX - r.left) / r.width, 0, 1) * 2 - 1;
    target.y = clamp((clientY - r.top) / r.height, 0, 1) * 2 - 1;
  }
  function onMove(e) { updateTargetFromEvent(e.clientX, e.clientY); }
  function onLeave() { target.x = 0; target.y = 0; }
  function onOrientation(e) {
    if (!orientationEnabled || e.beta == null || e.gamma == null) return;
    if (!neutral) neutral = { beta: e.beta, gamma: e.gamma };
    const dx = clamp((e.gamma - neutral.gamma) / 18, -1, 1);
    const dy = clamp((e.beta - neutral.beta) / 18, -1, 1);
    target.x = dx; target.y = dy;
  }
  async function permission() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        orientationEnabled = res === 'granted';
      } else orientationEnabled = true;
      if (orientationEnabled) { neutral = null; window.addEventListener('deviceorientation', onOrientation); }
      return orientationEnabled;
    } catch (e) { console.warn(e); return false; }
  }
  function recenter() { neutral = null; target.x = target.y = current.x = current.y = 0; }

  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerleave', onLeave);
  if (fallback) { fallback.src = (scene.original || scene.background).toDataURL('image/webp', 0.9); fallback.classList.add('visible'); }

  function initGL() {
    try {
      gl = canvas.getContext('webgl2', { alpha: true, antialias: true, preserveDrawingBuffer: false });
      if (!gl) throw new Error('webgl2 unavailable');
      const vs = `#version 300 es
      precision highp float;
      in vec2 aPos; in vec2 aUv;
      uniform sampler2D uDepth;
      uniform vec2 uMotion; uniform vec2 uFit;
      uniform float uLayerDepth; uniform float uUseDepth;
      out vec2 vUv; out float vD;
      void main(){
        float d = texture(uDepth, aUv).r;
        float disp = mix(0.5, d, uUseDepth);
        vec2 pos = aPos;
        pos.xy *= uFit;
        pos.xy += uMotion * (0.015 + uLayerDepth * 0.15) * (0.25 + disp * 0.95);
        pos.xy += (aUv - 0.5) * (disp - 0.5) * uMotion * 0.12 * uUseDepth;
        gl_Position = vec4(pos, 0.0, 1.0);
        vUv = aUv; vD = disp;
      }`;
      const fs = `#version 300 es
      precision highp float;
      uniform sampler2D uImage;
      uniform vec2 uMotion;
      uniform float uUseDepth;
      in vec2 vUv; in float vD; out vec4 outColor;
      void main(){
        vec2 uv = vUv;
        // Geometry carries the depth. Do not distort pixels again in screen space.
        outColor = texture(uImage, uv);
      }`;
      const compile = (type, src) => {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
        return s;
      };
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');

      const gx=quality==='mobile'?65:112,gy=quality==='mobile'?41:72;
      const cellData=imgs.map((img,li)=>{
        const ic=makeCanvas(scene.width,scene.height),ctx=ic.getContext('2d',{willReadFrequently:true});
        ctx.drawImage(img,0,0,scene.width,scene.height);
        const pixels=ctx.getImageData(0,0,scene.width,scene.height).data;
        let mapPixels=null;
        if(dmaps[li]){
          const dm=makeCanvas(scene.width,scene.height),dx=dm.getContext('2d',{willReadFrequently:true});
          dx.drawImage(dmaps[li],0,0,scene.width,scene.height);
          mapPixels=dx.getImageData(0,0,scene.width,scene.height).data;
        }
        return {pixels,mapPixels};
      });
      for(let li=0;li<imgs.length;li++){
        const {pixels,mapPixels}=cellData[li];
        const verts=[];
        const w=scene.width,h=scene.height;
        function vertex(u,v){
          const px=Math.max(0,Math.min(w-1,Math.floor(u*(w-1)))),py=Math.max(0,Math.min(h-1,Math.floor(v*(h-1))));
          const idx=(py*w+px)*4;
          return {u,v,alpha:pixels[idx+3]/255,depth:mapPixels?mapPixels[idx]/255:depths[li]};
        }
        function append(a,b,c){
          const count=(a.alpha>.04?1:0)+(b.alpha>.04?1:0)+(c.alpha>.04?1:0);
          if(li>0 && count===0)return;
          let minD=1,maxD=0;
          for(const p of [a,b,c])if(p.alpha>.1){minD=Math.min(minD,p.depth);maxD=Math.max(maxD,p.depth)}
          if(li>0 && count>1 && maxD-minD>.19)return; // split mesh at depth seams
          for(const p of [a,b,c])verts.push(p.u*2-1,1-p.v*2,p.u,p.v);
        }
        for(let y=0;y<gy;y++)for(let x=0;x<gx;x++){
          const a=vertex(x/gx,y/gy),b=vertex(x/gx,(y+1)/gy);
          const c=vertex((x+1)/gx,y/gy),d=vertex((x+1)/gx,(y+1)/gy);
          append(a,b,c);append(c,b,d);
        }
        const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(verts),gl.STATIC_DRAW);
        buffers.push({buffer:b,count:verts.length/4});
      }
      const mkTex = (img) => {
        const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      textures = imgs.map(mkTex);
      depthTextures = dmaps.map(dm => mkTex(dm || scene.background));
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST);
      options.onMode?.('WebGL2 · convex mesh');
      return true;
    } catch (e) {
      console.warn('WebGL init failed', e);
      gl = null; options.onMode?.('Canvas 2D · fallback');
      return false;
    }
  }

  let ctx2 = null;
  function ensureCanvas2D() {
    ctx2 = canvas.getContext('2d', { alpha: true });
    return !!ctx2;
  }

  function frame() {
    if (!alive) return;
    current.x += (target.x - current.x) * 0.10;
    current.y += (target.y - current.y) * 0.10;
    const rect = stage.getBoundingClientRect();
    const cw = Math.max(1, Math.round(rect.width * Math.min(devicePixelRatio || 1, 2)));
    const ch = Math.max(1, Math.round(rect.height * Math.min(devicePixelRatio || 1, 2)));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    const imageRatio = scene.width / scene.height, screenRatio = cw / ch;
    const fitX = imageRatio > screenRatio ? 1 : imageRatio / screenRatio;
    const fitY = imageRatio > screenRatio ? screenRatio / imageRatio : 1;
    const ox = current.x * strength, oy = -current.y * strength;

    if (gl) {
      try {
        gl.viewport(0, 0, cw, ch); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.useProgram(prog);
        const aPos = gl.getAttribLocation(prog, 'aPos'), aUv = gl.getAttribLocation(prog, 'aUv');
        gl.enableVertexAttribArray(aPos);gl.enableVertexAttribArray(aUv);
        gl.uniform2f(gl.getUniformLocation(prog, 'uMotion'), ox, oy);
        gl.uniform2f(gl.getUniformLocation(prog, 'uFit'), fitX * 0.985, fitY * 0.985);
        for (let i = 0; i < textures.length; i++) {
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, textures[i]);
          gl.uniform1i(gl.getUniformLocation(prog, 'uImage'), 0);
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, depthTextures[i]);
          gl.uniform1i(gl.getUniformLocation(prog, 'uDepth'), 1);
          gl.uniform1f(gl.getUniformLocation(prog, 'uLayerDepth'), depths[i]);
          gl.uniform1f(gl.getUniformLocation(prog, 'uUseDepth'), dmaps[i] ? 1.0 : 0.0);
          const buffer=buffers[i];gl.bindBuffer(gl.ARRAY_BUFFER,buffer.buffer);
          gl.vertexAttribPointer(aPos,2,gl.FLOAT,false,16,0);
          gl.vertexAttribPointer(aUv,2,gl.FLOAT,false,16,8);
          gl.drawArrays(gl.TRIANGLES,0,buffer.count);
        }
      } catch (e) {
        console.warn('GL frame failed', e); gl = null; ensureCanvas2D();
      }
    }
    if (!gl) {
      if (!ctx2 && !ensureCanvas2D()) { raf = requestAnimationFrame(frame); return; }
      ctx2.clearRect(0, 0, cw, ch);
      const ww = cw * fitX * 0.985, hh = ch * fitY * 0.985;
      for (let i = 0; i < imgs.length; i++) {
        const im = imgs[i];
        const layerAmp = 3 + depths[i] * 24;
        const px = Math.round((cw - ww) / 2 + ox * layerAmp);
        const py = Math.round((ch - hh) / 2 + oy * layerAmp);
        ctx2.drawImage(im, px, py, ww, hh);
      }
    }
    raf = requestAnimationFrame(frame);
  }

  canvas.style.display = 'block';
  const ready = [...imgs, ...dmaps.filter(Boolean)].map(im => im.decode ? im.decode().catch(() => {}) : Promise.resolve());
  Promise.all(ready).then(() => { if (!alive) return; if (!initGL()) ensureCanvas2D(); frame(); });

  return {
    dispose() {
      alive = false; cancelAnimationFrame(raf);
      stage.removeEventListener('pointermove', onMove); stage.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('deviceorientation', onOrientation);
      if (gl) {
        textures.forEach(t => gl.deleteTexture(t)); depthTextures.forEach(t => gl.deleteTexture(t));
        for(const b of buffers)gl.deleteBuffer(b.buffer);if(prog)gl.deleteProgram(prog);
      }
    },
    permission, recenter,
  };
}

function playScene() {
  if (!state.scene) return showOriginal();
  stopPlayer();
  E.hint.classList.add('hidden');
  E.fallback.classList.add('visible');
  E.gl.classList.add('visible');
  E.overlay.classList.remove('visible');
  $('renderMode').textContent = 'LDI 2.5D';
  state.player = startLDIPlayer(E.stage, state.scene, {
    canvas: E.gl,
    fallback: E.fallback,
    overlay: E.overlay,
    strength: state.strength,
    quality: state.quality,
    onMode(mode) { $('renderMode').textContent = mode; },
  });
}

async function runAI() {
  if (!state.image) return status('Сначала загрузи изображение.', true);
  const modelKey = $('model').value;
  const modelIds = {
    small: 'onnx-community/depth-anything-v2-small',
    base: 'onnx-community/depth-anything-v2-base',
    large: 'onnx-community/depth-anything-v2-large'
  };
  let pipe = null;
  setBusy(true, 'Загрузка AI-модели…');
  try {
    const { pipeline, RawImage } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/+esm');
    const tries = modelKey === 'large'
      ? [{ device: 'webgpu', dtype: 'fp32' }, { device: 'wasm', dtype: 'q8' }]
      : [{ device: 'webgpu', dtype: 'fp32' }, { device: 'wasm', dtype: 'q8' }, { device: 'wasm', dtype: 'fp32' }];
    let lastErr = null;
    for (const t of tries) {
      try {
        status(`Загрузка ${modelKey} · ${t.device} / ${t.dtype}`);
        pipe = await pipeline('depth-estimation', modelIds[modelKey], {
          ...t,
          progress_callback: p => { if (p.progress != null) $('progressBar').style.width = Math.round(p.progress) + '%'; }
        });
        break;
      } catch (e) { lastErr = e; console.warn(e); }
    }
    if (!pipe) throw lastErr || new Error('Не удалось запустить модель');
    status('Вычисление глубины…');
    const raw = RawImage.fromCanvas ? await RawImage.fromCanvas(state.image) : state.image.toDataURL('image/png');
    const result = await pipe(raw);
    const depthImg = result.depth;
    const tmp = makeCanvas(depthImg.width, depthImg.height), ctx = tmp.getContext('2d');
    const id = ctx.createImageData(depthImg.width, depthImg.height);
    for (let i = 0; i < depthImg.width * depthImg.height; i++) {
      const v = depthImg.channels === 1 ? depthImg.data[i] : depthImg.data[i * depthImg.channels];
      id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    state.depth = resizeGray(tmp, state.image.width, state.image.height);
    state.scene = null;
    status('Карта глубины готова. Теперь построй сцену.');
    setView('depth');
  } catch (e) {
    console.error(e);
    status('AI не запустилась: ' + (e.message || e) + '. Можно импортировать свою depth PNG.', true);
  } finally {
    try { await pipe?.dispose?.(); } catch (_) {}
    setBusy(false);
  }
}

async function loadImageFile(file) {
  try {
    const im = await imageFromFile(file);
    const max = matchMedia('(max-width:700px)').matches ? 1000 : 1500;
    state.image = imageToCanvas(im, max);
    state.depth = null; state.mask = null; state.scene = null; state.source = file.name;
    showOriginal();
    status('Обложка загружена. Создай или импортируй карту глубины.');
  } catch (e) { status(e.message, true); }
}
async function loadDepthFile(file) {
  if (!state.image) return status('Сначала загрузи изображение.', true);
  try {
    const im = await imageFromFile(file);
    state.depth = resizeGray(im, state.image.width, state.image.height);
    state.scene = null;
    status('Карта глубины импортирована. Теперь построй сцену.');
    setView('depth');
  } catch (e) { status(e.message, true); }
}
async function loadMaskFile(file) {
  if (!state.image) return status('Сначала загрузи обложку.', true);
  try {
    state.mask = await imageFromFile(file);
    status('Маска загружена. Она будет использована при построении сцены.');
  } catch (e) { status(e.message, true); }
}

function standaloneHTML() {
  if (!state.scene) throw new Error('Сначала построй сцену');
  const src = state.scene.layers.map(L => ({ img: L.canvas.toDataURL('image/png'), depth: L.depth, map: L.depthMap ? buildDepthTexture(L.depthMap, state.scene.width, state.scene.height).toDataURL('image/png') : null }));
  const originalData = state.scene.original.toDataURL('image/webp', 0.92);
  const playerCode = startLDIPlayer.toString();
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DepthFlow LDI Scene</title><style>*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:#090d17;color:#fff;font:14px system-ui;display:flex;align-items:center;justify-content:center}.screen{position:relative;width:min(100vw,177.77vh);aspect-ratio:16/9;background:#11172a;overflow:hidden;touch-action:pan-y}.screen>img,.screen>canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.menu{position:fixed;right:15px;bottom:15px;display:flex;gap:8px;z-index:5}.menu button{font:inherit;padding:10px 14px;border-radius:999px;border:1px solid #8890b266;background:#171d30cc;color:#fff;backdrop-filter:blur(8px)}</style></head><body><div class="screen" id="stage"><img id="fallback"><canvas id="glCanvas"></canvas></div><div class="menu"><button id="tilt">◉ Наклон</button><button id="center">⟲ Центр</button></div><script>
  const layers = ${JSON.stringify(src)};
  const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
  const makeCanvas=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c};
  function buildDepthTexture(depthMap,w,h){if(!depthMap)return null;if((typeof HTMLCanvasElement!=='undefined'&&depthMap instanceof HTMLCanvasElement)||(typeof HTMLImageElement!=='undefined'&&depthMap instanceof HTMLImageElement)||(typeof ImageBitmap!=='undefined'&&depthMap instanceof ImageBitmap))return depthMap;const c=makeCanvas(w,h),ctx=c.getContext('2d');const id=ctx.createImageData(w,h);for(let i=0;i<w*h;i++){const v=Math.round(clamp(depthMap[i])*255);id.data[i*4]=id.data[i*4+1]=id.data[i*4+2]=v;id.data[i*4+3]=255}ctx.putImageData(id,0,0);return c}
  function makeImage(src){const i=new Image();i.src=src;return i}
  const scene={width:${state.scene.width},height:${state.scene.height},background:{toDataURL:()=>layers[0].img},original:{toDataURL:()=>${JSON.stringify(originalData)}},layers:layers.map(x=>({canvas:makeImage(x.img),depth:x.depth,depthMap:x.map?makeImage(x.map):null}))};
  ${playerCode}
  const stage=document.getElementById('stage');
  const player=startLDIPlayer(stage,scene,{canvas:document.getElementById('glCanvas'),fallback:document.getElementById('fallback'),strength:${state.strength},quality:'${state.quality}'});
  document.getElementById('tilt').onclick=async()=>{const ok=await player.permission();document.getElementById('tilt').textContent=ok?'◉ Наклон ON':'◉ Наклон'};
  document.getElementById('center').onclick=()=>player.recenter();
<\/script></body></html>`;
}


function initializeBrushMask() {
  if (!state.scene) return false;
  if (state.mask && state.mask.width === state.scene.width && state.mask.height === state.scene.height) return true;
  const {width:w,height:h,fgMask}=state.scene;
  const c=makeCanvas(w,h),ctx=c.getContext('2d');
  const id=ctx.createImageData(w,h);
  for(let i=0;i<w*h;i++){
    const v=fgMask[i]?255:0;
    id.data[i*4]=id.data[i*4+1]=id.data[i*4+2]=v;
    id.data[i*4+3]=255;
  }
  ctx.putImageData(id,0,0);state.mask=c;return true;
}
function maskPointerPoint(e){
  if(!state.scene)return null;
  const r=E.stage.getBoundingClientRect(),w=state.scene.width,h=state.scene.height;
  const fit=Math.min(r.width/w,r.height/h);
  const dw=w*fit,dh=h*fit;
  const ox=(r.width-dw)/2,oy=(r.height-dh)/2;
  const x=(e.clientX-r.left-ox)/fit,y=(e.clientY-r.top-oy)/fit;
  if(x<0||y<0||x>w||y>h)return null;
  return {x,y};
}
function brushStroke(e){
  if(!state.brushMode||!state.mask||!state.scene)return;
  const point=maskPointerPoint(e);if(!point)return;
  const ctx=state.mask.getContext('2d');
  const color=state.brushMode==='add'?'#fff':'#000';
  const radius=state.brushRadius;
  const prev=state.brushLast||point;
  ctx.strokeStyle=color;ctx.lineWidth=radius*2;ctx.lineCap='round';ctx.lineJoin='round';
  ctx.beginPath();ctx.moveTo(prev.x,prev.y);ctx.lineTo(point.x,point.y);ctx.stroke();
  const overlay=E.overlay,oc=overlay.getContext('2d');
  if(overlay.width!==state.scene.width||overlay.height!==state.scene.height){overlay.width=state.scene.width;overlay.height=state.scene.height}
  oc.clearRect(0,0,overlay.width,overlay.height);
  oc.strokeStyle=state.brushMode==='add'?'#6fffc6':'#ff7385';
  oc.lineWidth=Math.max(3,radius*.23);oc.beginPath();oc.arc(point.x,point.y,radius,0,2*Math.PI);oc.stroke();
  state.brushLast=point;
}
function setBrush(mode){
  if(mode&&!initializeBrushMask()){status('Сначала построй сцену.',true);return}
  state.brushMode=mode||'';state.brushLast=null;
  document.querySelector('#brushAdd').classList.toggle('active',mode==='add');
  document.querySelector('#brushRemove').classList.toggle('active',mode==='remove');
  E.overlay.classList.toggle('brush-on',!!mode);
  E.overlay.classList.toggle('visible',!!mode);
  E.overlay.style.pointerEvents=mode?'auto':'none';
  E.overlay.style.touchAction=mode?'none':'auto';
  if(!mode){E.overlay.getContext('2d').clearRect(0,0,E.overlay.width,E.overlay.height);status('Маска сохранена. Нажми «Построить 2.5D-сцену».')}
  else status(mode==='add'?'Кисть: добавление переднего плана':'Кисть: удаление из переднего плана');
}
$('brushAdd').onclick=()=>setBrush(state.brushMode==='add'?'':'add');
$('brushRemove').onclick=()=>setBrush(state.brushMode==='remove'?'':'remove');
$('brushStop').onclick=()=>setBrush('');
$('brushSize').oninput=e=>{state.brushRadius=Number(e.target.value);$('brushSizeVal').textContent=e.target.value+' px'};
$('smartFill').onchange=e=>{state.useSmartFill=e.target.checked};
E.overlay.addEventListener('pointerdown',e=>{
  if(!state.brushMode)return;
  e.preventDefault();state.brushActive=true;state.brushLast=null;
  try{E.overlay.setPointerCapture(e.pointerId)}catch(_){}brushStroke(e);
});
E.overlay.addEventListener('pointermove',e=>{if(state.brushActive&&state.brushMode){e.preventDefault();brushStroke(e)}});
for(const ev of ['pointerup','pointercancel'])E.overlay.addEventListener(ev,()=>{state.brushActive=false;state.brushLast=null});
E.upload.addEventListener('change', e => e.target.files[0] && loadImageFile(e.target.files[0]));
E.depth.addEventListener('change', e => e.target.files[0] && loadDepthFile(e.target.files[0]));
E.mask.addEventListener('change', e => e.target.files[0] && loadMaskFile(e.target.files[0]));
$('demoBtn').onclick = previewDemo;
$('runAi').onclick = runAI;
$('build').onclick = reconstruct;
$('qualityToggle').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.quality = b.dataset.mode;
  document.querySelectorAll('#qualityToggle button').forEach(x => x.classList.toggle('selected', x === b));
};
$('viewToggle').onclick = (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.view); };
$('edge').oninput = (e) => { state.edge = +e.target.value / 100; $('edgeVal').textContent = e.target.value + '%'; };
$('strength').oninput = (e) => { state.strength = +e.target.value / 100; $('strengthVal').textContent = e.target.value + '%'; if (state.scene && state.view === 'scene') playScene(); };
$('invert').onchange = (e) => { state.invert = e.target.checked; if (state.depth) { state.scene = null; setView('depth'); status('Инверсия будет применена при построении сцены.'); } };
$('gyro').onclick = async () => {
  if (!state.player) return status('Сначала построй сцену.', true);
  const ok = await state.player.permission(); $('gyro').textContent = ok ? '◉ Гироскоп включён' : '◉ Гироскоп';
};
$('recenter').onclick = () => state.player?.recenter();
$('saveDepth').onclick = () => {
  if (!state.depth || !state.image) return status('Сначала получи карту глубины.', true);
  const was = state.view; showDepth(); download('depthflow-depth.png', E.fallback.src); if (was === 'scene' && state.scene) playScene();
};
$('export').onclick = () => {
  try {
    const html = standaloneHTML();
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    download('depthflow-ldi-parallax.html', url);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    status('HTML экспортирован.');
  } catch (e) { status(e.message, true); }
};
const drop = $('dropzone');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) loadImageFile(e.dataTransfer.files[0]); });
$('gpuStatus').textContent = navigator.gpu ? '● WebGPU доступен' : '● WebGL2 / CPU fallback';
status('Загрузите изображение или откройте демо.');