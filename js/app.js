/* Convertidor de Audio — Client-side with FFmpeg.wasm (ESM) */

// ---------- Límites (ajustables) ----------
const MAX_FILE_BYTES = 500 * 1024 * 1024; // FFmpeg.wasm trabaja en memoria (tope de ~2 GB)
const MAX_FILES = 50;
const AUDIO_VIDEO_EXT = /\.(mp3|wav|m4a|flac|ogg|aac|aiff|amr|mp2|wma|opus|m4r|caf|ac3|mp4|mov|webm|mkv|avi)$/i;
// Frecuencia máxima admitida por algunos codificadores (evita errores con 96 kHz)
const MAX_SAMPLE_RATE = { mp3: 48000, mp2: 48000, ac3: 48000, wma: 48000, amr: 8000 };

async function readFileBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

// ---------- State ----------
let selectedFiles = [];
let outputFormat = 'mp3';
let qualityIndex = 2;
let ffmpeg = null;
let ffmpegLoaded = false;
let ffmpegLoading = null;   // promesa única de carga (evita cargas duplicadas)
let converting = false;
let cancelRequested = false;
let onFileProgress = null;  // callback de progreso del archivo en curso
let previewUrl = null;      // URL de objeto de la previsualización de entrada
const lastLogs = [];        // últimas líneas de log de FFmpeg (diagnóstico)
let convertedResults = [];
let previewAudio = null; // currently playing Audio element
const fileDurations = new WeakMap(); // File -> segundos (cuando se conocen)

const QUALITY_MAP = {
  mp3:  [96, 128, 192, 256, 320],
  aac:  [96, 128, 192, 256, 320],
  m4a:  [96, 128, 192, 256, 320],
  ogg:  [96, 128, 192, 256, 320],
  opus: [64, 96, 128, 160, 192],
  wma:  [96, 128, 192, 256, 320],
  amr:  [12.2, 12.2, 12.2, 12.2, 12.2],
  ac3:  [96, 128, 192, 256, 320],
  mp2:  [128, 160, 192, 256, 320],
  wav:  [null, null, null, null, null],
  flac: [null, null, null, null, null],
  aiff: [null, null, null, null, null],
  caf:  [null, null, null, null, null]
};

const FORMATS = [
  { id: 'mp3',  label: 'MP3' },
  { id: 'wav',  label: 'WAV' },
  { id: 'flac', label: 'FLAC' },
  { id: 'm4a',  label: 'M4A' },
  { id: 'ogg',  label: 'OGG' },
  { id: 'aac',  label: 'AAC' },
  { id: 'opus', label: 'Opus' },
  { id: 'wma',  label: 'WMA' },
  { id: 'aiff', label: 'AIFF' },
  { id: 'caf',  label: 'CAF' },
  { id: 'amr',  label: 'AMR' },
  { id: 'mp2',  label: 'MP2' },
  { id: 'ac3',  label: 'AC3' }
];

// ---------- DOM ----------
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileListContainer = document.getElementById('file-list-container');
const fileList = document.getElementById('file-list');
const clearAllBtn = document.getElementById('clear-all');
const controls = document.getElementById('controls');
const formatButtons = document.getElementById('format-buttons');
const qualitySlider = document.getElementById('quality-slider');
const qualityLabel = document.getElementById('quality-label');
const qualityFill = document.getElementById('quality-fill');
const sizeEstimate = document.getElementById('size-estimate');
const toggleAdvanced = document.getElementById('toggle-advanced');
const advancedPanel = document.getElementById('advanced-panel');
const advancedChevron = document.getElementById('advanced-chevron');
const toggleMetadata = document.getElementById('toggle-metadata');
const metadataPanel = document.getElementById('metadata-panel');
const metadataChevron = document.getElementById('metadata-chevron');
const convertBtn = document.getElementById('convert-btn');
const progressSection = document.getElementById('progress-section');
const progressBar = document.getElementById('progress-bar');
const progressPercent = document.getElementById('progress-percent');
const progressStatus = document.getElementById('progress-status');
const progressFileList = document.getElementById('progress-file-list');
const resultsSection = document.getElementById('results-section');
const resultsList = document.getElementById('results-list');
const downloadAllBtn = document.getElementById('download-all');
const convertMoreBtn = document.getElementById('convert-more');
const cancelBtn = document.getElementById('cancel-btn');
const notice = document.getElementById('notice');

// ---------- Avisos ----------
function showNotice(msg) {
  if (!notice) return;
  notice.textContent = msg || '';
  notice.classList.toggle('hidden', !msg);
}

// ---------- Init ----------
function init() {
  renderFormatButtons();
  updateQualityUI();
  bindEvents();
}

function renderFormatButtons() {
  formatButtons.innerHTML = FORMATS.map(f => `
    <button type="button" data-format="${f.id}"
      class="format-btn px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-600 text-sm font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 ${f.id === outputFormat ? 'active' : ''}" aria-pressed="${f.id === outputFormat}">
      ${f.label}
    </button>
  `).join('');
}

function updateQualityUI() {
  const rates = QUALITY_MAP[outputFormat] || QUALITY_MAP.mp3;
  const rate = rates[qualityIndex];
  const isLossless = rate === null;

  if (isLossless) {
    qualityLabel.textContent = 'Sin pérdida';
    qualitySlider.disabled = true;
    qualitySlider.classList.add('opacity-50');
  } else {
    qualityLabel.textContent = `${rate} kbps`;
    qualitySlider.disabled = false;
    qualitySlider.classList.remove('opacity-50');
  }

  const pct = (qualityIndex / 4) * 100;
  qualityFill.style.width = `${pct}%`;
  const colors = [
    'linear-gradient(90deg, #ef4444, #f97316)',
    'linear-gradient(90deg, #f97316, #f59e0b)',
    'linear-gradient(90deg, #f59e0b, #84cc16)',
    'linear-gradient(90deg, #84cc16, #22c55e)',
    'linear-gradient(90deg, #22c55e, #10b981)'
  ];
  qualityFill.style.background = colors[qualityIndex];
  updateSizeEstimate();
}

function updateSizeEstimate() {
  if (!sizeEstimate) return;
  if (selectedFiles.length === 0) {
    sizeEstimate.textContent = 'Tamaño estimado de salida: —';
    return;
  }

  const rates = QUALITY_MAP[outputFormat] || QUALITY_MAP.mp3;
  const bitrate = rates[qualityIndex]; // kbps or null
  let totalSec = 0;
  let known = 0;

  selectedFiles.forEach(f => {
    const d = fileDurations.get(f);
    if (d != null && isFinite(d)) {
      totalSec += d;
      known++;
    }
  });

  if (known === 0) {
    // fallback: rough estimate from input size for lossy
    if (bitrate == null) {
      sizeEstimate.textContent = 'Tamaño estimado: similar al original (sin pérdida)';
      return;
    }
    const totalBytes = selectedFiles.reduce((s, f) => s + f.size, 0);
    // assume ~128kbps average source → scale
    const est = totalBytes * (bitrate / 160);
    sizeEstimate.textContent = `Tamaño estimado de salida: ~${formatSize(est)} (aprox.)`;
    return;
  }

  if (bitrate == null) {
    // lossless: rough 10x of 128kbps or use input size
    const totalBytes = selectedFiles.reduce((s, f) => s + f.size, 0);
    sizeEstimate.textContent = `Tamaño estimado: ~${formatSize(totalBytes)} (sin pérdida, similar al original)`;
    return;
  }

  // bits = bitrate * 1000 * seconds; bytes = bits / 8
  const bytes = (bitrate * 1000 * totalSec) / 8;
  const note = known < selectedFiles.length ? ' (parcial)' : '';
  sizeEstimate.textContent = `Tamaño estimado de salida: ~${formatSize(bytes)}${note}`;
}

function bindEvents() {
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', () => {
    handleFiles(fileInput.files);
    fileInput.value = ''; // permite volver a elegir el mismo archivo
  });
  // Evita que soltar un archivo fuera de la zona haga que el navegador lo abra y se pierda el trabajo
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  clearAllBtn.addEventListener('click', clearFiles);

  formatButtons.addEventListener('click', e => {
    const btn = e.target.closest('[data-format]');
    if (!btn) return;
    outputFormat = btn.dataset.format;
    document.querySelectorAll('.format-btn').forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-pressed', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-pressed', 'true');
    updateQualityUI();
  });

  qualitySlider.addEventListener('input', () => {
    qualityIndex = parseInt(qualitySlider.value, 10);
    updateQualityUI();
  });

  toggleAdvanced.addEventListener('click', () => {
    advancedPanel.classList.toggle('hidden');
    advancedChevron.classList.toggle('rotate-180');
  });

  toggleMetadata?.addEventListener('click', () => {
    metadataPanel.classList.toggle('hidden');
    metadataChevron.classList.toggle('rotate-180');
  });

  convertBtn.addEventListener('click', startConversion);
  cancelBtn?.addEventListener('click', cancelConversion);
  downloadAllBtn.addEventListener('click', downloadAll);
  convertMoreBtn.addEventListener('click', resetToStart);
}

// ---------- File handling ----------
function handleFiles(fileListObj) {
  const accepted = [];
  const rejected = [];
  for (const f of Array.from(fileListObj)) {
    const typeOk = f.type.startsWith('audio/') || f.type.startsWith('video/') || AUDIO_VIDEO_EXT.test(f.name);
    if (!typeOk) rejected.push(`${f.name}: formato no admitido`);
    else if (f.size === 0) rejected.push(`${f.name}: archivo vacío`);
    else if (f.size > MAX_FILE_BYTES) rejected.push(`${f.name}: supera el máximo de ${formatSize(MAX_FILE_BYTES)}`);
    else if (selectedFiles.some(s => s.name === f.name && s.size === f.size && s.lastModified === f.lastModified)) rejected.push(`${f.name}: ya estaba añadido`);
    else if (selectedFiles.length + accepted.length >= MAX_FILES) rejected.push(`${f.name}: máximo de ${MAX_FILES} archivos`);
    else accepted.push(f);
  }

  showNotice(rejected.length ? 'No se han añadido:\n' + rejected.join('\n') : '');
  if (accepted.length === 0) return;

  selectedFiles = [...selectedFiles, ...accepted];
  accepted.forEach(probeDuration);

  renderFileList();
  controls.classList.remove('hidden');
  controls.classList.add('fade-in');
  updateConvertButton();
  updateSizeEstimate();
  preloadEngine();
}

function probeDuration(file) {
  const url = URL.createObjectURL(file);
  const audio = new Audio();
  const cleanup = () => {
    URL.revokeObjectURL(url);
    audio.removeAttribute('src');
  };
  audio.preload = 'metadata';
  audio.addEventListener('loadedmetadata', () => {
    if (isFinite(audio.duration)) {
      fileDurations.set(file, audio.duration);
      updateSizeEstimate();
      const i = selectedFiles.indexOf(file); // el índice puede haber cambiado: se busca ahora
      const el = i >= 0 ? document.querySelector(`[data-duration-index="${i}"]`) : null;
      if (el) el.textContent = `${formatDuration(audio.duration)} · ${formatSize(file.size)}`;
    }
    cleanup();
  }, { once: true });
  audio.addEventListener('error', cleanup, { once: true });
  audio.src = url;
}

function stopPreview() {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.src = '';
    previewAudio = null;
  }
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  document.querySelectorAll('.preview-btn').forEach(b => {
    b.dataset.playing = '0';
    b.innerHTML = playIcon();
  });
}

function playIcon() {
  return `<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
}
function pauseIcon() {
  return `<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>`;
}

function renderFileList() {
  if (selectedFiles.length === 0) {
    fileListContainer.classList.add('hidden');
    return;
  }
  fileListContainer.classList.remove('hidden');
  fileList.innerHTML = selectedFiles.map((f, i) => {
    const dur = fileDurations.get(f);
    const meta = dur != null ? `${formatDuration(dur)} · ${formatSize(f.size)}` : formatSize(f.size);
    return `
    <li class="file-item flex items-center justify-between gap-3 px-4 py-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl">
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <button type="button" class="preview-btn flex-shrink-0 w-9 h-9 rounded-lg bg-primary-50 dark:bg-primary-900/40 text-primary-600 dark:text-primary-400 flex items-center justify-center hover:bg-primary-100 dark:hover:bg-primary-900/60 transition-colors" data-index="${i}" data-playing="0" title="Previsualizar" aria-label="Previsualizar">
          ${playIcon()}
        </button>
        <div class="min-w-0">
          <p class="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">${escapeHtml(f.name)}</p>
          <p class="text-xs text-slate-500 dark:text-slate-400" data-duration-index="${i}">${meta}</p>
        </div>
      </div>
      <button type="button" data-index="${i}" aria-label="Quitar archivo" class="remove-file p-1.5 text-slate-400 hover:text-red-500 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </li>`;
  }).join('');

  fileList.querySelectorAll('.remove-file').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index, 10);
      stopPreview();
      selectedFiles.splice(idx, 1);
      renderFileList();
      updateConvertButton();
      updateSizeEstimate();
      if (selectedFiles.length === 0) controls.classList.add('hidden');
    });
  });

  fileList.querySelectorAll('.preview-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index, 10);
      const isPlaying = btn.dataset.playing === '1';

      if (isPlaying) {
        stopPreview();
        return;
      }

      stopPreview();
      const file = selectedFiles[idx];
      const url = URL.createObjectURL(file);
      previewUrl = url;
      previewAudio = new Audio(url);
      previewAudio.play().catch(() => {});
      btn.dataset.playing = '1';
      btn.innerHTML = pauseIcon();

      previewAudio.addEventListener('ended', () => {
        btn.dataset.playing = '0';
        btn.innerHTML = playIcon();
        URL.revokeObjectURL(url);
        previewAudio = null;
      });
      previewAudio.addEventListener('error', () => {
        btn.dataset.playing = '0';
        btn.innerHTML = playIcon();
        URL.revokeObjectURL(url);
        previewAudio = null;
      });
    });
  });
}

function clearFiles() {
  stopPreview();
  selectedFiles = [];
  renderFileList();
  controls.classList.add('hidden');
  updateConvertButton();
  updateSizeEstimate();
}

function updateConvertButton() {
  convertBtn.disabled = selectedFiles.length === 0;
}

function getMetadata() {
  // Sin caracteres de control y con longitud limitada (se pasan como argumentos, nunca por shell)
  const val = (id, max = 200) =>
    (document.getElementById(id)?.value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  return {
    title: val('meta-title'),
    artist: val('meta-artist'),
    album: val('meta-album'),
    year: val('meta-year', 4).replace(/\D/g, ''),
    genre: val('meta-genre', 60),
    comment: val('meta-comment', 500)
  };
}

// ---------- FFmpeg ----------
// Los scripts de FFmpeg se sirven desde este mismo origen (/vendor). Solo el .wasm
// (32 MB: no cabe en Cloudflare Pages, límite de 25 MiB por archivo) se descarga del CDN
// y se verifica con SHA-384 ANTES de ejecutarse. Si cambias de versión, recalcula el hash:
//   curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A
const CORE_JS_URL = new URL('/vendor/ffmpeg-core-0.12.6/ffmpeg-core.js', location.href).href;
const CORE_WASM = {
  url: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm',
  sha384: 'SnAthyn82idS4YdVo46XOl86g1sUylqtN6BEYmPDFqzVO3Z3O/Xj1tVlyFqgyW4K',
  size: 32129114 // bytes descomprimidos (para la barra de progreso)
};

function setOverall(index, total, fraction) {
  const pct = Math.round(((index + Math.max(0, Math.min(1, fraction))) / total) * 100);
  progressBar.style.width = `${pct}%`;
  progressPercent.textContent = `${pct}%`;
  progressBar.parentElement?.setAttribute('aria-valuenow', String(pct));
}

function setEngineProgress(fraction) {
  const pct = Math.round(fraction * 100);
  progressStatus.textContent = `Descargando motor de conversión… ${pct}%`;
  progressBar.style.width = `${Math.max(2, pct)}%`;
  progressPercent.textContent = `${pct}%`;
}

async function fetchVerifiedWasm() {
  const res = await fetch(CORE_WASM.url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`No se pudo descargar el motor de conversión (HTTP ${res.status}).`);

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    setEngineProgress(Math.min(received / CORE_WASM.size, 1));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-384', bytes));
  if (btoa(String.fromCharCode(...digest)) !== CORE_WASM.sha384) {
    throw new Error('El motor descargado no supera la verificación de integridad. Se ha cancelado por seguridad.');
  }
  return URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
}

function loadFFmpeg() {
  if (ffmpegLoaded) return Promise.resolve();
  if (!ffmpegLoading) {
    ffmpegLoading = (async () => {
      const { FFmpeg } = await import('/vendor/ffmpeg-0.12.10/index.js');
      const instance = new FFmpeg();
      instance.on('log', ({ message }) => {
        lastLogs.push(message);
        if (lastLogs.length > 15) lastLogs.shift();
      });
      instance.on('progress', ({ progress }) => onFileProgress?.(progress));

      const wasmURL = await fetchVerifiedWasm();
      try {
        await instance.load({ coreURL: CORE_JS_URL, wasmURL });
      } finally {
        URL.revokeObjectURL(wasmURL);
      }
      ffmpeg = instance;
      ffmpegLoaded = true;
    })().catch(err => {
      ffmpegLoading = null; // permite reintentar
      throw err;
    });
  }
  return ffmpegLoading;
}

// Precarga el motor en segundo plano en cuanto hay archivos (salvo ahorro de datos)
function preloadEngine() {
  if (ffmpegLoaded || ffmpegLoading || navigator.connection?.saveData) return;
  loadFFmpeg().catch(() => {}); // si falla, se mostrará el error al convertir
}

function cancelConversion() {
  if (!converting) return;
  cancelRequested = true;
  try { ffmpeg?.terminate(); } catch (_) {}
  ffmpeg = null;
  ffmpegLoaded = false;
  ffmpegLoading = null;
}

function buildFFmpegArgs(inputName, outputName) {
  const args = ['-i', inputName];
  const meta = getMetadata();
  const filters = [];

  if (meta.title) args.push('-metadata', `title=${meta.title}`);
  if (meta.artist) args.push('-metadata', `artist=${meta.artist}`);
  if (meta.album) args.push('-metadata', `album=${meta.album}`);
  if (meta.year) args.push('-metadata', `date=${meta.year}`);
  if (meta.genre) args.push('-metadata', `genre=${meta.genre}`);
  if (meta.comment) args.push('-metadata', `comment=${meta.comment}`);

  const normalize = !!document.getElementById('normalize-audio')?.checked;
  if (normalize) {
    filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  }

  if (filters.length) {
    args.push('-af', filters.join(','));
  }

  const sr = document.getElementById('sample-rate').value;
  if (sr !== 'auto') {
    args.push('-ar', String(Math.min(Number(sr), MAX_SAMPLE_RATE[outputFormat] || 96000)));
  } else if (normalize) {
    // loudnorm remuestrea internamente a 192 kHz: se fija una frecuencia razonable
    args.push('-ar', outputFormat === 'opus' ? '48000' : '44100');
  }

  const ch = document.getElementById('channels').value;
  if (ch !== 'auto') args.push('-ac', ch);

  const rates = QUALITY_MAP[outputFormat] || QUALITY_MAP.mp3;
  const bitrate = rates[qualityIndex];

  switch (outputFormat) {
    case 'mp3':
      args.push('-c:a', 'libmp3lame', '-b:a', `${bitrate}k`);
      break;
    case 'wav':
      args.push('-c:a', 'pcm_s16le');
      break;
    case 'flac':
      args.push('-c:a', 'flac');
      break;
    case 'm4a':
    case 'aac':
      args.push('-c:a', 'aac', '-b:a', `${bitrate}k`);
      break;
    case 'ogg':
      args.push('-c:a', 'libvorbis', '-b:a', `${bitrate}k`);
      break;
    case 'opus':
      args.push('-c:a', 'libopus', '-b:a', `${bitrate}k`);
      break;
    case 'wma':
      args.push('-c:a', 'wmav2', '-b:a', `${bitrate}k`);
      break;
    case 'aiff':
      args.push('-c:a', 'pcm_s16be');
      break;
    case 'caf':
      args.push('-c:a', 'pcm_s16le');
      break;
    case 'amr':
      args.push('-c:a', 'libopencore_amrnb', '-ar', '8000', '-ac', '1', '-b:a', '12.2k');
      break;
    case 'mp2':
      args.push('-c:a', 'mp2', '-b:a', `${bitrate}k`);
      break;
    case 'ac3':
      args.push('-c:a', 'ac3', '-b:a', `${bitrate}k`);
      break;
    default:
      args.push('-c:a', 'libmp3lame', '-b:a', '192k');
  }

  args.push('-vn', '-map_metadata', document.getElementById('strip-metadata')?.checked ? '-1' : '0', outputName);
  return args;
}

function renderProgressFileList(statuses) {
  // statuses: [{name, state: 'pending'|'converting'|'done'|'error'}]
  if (!progressFileList) return;
  progressFileList.innerHTML = statuses.map((s, i) => {
    let badge = '';
    let bar = '';
    if (s.state === 'pending') {
      badge = `<span class="text-xs text-slate-400">Pendiente</span>`;
    } else if (s.state === 'converting') {
      badge = `<span class="text-xs text-primary-600 dark:text-primary-400 font-medium">Convirtiendo…</span>`;
      bar = `<div class="mt-1.5 h-1 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden"><div class="file-progress-bar h-full w-0 bg-primary-500 rounded-full transition-all duration-200" data-file-progress="${i}"></div></div>`;
    } else if (s.state === 'done') {
      badge = `<span class="text-xs text-emerald-600 dark:text-emerald-400 font-medium">Listo</span>`;
    } else {
      badge = `<span class="text-xs text-red-500 font-medium">Error</span>`;
    }
    return `
      <li class="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700">
        <div class="flex items-center justify-between gap-2">
          <p class="text-sm text-slate-700 dark:text-slate-200 truncate">${escapeHtml(s.name)}</p>
          ${badge}
        </div>
        ${bar}
        ${s.error ? `<p class="mt-1 text-xs text-red-500">${escapeHtml(s.error)}</p>` : ''}
      </li>`;
  }).join('');
}

function revokeResults() {
  convertedResults.forEach(r => URL.revokeObjectURL(r.url));
  convertedResults = [];
}

async function startConversion() {
  if (selectedFiles.length === 0 || converting) return;

  converting = true;
  cancelRequested = false;
  stopPreview();
  convertBtn.disabled = true;
  revokeResults();
  showNotice('');
  progressSection.classList.remove('hidden');
  resultsSection.classList.add('hidden');

  const files = [...selectedFiles];
  const total = files.length;
  const statuses = files.map(f => ({ name: f.name, state: 'pending' }));
  renderProgressFileList(statuses);
  progressStatus.textContent = 'Cargando motor de conversión…';

  try {
    await loadFFmpeg();

    for (let i = 0; i < total && !cancelRequested; i++) {
      const file = files[i];
      statuses[i].state = 'converting';
      renderProgressFileList(statuses);
      progressStatus.textContent = `Convirtiendo ${i + 1} de ${total}: ${file.name}`;
      setOverall(i, total, 0);

      const bar = progressFileList?.querySelector(`[data-file-progress="${i}"]`);
      onFileProgress = p => {
        if (p >= 0 && p <= 1) {
          if (bar) bar.style.width = `${Math.round(p * 100)}%`;
          setOverall(i, total, p);
        }
      };

      const inputName = `input_${i}${safeExtension(file.name)}`;
      const outputName = `output_${i}.${outputFormat}`;
      lastLogs.length = 0;

      try {
        await ffmpeg.writeFile(inputName, await readFileBytes(file));
        const code = await ffmpeg.exec(buildFFmpegArgs(inputName, outputName));
        if (code !== 0) throw new Error('No se pudo convertir (¿archivo dañado o sin pista de audio?).');

        const data = await ffmpeg.readFile(outputName);
        const blob = new Blob([data], { type: getMime(outputFormat) });
        const used = new Set(convertedResults.map(r => r.name.toLowerCase()));
        convertedResults.push({
          name: uniqueName(sanitizeBase(file.name), outputFormat, used),
          blob,
          url: URL.createObjectURL(blob)
        });
        statuses[i].state = 'done';
      } catch (fileErr) {
        if (cancelRequested) break;
        console.error(fileErr, '\n' + lastLogs.join('\n'));
        statuses[i].state = 'error';
        statuses[i].error = fileErr?.message || 'Error desconocido.';
      }

      onFileProgress = null;
      renderProgressFileList(statuses);
      try {
        await ffmpeg.deleteFile(inputName);
        await ffmpeg.deleteFile(outputName);
      } catch (_) {}
    }

    if (cancelRequested) {
      progressSection.classList.add('hidden');
      revokeResults();
      showNotice('Conversión cancelada.');
    } else {
      setOverall(total, total, 0);
      progressStatus.textContent = convertedResults.length ? '¡Listo!' : 'No se pudo convertir ningún archivo.';
      setTimeout(() => {
        progressSection.classList.add('hidden');
        if (convertedResults.length) showResults();
      }, 600);
    }
  } catch (err) {
    console.error(err);
    progressSection.classList.add('hidden');
    if (!cancelRequested) showNotice('No se pudo iniciar la conversión: ' + (err?.message || err));
    else showNotice('Conversión cancelada.');
  } finally {
    onFileProgress = null;
    converting = false;
    updateConvertButton();
  }
}

function showResults() {
  resultsSection.classList.remove('hidden');
  resultsSection.classList.add('fade-in');
  resultsList.innerHTML = convertedResults.map((r, i) => `
    <li class="flex items-center justify-between gap-3 px-4 py-3 bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-700 rounded-xl">
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <button type="button" class="result-preview-btn flex-shrink-0 w-9 h-9 rounded-lg bg-primary-50 dark:bg-primary-900/40 text-primary-600 dark:text-primary-400 flex items-center justify-center hover:bg-primary-100 dark:hover:bg-primary-900/60 transition-colors" data-index="${i}" data-playing="0" title="Previsualizar" aria-label="Previsualizar">
          ${playIcon()}
        </button>
        <div class="min-w-0">
          <p class="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">${escapeHtml(r.name)}</p>
          <p class="text-xs text-slate-500 dark:text-slate-400">${formatSize(r.blob.size)}</p>
        </div>
      </div>
      <a href="${r.url}" download="${escapeHtml(r.name)}"
         class="flex-shrink-0 px-3 py-1.5 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 transition-colors">
        Descargar
      </a>
    </li>
  `).join('');

  resultsList.querySelectorAll('.result-preview-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index, 10);
      const isPlaying = btn.dataset.playing === '1';
      if (isPlaying) {
        stopPreview();
        return;
      }
      stopPreview();
      // reset all result buttons
      resultsList.querySelectorAll('.result-preview-btn').forEach(b => {
        b.dataset.playing = '0';
        b.innerHTML = playIcon();
      });
      const r = convertedResults[idx];
      previewAudio = new Audio(r.url);
      previewAudio.play().catch(() => {});
      btn.dataset.playing = '1';
      btn.innerHTML = pauseIcon();
      previewAudio.addEventListener('ended', () => {
        btn.dataset.playing = '0';
        btn.innerHTML = playIcon();
        previewAudio = null;
      });
    });
  });
}

async function downloadAll() {
  if (convertedResults.length === 0) return;

  if (convertedResults.length === 1) {
    const r = convertedResults[0];
    const a = document.createElement('a');
    a.href = r.url;
    a.download = r.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }

  if (typeof JSZip === 'undefined') {
    convertedResults.forEach(r => {
      const a = document.createElement('a');
      a.href = r.url;
      a.download = r.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
    return;
  }

  const btn = downloadAllBtn;
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `
    <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
    </svg>
    Creando ZIP...
  `;

  try {
    const zip = new JSZip();
    for (const r of convertedResults) {
      // El audio ya comprimido no se beneficia de DEFLATE; el PCM sí
      zip.file(r.name, r.blob, { compression: /\.(wav|aiff|caf)$/i.test(r.name) ? 'DEFLATE' : 'STORE' });
    }
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const zipUrl = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = zipUrl;
    a.download = `audio-convertido-${new Date().toISOString().slice(0,10)}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(zipUrl), 2000);
  } catch (err) {
    console.error(err);
    showNotice('No se pudo crear el ZIP. Se descargarán los archivos uno a uno.');
    convertedResults.forEach(r => {
      const a = document.createElement('a');
      a.href = r.url;
      a.download = r.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

function resetToStart() {
  stopPreview();
  revokeResults();
  selectedFiles = [];
  showNotice('');
  renderFileList();
  controls.classList.add('hidden');
  resultsSection.classList.add('hidden');
  progressSection.classList.add('hidden');
  fileInput.value = '';
  ['meta-title','meta-artist','meta-album','meta-year','meta-genre','meta-comment'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  ['normalize-audio', 'strip-metadata'].forEach(id => {
    const cb = document.getElementById(id);
    if (cb) cb.checked = false;
  });
  updateConvertButton();
  updateSizeEstimate();
}

// ---------- Helpers ----------
function formatSize(bytes) {
  if (bytes < 1024) return Math.round(bytes) + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDuration(sec) {
  if (!isFinite(sec)) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Solo extensiones alfanuméricas cortas: el nombre se usa como ruta en el sistema de archivos virtual
function safeExtension(name) {
  const m = name.match(/\.([A-Za-z0-9]{1,5})$/);
  return m ? '.' + m[1].toLowerCase() : '.bin';
}

// Nombre base seguro para descargas y ZIP (sin separadores de ruta ni caracteres de control)
function sanitizeBase(name) {
  const base = name.replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return base || 'audio';
}

// Evita que dos entradas con el mismo nombre base se pisen (p. ej. a.wav y a.mp3 -> a.flac)
function uniqueName(base, ext, used) {
  let name = `${base}.${ext}`;
  let n = 1;
  while (used.has(name.toLowerCase())) name = `${base} (${++n}).${ext}`;
  return name;
}

function getMime(fmt) {
  const map = {
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac',
    m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
    opus: 'audio/opus', aiff: 'audio/aiff', amr: 'audio/amr',
    mp2: 'audio/mpeg', wma: 'audio/x-ms-wma', caf: 'audio/x-caf',
    ac3: 'audio/ac3'
  };
  return map[fmt] || 'application/octet-stream';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

init();
