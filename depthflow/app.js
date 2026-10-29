const $ = (id) => document.getElementById(id);
const E = {
  upload: $('fileImage'), depth: $('fileDepth'), mask: $('fileMask'),
  stage: $('stage'), fallback: $('fallback'), gl: $('glCanvas'), overlay: $('overlayCanvas'),
  hint: $('stageHint'), status: $('aiStatus')
};

const state = {
  image: null,
  depth: null,
  scene: null,
  quality: 'mobile',
  view: 'scene',
  strength: 0.32,
  edge: 0.55,
  invert: false,
  player: null,
  source: '',
  useSmartFill: false,
  inpaintModel: 'migan',
  userMask: null,
};

const modelCache = { ort: null, fill: null };

function clamp(v, a = 0, b = 1) { return Math.min(b, Math.max(a, v)); }
function smoothstep(a, b, x) { x = clamp((x - a) / (b - a)); return x * x * (3 - 2 * x); }
function lerp(a, b, t) { return a + (b - a) * t; }
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function fitDimensions(w, h, max) { const s = Math.min(1, max / Math.max(w, h)); return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]; }
function download(name, href) { const a = document.createElement('a'); a.href = href; a.download = name; a.click(); }
function status(msg, error = false) { E.status.textContent = msg; E.status.classList.toggle('error', !!error); }
function setBusy(b, msg) {
  for (const id of ['runAi', 'build']) { const el = $(id); if (el) el.disabled = b; }
  $('aiProgress').hidden = !b;
  $('progressBar').style.width = b ? '42%' : '0%';
  if (msg) status(msg);
}
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
function imageToCanvas(im, max = 1400) {
  const [w, h] = fitDimensions(im.naturalWidth || im.width, im.naturalHeight || im.height, max);
  const c = makeCanvas(w, h);
  c.getContext('2d', { willReadFrequently: true }).drawImage(im, 0, 0, w, h);
  return c;
}
function resizeGray(im, w, h) {
  const c = makeCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(im, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 765;
  return out;
}
function showRasterFromCanvas(canvas, label = 'Изображение') {
  stopPlayer();
  E.hint.classList.add('hidden');
  E.fallback.src = canvas.toDataURL('image/webp', 0.95);
  E.fallback.classList.add('visible');
  E.gl.classList.remove('visible');
  E.overlay.classList.remove('visible');
  $('imageSize').textContent = `${canvas.width} × ${canvas.height}`;
  $('renderMode').textContent = label;
}
function showOriginal() { if (state.image) showRasterFromCanvas(state.image, 'Исходник'); }
function showDepth() {
  if (!state.depth || !state.image) return;
  const c = makeCanvas(state.image.width, state.image.height), ctx = c.getContext('2d');
  const id = ctx.createImageData(c.width, c.height);
  for (let i = 0; i < state.depth.length; i++) {
    const v = Math.round((state.invert ? 1 - state.depth[i] : state.depth[i]) * 255);
    id.data.set([v, v, v, 255], i * 4);
  }
  ctx.putImageData(id, 0, 0);
  showRasterFromCanvas(c, 'Карта глубины');
}
function showMask() {
  if (!state.scene) return showOriginal();
  const { paddedTexture, repairMask } = state.scene;
  const c = makeCanvas(paddedTexture.width, paddedTexture.height), ctx = c.getContext('2d');
  ctx.drawImage(paddedTexture, 0, 0);
  const overlay = ctx.createImageData(c.width, c.height);
  for (let i = 0; i < repairMask.length; i++) {
    if (!repairMask[i]) continue;
    overlay.data[i * 4] = 140; overlay.data[i * 4 + 1] = 234; overlay.data[i * 4 + 2] = 255; overlay.data[i * 4 + 3] = 150;
  }
  const lay = makeCanvas(c.width, c.height); lay.getContext('2d').putImageData(overlay, 0, 0);
  ctx.drawImage(lay, 0, 0);
  showRasterFromCanvas(c, 'Зона texture repair');
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
  const w = 1280, h = 720, c = makeCanvas(w, h), g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, '#0e183f'); grd.addColorStop(0.45, '#2978c9'); grd.addColorStop(0.76, '#f0a369'); grd.addColorStop(1, '#10192d');
  g.fillStyle = grd; g.fillRect(0, 0, w, h);
  g.fillStyle = '#fafcff';
  for (let i = 0; i < 20; i++) { g.beginPath(); g.arc(60 + i * 60, 120 + (i % 3) * 15, 18 + (i % 4) * 12, 0, 7); g.fill(); }
  g.strokeStyle = '#8be7ff'; g.lineWidth = 9; g.shadowColor = '#52d3ff'; g.shadowBlur = 18;
  g.beginPath(); g.moveTo(990, -20); g.bezierCurveTo(860, 86, 770, 170, 710, 450); g.stroke(); g.shadowBlur = 0;
  g.fillStyle = '#122139';
  for (let i = 0; i < 84; i++) { const x = i * 16, hh = 35 + ((i * 23) % 180); g.fillRect(x, 500 - hh, 13, hh + 220); }
  g.fillStyle = '#1e3053'; g.fillRect(0, 510, 610, 210);
  g.fillStyle = '#4c8a55'; g.beginPath(); g.moveTo(620, 720); g.lineTo(760, 520); g.lineTo(1280, 490); g.lineTo(1280, 720); g.fill();
  g.fillStyle = '#171a2f';
  g.beginPath(); g.arc(390, 430, 18, 0, 7); g.fill(); g.fillRect(377, 448, 28, 92);
  g.beginPath(); g.moveTo(380, 539); g.lineTo(358, 632); g.lineTo(375, 632); g.lineTo(394, 559); g.lineTo(408, 631); g.lineTo(425, 631); g.lineTo(409, 540); g.fill();
  g.fillStyle = '#2a2440';
  g.beginPath(); g.arc(885, 444, 18, 0, 7); g.fill(); g.fillRect(873, 462, 28, 82);
  g.beginPath(); g.moveTo(874, 542); g.lineTo(856, 605); g.lineTo(872, 605); g.lineTo(888, 560); g.lineTo(904, 604); g.lineTo(920, 604); g.lineTo(901, 542); g.fill();
  return c;
}
function demoDepth(c) {
  const w = c.width, h = c.height, d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0.18 + 0.38 * (y / h);
    if (x > 730 && y > 500 - (x - 730) * 0.09) v = 0.75;
    if ((x > 350 && x < 430 && y > 410 && y < 635) || (x > 850 && x < 920 && y > 420 && y < 610)) v = 0.92;
    d[y * w + x] = v;
  }
  return d;
}
function previewDemo() {
  state.image = demoArt();
  state.depth = demoDepth(state.image);
  state.scene = null;
  state.source = 'Демосцена';
  $('layerCount').textContent = '1 plane';
  $('meshCount').textContent = '—';
  showOriginal();
  status('Демосцена готова. Нажми «Построить 3D-plane сцену».');
}

function boxBlurFloat(src, w, h, radius = 1) {
  if (radius <= 0) return new Float32Array(src);
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length), size = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[y * w + Math.max(0, Math.min(w - 1, k))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / size;
      const x0 = Math.max(0, Math.min(w - 1, x - radius));
      const x1 = Math.max(0, Math.min(w - 1, x + radius + 1));
      sum += src[y * w + x1] - src[y * w + x0];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[Math.max(0, Math.min(h - 1, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / size;
      const y0 = Math.max(0, Math.min(h - 1, y - radius));
      const y1 = Math.max(0, Math.min(h - 1, y + radius + 1));
      sum += tmp[y1 * w + x] - tmp[y0 * w + x];
    }
  }
  return out;
}
function refineDepth(depth, rgba, w, h, strength) {
  let cur = new Float32Array(depth);
  const out = new Float32Array(depth.length);
  const iterations = strength > 0.68 ? 2 : 1;
  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const p = i * 4;
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      let sum = cur[i] * 3.0, wsum = 3.0;
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx, q = j * 4;
        const cd = (Math.abs(r - rgba[q]) + Math.abs(g - rgba[q + 1]) + Math.abs(b - rgba[q + 2])) / 765;
        const dd = Math.abs(cur[i] - cur[j]);
        const wt = Math.exp(-cd * (8 + strength * 24) - dd * 15);
        sum += cur[j] * wt; wsum += wt;
      }
      out[i] = sum / wsum;
    }
    cur = new Float32Array(out);
  }
  return cur;
}
function floatDepthToCanvas(depth, w, h) {
  const c = makeCanvas(w, h), ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  for (let i = 0; i < depth.length; i++) {
    const v = Math.round(clamp(depth[i]) * 255);
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}
function canvasToRGBA(canvas) { return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data; }

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
function chwRGBFromRGBA(rgba, w, h) {
  const out = new Uint8Array(3 * w * h);
  const plane = w * h;
  for (let i = 0; i < plane; i++) {
    out[i] = rgba[i * 4]; out[plane + i] = rgba[i * 4 + 1]; out[2 * plane + i] = rgba[i * 4 + 2];
  }
  return out;
}
function grayscaleMaskToUint8(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = mask[i] ? 0 : 255;
  return out;
}
async function smartFillPadded(canvas, repairMask) {
  const W = canvas.width, H = canvas.height;
  const fillArea = repairMask.reduce((a, b) => a + b, 0) / repairMask.length;
  if (fillArea < 0.001) return null;
  try {
    const ort = await ensureOrt();
    if (!modelCache.fill) {
      status('Загрузка маленькой AI-inpaint модели…');
      modelCache.fill = await ort.InferenceSession.create(
        'https://huggingface.co/edgetools/migan/resolve/main/migan_pipeline_v2.onnx',
        { executionProviders: navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'], graphOptimizationLevel: 'all' }
      );
    }
    // Downscale to keep the model lightweight.
    const maxSide = 512;
    const [rw, rh] = fitDimensions(W, H, maxSide);
    const rc = makeCanvas(rw, rh), rctx = rc.getContext('2d', { willReadFrequently: true });
    rctx.drawImage(canvas, 0, 0, rw, rh);
    const rgba = rctx.getImageData(0, 0, rw, rh).data;
    const maskCanvas = makeCanvas(rw, rh), mctx = maskCanvas.getContext('2d');
    const mid = mctx.createImageData(rw, rh);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const sx = Math.min(W - 1, Math.round(x / rw * W));
      const sy = Math.min(H - 1, Math.round(y / rh * H));
      const v = repairMask[sy * W + sx] ? 255 : 0;
      const p = (y * rw + x) * 4; mid.data[p] = mid.data[p + 1] = mid.data[p + 2] = v; mid.data[p + 3] = 255;
    }
    mctx.putImageData(mid, 0, 0);
    const maskData = mctx.getImageData(0, 0, rw, rh).data;
    const maskMono = new Uint8Array(rw * rh);
    for (let i = 0; i < rw * rh; i++) maskMono[i] = maskData[i * 4] > 0 ? 1 : 0;

    const imageTensor = new ort.Tensor('uint8', chwRGBFromRGBA(rgba, rw, rh), [1, 3, rh, rw]);
    const maskTensor = new ort.Tensor('uint8', grayscaleMaskToUint8(maskMono, rw, rh), [1, 1, rh, rw]);
    status('AI texture repair…');
    const result = await modelCache.fill.run({ image: imageTensor, mask: maskTensor });
    const outT = result.result || result.output || Object.values(result)[0];
    if (!outT?.data) return null;
    const out = new Uint8ClampedArray(rw * rh * 4);
    const src = outT.data, plane = rw * rh;
    for (let i = 0; i < plane; i++) {
      let r = src[i], g = src[plane + i], b = src[plane * 2 + i];
      if (r <= 1 && g <= 1 && b <= 1) { r *= 255; g *= 255; b *= 255; }
      out[i * 4] = clamp(Math.round(r), 0, 255);
      out[i * 4 + 1] = clamp(Math.round(g), 0, 255);
      out[i * 4 + 2] = clamp(Math.round(b), 0, 255);
      out[i * 4 + 3] = 255;
    }
    const outCanvas = makeCanvas(rw, rh);
    outCanvas.getContext('2d').putImageData(new ImageData(out, rw, rh), 0, 0);
    const finalCanvas = makeCanvas(W, H);
    finalCanvas.getContext('2d').drawImage(outCanvas, 0, 0, W, H);
    return finalCanvas;
  } catch (e) {
    console.warn('smart fill failed', e);
    return null;
  }
}

function buildEdgeExtendedTexture(srcCanvas, pad) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const W = w + pad * 2, H = h + pad * 2;
  const out = makeCanvas(W, H), ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(srcCanvas, pad, pad);
  // Extend edges.
  ctx.drawImage(srcCanvas, 0, 0, w, 1, pad, 0, w, pad); // top
  ctx.drawImage(srcCanvas, 0, h - 1, w, 1, pad, pad + h, w, pad); // bottom
  ctx.drawImage(srcCanvas, 0, 0, 1, h, 0, pad, pad, h); // left
  ctx.drawImage(srcCanvas, w - 1, 0, 1, h, pad + w, pad, pad, h); // right
  ctx.drawImage(srcCanvas, 0, 0, 1, 1, 0, 0, pad, pad);
  ctx.drawImage(srcCanvas, w - 1, 0, 1, 1, pad + w, 0, pad, pad);
  ctx.drawImage(srcCanvas, 0, h - 1, 1, 1, 0, pad + h, pad, pad);
  ctx.drawImage(srcCanvas, w - 1, h - 1, 1, 1, pad + w, pad + h, pad, pad);

  const img = ctx.getImageData(0, 0, W, H);
  const repairMask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (x < pad || y < pad || x >= pad + w || y >= pad + h) repairMask[i] = 1;
  }
  // Soften only the padded ring with small blur to avoid obvious stretched edge lines.
  const copy = new Uint8ClampedArray(img.data);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x; if (!repairMask[i]) continue;
      const p = i * 4;
      for (let c = 0; c < 3; c++) {
        img.data[p + c] = Math.round((copy[p + c] * 2 + copy[p - 4 + c] + copy[p + 4 + c] + copy[p - W * 4 + c] + copy[p + W * 4 + c]) / 6);
      }
      img.data[p + 3] = 255;
    }
    copy.set(img.data);
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: out, repairMask };
}
function buildPaddedDepth(depth, w, h, pad) {
  const W = w + pad * 2, H = h + pad * 2;
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = Math.max(0, Math.min(w - 1, x - pad));
    const sy = Math.max(0, Math.min(h - 1, y - pad));
    out[y * W + x] = depth[sy * w + sx];
  }
  return out;
}
function composeMaskCanvas(mask, w, h) {
  const c = makeCanvas(w, h), ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 255 : 0;
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

async function buildDepthPlaneScene(imageCanvas, depthArr) {
  const max = state.quality === 'mobile' ? 1000 : 1400;
  const [w, h] = fitDimensions(imageCanvas.width, imageCanvas.height, max);
  const src = makeCanvas(w, h), sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(imageCanvas, 0, 0, w, h);
  const rgba = sctx.getImageData(0, 0, w, h).data;

  let depth = depthArr;
  if (depth.length !== w * h) {
    const dc = floatDepthToCanvas(depthArr, imageCanvas.width, imageCanvas.height);
    depth = resizeGray(dc, w, h);
  }
  if (state.invert) depth = Float32Array.from(depth, v => 1 - v);
  depth = refineDepth(depth, rgba, w, h, state.edge);
  depth = boxBlurFloat(depth, w, h, state.quality === 'mobile' ? 1 : 2);

  const pad = Math.round(Math.max(w, h) * (state.quality === 'mobile' ? 0.08 : 0.12));
  let { canvas: paddedTexture, repairMask } = buildEdgeExtendedTexture(src, pad);
  const paddedDepth = buildPaddedDepth(depth, w, h, pad);

  if (state.useSmartFill) {
    const improved = await smartFillPadded(paddedTexture, repairMask);
    if (improved) paddedTexture = improved;
  }

  const paddedDepthCanvas = floatDepthToCanvas(paddedDepth, paddedTexture.width, paddedTexture.height);
  return {
    width: paddedTexture.width,
    height: paddedTexture.height,
    innerWidth: w,
    innerHeight: h,
    pad,
    paddedTexture,
    fallbackCanvas: src,
    paddedDepth,
    paddedDepthCanvas,
    repairMask,
    source: state.source,
  };
}

async function reconstruct() {
  if (!state.image || !state.depth) return status('Сначала загрузи обложку и карту глубины.', true);
  setBusy(true, 'Строю 3D-plane по depth map…');
  try {
    state.scene = await buildDepthPlaneScene(state.image, state.depth);
    $('layerCount').textContent = '1 plane';
    $('meshCount').textContent = state.quality === 'mobile' ? '96 × 54' : '160 × 90';
    $('imageSize').textContent = `${state.scene.width} × ${state.scene.height}`;
    status('3D-plane сцена готова. Глубина полностью управляет деформацией меша.');
    setView('scene');
  } catch (e) {
    console.error(e);
    status('Не удалось построить сцену: ' + (e.message || e), true);
  } finally {
    setBusy(false);
  }
}

function createPlaneMesh(gx, gy) {
  const verts = [];
  for (let y = 0; y < gy; y++) {
    for (let x = 0; x < gx; x++) {
      const u0 = x / gx, u1 = (x + 1) / gx, v0 = y / gy, v1 = (y + 1) / gy;
      const tri = [[u0,v0],[u0,v1],[u1,v0],[u1,v0],[u0,v1],[u1,v1]];
      for (const [u,v] of tri) verts.push(u, v);
    }
  }
  return new Float32Array(verts);
}

function startPlanePlayer(stage, scene, options = {}) {
  const canvas = options.canvas || document.createElement('canvas');
  const fallback = options.fallback || null;
  const quality = options.quality || 'mobile';
  const strength = options.strength ?? 0.32;
  const textureCanvas = scene.paddedTexture;
  const depthCanvas = scene.paddedDepthCanvas;
  const sourceWidth = scene.innerWidth || scene.width;
  const sourceHeight = scene.innerHeight || scene.height;
  const padding = scene.pad || 0;

  let gl = null, prog = null, vbo = null, texImage = null, texDepth = null;
  let alive = true, raf = 0;
  let current = { x: 0, y: 0 }, target = { x: 0, y: 0 };
  let orientationEnabled = false, neutral = null;

  function updateTargetFromPointer(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    target.x = clamp((clientX - r.left) / r.width, 0, 1) * 2 - 1;
    target.y = clamp((clientY - r.top) / r.height, 0, 1) * 2 - 1;
  }
  function onMove(e) { updateTargetFromPointer(e.clientX, e.clientY); }
  function onLeave() { target.x = target.y = 0; }
  function onOrientation(e) {
    if (!orientationEnabled || e.beta == null || e.gamma == null) return;
    if (!neutral) neutral = { beta: e.beta, gamma: e.gamma };
    target.x = clamp((e.gamma - neutral.gamma) / 18, -1, 1);
    target.y = clamp((e.beta - neutral.beta) / 18, -1, 1);
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

  if (fallback) { const img=scene.fallbackCanvas || textureCanvas; fallback.src = img.toDataURL ? img.toDataURL('image/webp', 0.94) : img.src; fallback.classList.add('visible'); }
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerleave', onLeave);

  const vs = `#version 300 es
  precision highp float;
  in vec2 aUv;
  uniform sampler2D uDepth;
  uniform vec2 uAngles;
  uniform vec2 uFit;
  uniform vec2 uImageSize;
  uniform vec4 uContentRect;
  uniform float uScreenAspect;
  uniform float uDepthScale;
  out vec2 vUv;
  out float vDepth;
  vec3 rotateX(vec3 p, float a){ float c=cos(a), s=sin(a); return vec3(p.x, p.y*c - p.z*s, p.y*s + p.z*c); }
  vec3 rotateY(vec3 p, float a){ float c=cos(a), s=sin(a); return vec3(p.x*c + p.z*s, p.y, -p.x*s + p.z*c); }
  void main(){
    // DOM image upload + UV (0,0)=top-left; do NOT flip the source texture.
    float d=texture(uDepth,aUv).r;
    float z=(d-0.5)*uDepthScale;
    float imageAspect=uImageSize.x/uImageSize.y;
    vec2 contentUv=(aUv-uContentRect.xy)/uContentRect.zw;
    vec3 unrotated=vec3((contentUv.x-0.5)*2.0*imageAspect,(0.5-contentUv.y)*2.0,z);
    vec3 rotated=rotateY(rotateX(unrotated,uAngles.y),uAngles.x);
    // Neutral camera is EXACTLY identical to the original image: no squashed overlay.
    float cameraDist=3.8;
    float neutralPerspective=(cameraDist-z)/(cameraDist-rotated.z);
    vec2 projected=vec2(rotated.x/imageAspect,rotated.y)*uFit*neutralPerspective;
    gl_Position=vec4(projected,0.0,1.0);
    vUv=aUv;
    vDepth=d;
  }`;
  const fs = `#version 300 es
  precision highp float;
  uniform sampler2D uImage;
  uniform vec4 uContentRect;
  uniform float uReveal;
  in vec2 vUv;
  in float vDepth;
  out vec4 outColor;
  void main(){
    // Hide padded area when camera is neutral; expose only the required repair margin on tilt.
    vec2 cuv=(vUv-uContentRect.xy)/uContentRect.zw;
    float outside=max(max(-cuv.x,cuv.x-1.0),max(-cuv.y,cuv.y-1.0));
    if(outside>uReveal) discard;
    outColor=texture(uImage,vUv);
  }`;

  function initGL() {
    try {
      gl = canvas.getContext('webgl2', { alpha: true, antialias: true });
      if (!gl) throw new Error('webgl2 unavailable');
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

      const gx = quality === 'mobile' ? 96 : 160;
      const gy = quality === 'mobile' ? 54 : 90;
      const mesh = createPlaneMesh(gx, gy);
      vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
      const mkTex = (source) => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
      };
      texImage = mkTex(textureCanvas);
      texDepth = mkTex(depthCanvas);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      options.onMode?.('WebGL2 · depth plane');
      return true;
    } catch (e) {
      console.warn('gl failed', e);
      gl = null;
      options.onMode?.('Canvas 2D · fallback');
      return false;
    }
  }

  let ctx2 = null;
  function ensure2D() { ctx2 = canvas.getContext('2d', { alpha: true }); return !!ctx2; }

  function frame() {
    if (!alive) return;
    current.x += (target.x - current.x) * 0.10;
    current.y += (target.y - current.y) * 0.10;
    const rect = stage.getBoundingClientRect();
    const cw = Math.max(1, Math.round(rect.width * Math.min(devicePixelRatio || 1, 2)));
    const ch = Math.max(1, Math.round(rect.height * Math.min(devicePixelRatio || 1, 2)));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    const aspect = sourceWidth / sourceHeight;
    const rx = current.x * strength * 0.24;
    const ry = -current.y * strength * 0.18;

    if (gl) {
      try {
        gl.viewport(0, 0, cw, ch);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        const aUv = gl.getAttribLocation(prog, 'aUv');
        gl.enableVertexAttribArray(aUv);
        gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 8, 0);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texImage);
        gl.uniform1i(gl.getUniformLocation(prog, 'uImage'), 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texDepth);
        gl.uniform1i(gl.getUniformLocation(prog, 'uDepth'), 1);
        gl.uniform2f(gl.getUniformLocation(prog, 'uAngles'), rx, ry);
        gl.uniform2f(gl.getUniformLocation(prog, 'uTexel'), 1 / scene.width, 1 / scene.height);
        // Aspect-correct object-fit: contain. Portrait art stays portrait in 16:9 viewer.
        const screenAspect=cw/ch;
        const fitX=Math.min(1.0,aspect/screenAspect);
        const fitY=Math.min(1.0,screenAspect/aspect);
        gl.uniform2f(gl.getUniformLocation(prog,'uFit'),fitX,fitY);
        gl.uniform2f(gl.getUniformLocation(prog,'uImageSize'),sourceWidth,sourceHeight);
        gl.uniform4f(gl.getUniformLocation(prog,'uContentRect'),padding/scene.width,padding/scene.height,sourceWidth/scene.width,sourceHeight/scene.height);
        gl.uniform1f(gl.getUniformLocation(prog,'uReveal'),Math.min(0.08,Math.max(Math.abs(rx),Math.abs(ry))*0.5));
        gl.uniform1f(gl.getUniformLocation(prog,'uScreenAspect'),screenAspect);
        gl.uniform1f(gl.getUniformLocation(prog,'uDepthScale'),quality === 'mobile' ? 0.48 : 0.58);
        const count = (quality === 'mobile' ? 96 * 54 : 160 * 90) * 6;
        gl.drawArrays(gl.TRIANGLES, 0, count);
      } catch (e) {
        console.warn('frame failed', e); gl = null; ensure2D();
      }
    }
    if (!gl) {
      if (!ctx2 && !ensure2D()) { options.onMode?.('Исходная обложка'); return; }
      ctx2.clearRect(0, 0, cw, ch);
      const ratio = scene.width / scene.height;
      const fitW = ratio > cw / ch ? cw : ch * ratio;
      const fitH = ratio > cw / ch ? cw / ratio : ch;
      ctx2.save();
      ctx2.translate(cw / 2, ch / 2);
      ctx2.scale(1 + rx * 0.08, 1 + ry * 0.08);
      ctx2.rotate(rx * 0.08);
      ctx2.drawImage(textureCanvas, -fitW / 2 + rx * 28, -fitH / 2 + ry * 28, fitW, fitH);
      ctx2.restore();
    }
    raf = requestAnimationFrame(frame);
  }

  canvas.style.display = 'block';
  const inputs=[textureCanvas,depthCanvas].filter(x => x instanceof HTMLImageElement);
  Promise.all(inputs.map(im=>im.decode().catch(()=>{}))).then(()=>{
    if(!alive) return;
    if (!initGL()) ensure2D();
    frame();
  });

  return {
    dispose() {
      alive = false; cancelAnimationFrame(raf);
      stage.removeEventListener('pointermove', onMove); stage.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('deviceorientation', onOrientation);
      if (gl) {
        if (texImage) gl.deleteTexture(texImage); if (texDepth) gl.deleteTexture(texDepth);
        if (vbo) gl.deleteBuffer(vbo); if (prog) gl.deleteProgram(prog);
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
  state.player = startPlanePlayer(E.stage, state.scene, {
    canvas: E.gl, fallback: E.fallback, quality: state.quality, strength: state.strength,
    onMode(mode) { $('renderMode').textContent = mode; },
  });
}

async function runAI() {
  if (!state.image) return status('Сначала загрузи изображение.', true);
  const modelKey = $('model').value;
  const models = {
    small: 'onnx-community/depth-anything-v2-small',
    base: 'onnx-community/depth-anything-v2-base',
    large: 'onnx-community/depth-anything-v2-large',
  };
  let pipe = null;
  setBusy(true, 'Загрузка AI-модели глубины…');
  try {
    const { pipeline, RawImage } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/+esm');
    const attempts = modelKey === 'large'
      ? [{ device: 'webgpu', dtype: 'fp32' }, { device: 'wasm', dtype: 'q8' }]
      : [{ device: 'webgpu', dtype: 'fp32' }, { device: 'wasm', dtype: 'q8' }, { device: 'wasm', dtype: 'fp32' }];
    let lastError = null;
    for (const cfg of attempts) {
      try {
        status(`Загрузка ${modelKey} · ${cfg.device} / ${cfg.dtype}`);
        pipe = await pipeline('depth-estimation', models[modelKey], {
          ...cfg,
          progress_callback: p => { if (p.progress != null) $('progressBar').style.width = Math.round(p.progress) + '%'; }
        });
        break;
      } catch (e) { lastError = e; }
    }
    if (!pipe) throw lastError || new Error('Не удалось запустить модель');
    status('Вычисление карты глубины…');
    const raw = RawImage.fromCanvas ? await RawImage.fromCanvas(state.image) : state.image.toDataURL('image/png');
    const result = await pipe(raw);
    const depthImg = result.depth;
    const tmp = makeCanvas(depthImg.width, depthImg.height), ctx = tmp.getContext('2d');
    const id = ctx.createImageData(depthImg.width, depthImg.height);
    for (let i = 0; i < depthImg.width * depthImg.height; i++) {
      const v = depthImg.channels === 1 ? depthImg.data[i] : depthImg.data[i * depthImg.channels];
      const q = Math.round(v <= 1 ? v * 255 : v);
      id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = q; id.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    state.depth = resizeGray(tmp, state.image.width, state.image.height);
    state.scene = null;
    status('Карта глубины готова. Теперь построй 3D-plane сцену.');
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
    const max = matchMedia('(max-width:700px)').matches ? 1100 : 1600;
    state.image = imageToCanvas(im, max);
    state.depth = null; state.scene = null; state.source = file.name;
    $('layerCount').textContent = '1 plane'; $('meshCount').textContent = '—';
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
    status('Карта глубины импортирована. Теперь построй 3D-plane сцену.');
    setView('depth');
  } catch (e) { status(e.message, true); }
}
async function loadMaskFile(file) {
  // Kept only as optional future repair guide; not used in the pure depth-plane pipeline.
  if (!state.image) return status('Сначала загрузи изображение.', true);
  try {
    state.userMask = await imageFromFile(file);
    status('Дополнительная маска загружена. В текущем depth-plane режиме она не обязательна.');
  } catch (e) { status(e.message, true); }
}

function standaloneHTML() {
  if (!state.scene) throw new Error('Сначала построй сцену');
  const sceneData = {
    width: state.scene.width,
    height: state.scene.height,
    innerWidth: state.scene.innerWidth,
    innerHeight: state.scene.innerHeight,
    pad: state.scene.pad,
    fallback: state.scene.fallbackCanvas.toDataURL('image/png'),
    texture: state.scene.paddedTexture.toDataURL('image/png'),
    depth: state.scene.paddedDepthCanvas.toDataURL('image/png'),
    strength: state.strength,
    quality: state.quality,
  };
  const playerCode = startPlanePlayer.toString();
  const meshCode = createPlaneMesh.toString();
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DepthFlow Depth Plane</title><style>*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:#090d17;color:#fff;font:14px system-ui;display:flex;align-items:center;justify-content:center}.screen{position:relative;width:min(100vw,177.77vh);aspect-ratio:16/9;background:#11172a;overflow:hidden;touch-action:pan-y}.screen>img,.screen>canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.menu{position:fixed;right:15px;bottom:15px;display:flex;gap:8px;z-index:5}.menu button{font:inherit;padding:10px 14px;border-radius:999px;border:1px solid #8890b266;background:#171d30cc;color:#fff;backdrop-filter:blur(8px)}</style></head><body><div class="screen" id="stage"><img id="fallback"><canvas id="glCanvas"></canvas></div><div class="menu"><button id="tilt">◉ Наклон</button><button id="center">⟲ Центр</button></div><script>
const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
const tex=new Image(); tex.src=${JSON.stringify(sceneData.texture)};
const dep=new Image(); dep.src=${JSON.stringify(sceneData.depth)};
const orig=new Image();orig.src=${JSON.stringify(sceneData.fallback)};
const scene={width:${sceneData.width},height:${sceneData.height},innerWidth:${sceneData.innerWidth},innerHeight:${sceneData.innerHeight},pad:${sceneData.pad},fallbackCanvas:orig,paddedTexture:tex,paddedDepthCanvas:dep};
${meshCode}
${playerCode}
const stage=document.getElementById('stage');
const player=startPlanePlayer(stage,scene,{canvas:document.getElementById('glCanvas'),fallback:document.getElementById('fallback'),quality:${JSON.stringify(sceneData.quality)},strength:${sceneData.strength}});
document.getElementById('tilt').onclick=async()=>{const ok=await player.permission();document.getElementById('tilt').textContent=ok?'◉ Наклон ON':'◉ Наклон'};
document.getElementById('center').onclick=()=>player.recenter();
<\/script></body></html>`;
}

E.upload.addEventListener('change', e => e.target.files[0] && loadImageFile(e.target.files[0]));
E.depth.addEventListener('change', e => e.target.files[0] && loadDepthFile(e.target.files[0]));
E.mask?.addEventListener('change', e => e.target.files[0] && loadMaskFile(e.target.files[0]));
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
$('smartFill').onchange = (e) => { state.useSmartFill = e.target.checked; };
$('gyro').onclick = async () => {
  if (!state.player) return status('Сначала построй сцену.', true);
  const ok = await state.player.permission(); $('gyro').textContent = ok ? '◉ Гироскоп включён' : '◉ Гироскоп';
};
$('recenter').onclick = () => state.player?.recenter();
$('saveDepth').onclick = () => {
  if (!state.depth || !state.image) return status('Сначала получи карту глубины.', true);
  const prev = state.view; showDepth(); download('depthflow-depth.png', E.fallback.src); if (prev === 'scene' && state.scene) playScene();
};
$('export').onclick = () => {
  try {
    const html = standaloneHTML();
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    download('depthflow-depth-plane.html', url);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    status('HTML экспортирован.');
  } catch (e) { status(e.message, true); }
};
const drop = $('dropzone');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) loadImageFile(e.dataTransfer.files[0]); });
$('gpuStatus').textContent = navigator.gpu ? '● WebGPU/AI доступен' : '● WebGL2 / CPU fallback';
// Disable old brush UI; this version focuses on pure depth-plane rendering.
['brushAdd','brushRemove','brushStop','brushSize'].forEach(id => { const el = $(id); if (el) el.disabled = true; });
const live = $('liveInfo'); if (live) live.textContent = 'Перемещай курсор над сценой. В этой версии объём формируется одной depth-driven 3D plane сеткой, без сегментации.';
status('Загрузите изображение или откройте демо.');