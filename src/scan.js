// Only loaded when someone requests a scan. Models, worker and engine are served
// by this site. All recognition happens on the device.
import {createWorker, OEM} from 'tesseract.js';
import {simd} from 'wasm-feature-detect';
import workerUrl from 'tesseract.js/dist/worker.min.js?url';
import coreUrl from 'tesseract.js-core/tesseract-core-lstm.wasm.js?url';
import fastCoreUrl from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url';
import {preparePdfViewer} from './documents.js';

const maxRaster = 5_000_000;

function surface(width, height, desiredScale) {
  const scale = Math.min(desiredScale, Math.sqrt(maxRaster / (width*height)), 3600 / Math.max(width,height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width*scale));
  canvas.height = Math.max(1, Math.round(height*scale));
  return {canvas, scale};
}

async function readPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve,reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('This photo could not be opened. Try a JPEG or PNG copy.'));
      image.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 60_000_000)
      throw new Error('This photo is too large to read on this device. Crop it to the page and try again.');
    const {canvas} = surface(image.naturalWidth,image.naturalHeight,1.5);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(image,0,0,canvas.width,canvas.height);
    return canvas;
  } finally { URL.revokeObjectURL(url); }
}

async function pdfCanvas(viewer, number) {
  const page = await viewer.getPage(number);
  try {
    const size = page.getViewport({scale:1});
    const {canvas,scale} = surface(size.width,size.height,3);
    await page.render({canvas,canvasContext:canvas.getContext('2d'),viewport:page.getViewport({scale})}).promise;
    return canvas;
  } finally { page.cleanup(); }
}

export async function recognizeFile(file, inputPages, {signal, progress}) {
  const pages = inputPages.map(page => ({...page}));
  const positions = pages.map((page,index) => page.text.trim() ? -1 : index).filter(index => index >= 0);
  if (!positions.length) return {pages,warnings:[]};
  signal.throwIfAborted();
  let worker, viewer, timeout, finished = false, current = 1;
  let failTask;
  const stopped = new Promise((_, reject) => { failTask = reject; });
  const abort = () => failTask(new DOMException('Reading stopped.','AbortError'));
  const tick = () => {
    clearTimeout(timeout);
    timeout = setTimeout(()=>failTask(new Error('The scan reader took too long. Try a clearer photo or paste the text.')),60000);
  };
  signal.addEventListener('abort',abort,{once:true});
  tick();
  async function read() {
    progress('Loading the scan reader…');
    const fast = await simd();
    if (finished) return;
    worker = await createWorker('eng+fra',OEM.LSTM_ONLY,{
      langPath:new URL('/assets/scan-lang-v1/',location.origin).href,
      workerPath:workerUrl, corePath:fast ? fastCoreUrl : coreUrl,
      workerBlobURL:false, cacheMethod:'none',
      logger:message => {
        if (finished) return;
        tick();
        if (message.status === 'recognizing text') progress('Reading page '+current+' of '+pages.length+' · '+Math.round(message.progress*100)+'%');
      },
      errorHandler:()=>failTask(new Error('The scan reader could not read this file. Try another copy or paste the text.')),
    });
    if (finished) { await worker.terminate(); return; }
    await worker.setParameters({user_defined_dpi:'250'});
    if (/\.pdf$/iu.test(file.name)) {
      viewer = await preparePdfViewer(new Uint8Array(await file.arrayBuffer()));
      if (finished) { await viewer.destroy(); return; }
    }
    const warnings = [];
    let characters = pages.reduce((sum,p)=>sum+p.text.length,0), recovered = 0;
    for (const i of positions) {
      signal.throwIfAborted();
      if (finished) break;
      current = pages[i].page;
      progress('Reading page '+current+' of '+pages.length+'…');
      const canvas = viewer ? await pdfCanvas(viewer,current) : await readPhoto(file);
      try {
        if (finished) break;
        const {data} = await worker.recognize(canvas, {rotateAuto:true});
        const text = data.text.trim();
        if (data.confidence < 45 || !/\p{L}{2}/u.test(text)) {
          warnings.push('Page '+current+' was too faint to read reliably. Check the original.');
          continue;
        }
        recovered++;
        characters += text.length;
        if (characters > 150000) throw new Error('This scan has too much text. Choose the pages you need.');
        pages[i] = {page:current,text};
      } finally { canvas.width = canvas.height = 1; }
    }
    if (!recovered) throw new Error('No clear text was found. Try a brighter photo, paste text or type it in.');
    warnings.unshift('Read from a scan. Check names, dates and numbers against the original.');
    return {pages,warnings};
  }
  try {
    return await Promise.race([read(), stopped]);
  } finally {
    finished = true;
    clearTimeout(timeout);
    signal.removeEventListener('abort',abort);
    await worker?.terminate();
    await viewer?.destroy().catch(()=>{});
  }
}
