/* Convertidor de Audio — Client-side with FFmpeg.wasm */

function getFFmpegClass() {
  if (typeof FFmpegWASM !== 'undefined' && FFmpegWASM.FFmpeg) return FFmpegWASM.FFmpeg;
  if (window.FFmpeg && window.FFmpeg.FFmpeg) return window.FFmpeg.FFmpeg;
  if (typeof FFmpeg !== 'undefined') return FFmpeg;
  throw new Error('FFmpeg library not loaded');
}

async function fetchFileSafe(file) {
  if (typeof FFmpegUtil !== 'undefined' && FFmpegUtil.fetchFile) {
    return FFmpegUtil.fetchFile(file);
  }
  return new Uint8Array(await file.arrayBuffer());
}

async function toBlobURLSafe(url, mime) {
  if (typeof FFmpegUtil !== 'undefined' && FFmpegUtil.toBlobURL) {
    return FFmpegUtil.toBlobURL(url, mime);
  }
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  return URL.createObjectURL(new Blob([buf], { type: mime }));
}

// ---------- State ----------
let selectedFiles = [];
let outputFormat = 'mp3';
let qualityIndex = 2;
let ffmpeg = null;
let ffmpegLoaded = false;
let convertedResults = [];
let previewAudio = null; // currently playing Audio element
let fileDurations = {}; // index -> seconds (when known)

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
const themeToggle = document.getElementById('theme-toggle');

// ---------- Theme ----------
function initTheme() {
  themeToggle?.addEventListener('click', () => {
    const html = document.documentElement;
    const isDark = html.classList.toggle('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  });
}

// ---------- Init ----------
function init() {
  renderFormatButtons();
  updateQualityUI();
  bindEvents();
  initTheme();
}

function renderFormatButtons() {
  formatButtons.innerHTML = FORMATS.map(f => `
    <button type="button" data-format="${f.id}"
      class="format-btn px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-600 text-sm font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 ${f.id === outputFormat ? 'active' : ''}">
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

  selectedFiles.forEach((_, i) => {
    if (fileDurations[i] != null && isFinite(fileDurations[i])) {
      totalSec += fileDurations[i];
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
  fileInput.addEventListener('change', () => handleFiles(fileInput.files));

  clearAllBtn.addEventListener('click', clearFiles);

  formatButtons.addEventListener('click', e => {
    const btn = e.target.closest('[data-format]');
    if (!btn) return;
    outputFormat = btn.dataset.format;
    document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
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
  downloadAllBtn.addEventListener('click', downloadAll);
  convertMoreBtn.addEventListener('click', resetToStart);
}

// ---------- File handling ----------
function handleFiles(fileListObj) {
  const newFiles = Array.from(fileListObj).filter(f =>
    f.type.startsWith('audio/') || f.type.startsWith('video/') ||
    /\.(mp3|wav|m4a|flac|ogg|aac|aiff|amr|mp2|wma|opus|m4r|caf|ac3|mp4|mov|webm|mkv|avi)$/i.test(f.name)
  );

  if (newFiles.length === 0) {
    alert('Por favor selecciona archivos de audio o vídeo válidos.');
    return;
  }

  const startIdx = selectedFiles.length;
  selectedFiles = [...selectedFiles, ...newFiles];

  // probe durations for size estimate + better UX
  newFiles.forEach((f, j) => {
    const idx = startIdx + j;
    probeDuration(f, idx);
  });

  renderFileList();
  controls.classList.remove('hidden');
  controls.classList.add('fade-in');
  updateConvertButton();
  updateSizeEstimate();
}

function probeDuration(file, index) {
  const url = URL.createObjectURL(file);
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = url;
  audio.addEventListener('loadedmetadata', () => {
    if (isFinite(audio.duration)) {
      fileDurations[index] = audio.duration;
      updateSizeEstimate();
      // update duration text in list if present
      const el = document.querySelector(`[data-duration-index="${index}"]`);
      if (el) el.textContent = formatDuration(audio.duration) + ' · ' + formatSize(file.size);
    }
    URL.revokeObjectURL(url);
  });
  audio.addEventListener('error', () => URL.revokeObjectURL(url));
}

function stopPreview() {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.src = '';
    previewAudio = null;
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
    const dur = fileDurations[i];
    const meta = dur != null ? `${formatDuration(dur)} · ${formatSize(f.size)}` : formatSize(f.size);
    return `
    <li class="file-item flex items-center justify-between gap-3 px-4 py-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl">
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <button type="button" class="preview-btn flex-shrink-0 w-9 h-9 rounded-lg bg-primary-50 dark:bg-primary-900/40 text-primary-600 dark:text-primary-400 flex items-center justify-center hover:bg-primary-100 dark:hover:bg-primary-900/60 transition-colors" data-index="${i}" data-playing="0" title="Previsualizar">
          ${playIcon()}
        </button>
        <div class="min-w-0">
          <p class="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">${escapeHtml(f.name)}</p>
          <p class="text-xs text-slate-500 dark:text-slate-400" data-duration-index="${i}">${meta}</p>
        </div>
      </div>
      <button type="button" data-index="${i}" class="remove-file p-1.5 text-slate-400 hover:text-red-500 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors">
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
      // rebuild durations map
      const newDur = {};
      selectedFiles.forEach((_, i) => {
        // durations may shift; re-probe is expensive — clear and re-probe lightly
      });
      fileDurations = {};
      selectedFiles.forEach((f, i) => probeDuration(f, i));
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
  fileDurations = {};
  renderFileList();
  controls.classList.add('hidden');
  updateConvertButton();
  updateSizeEstimate();
}

function updateConvertButton() {
  convertBtn.disabled = selectedFiles.length === 0;
}

function getMetadata() {
  return {
    title: document.getElementById('meta-title')?.value?.trim() || '',
    artist: document.getElementById('meta-artist')?.value?.trim() || '',
    album: document.getElementById('meta-album')?.value?.trim() || '',
    year: document.getElementById('meta-year')?.value?.trim() || '',
    genre: document.getElementById('meta-genre')?.value?.trim() || '',
    comment: document.getElementById('meta-comment')?.value?.trim() || ''
  };
}

// ---------- FFmpeg ----------
async function loadFFmpeg() {
  if (ffmpegLoaded) return;

  progressStatus.textContent = 'Cargando motor de conversión (FFmpeg)...';
  progressBar.style.width = '5%';
  progressPercent.textContent = '5%';

  const FFmpegCtor = getFFmpegClass();
  ffmpeg = new FFmpegCtor();

  ffmpeg.on('log', () => {});
  ffmpeg.on('progress', ({ progress }) => {
    if (window._currentFileProgressEl && progress >= 0 && progress <= 1) {
      const pct = Math.round(progress * 100);
      window._currentFileProgressEl.style.width = `${pct}%`;
    }
  });

  // Same-origin assets (fixes Worker CORS on Cloudflare Pages / production)
  const base = new URL('ffmpeg/', window.location.href).href;
  const loadOpts = {
    coreURL: await toBlobURLSafe(base + 'ffmpeg-core.js', 'text/javascript'),
    wasmURL: await toBlobURLSafe(base + 'ffmpeg-core.wasm', 'application/wasm'),
  };
  // Worker also as blob from same origin — avoids cross-origin Worker error
  try {
    loadOpts.classWorkerURL = await toBlobURLSafe(base + 'worker.js', 'text/javascript');
  } catch (e) {
    console.warn('Worker blob failed, continuing without classWorkerURL', e);
  }

  await ffmpeg.load(loadOpts);

  ffmpegLoaded = true;
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

  if (document.getElementById('normalize-audio')?.checked) {
    // loudnorm is heavy; use simple peak normalize for speed/compatibility
    filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  }

  if (filters.length) {
    args.push('-af', filters.join(','));
  }

  const sr = document.getElementById('sample-rate').value;
  if (sr !== 'auto') args.push('-ar', sr);

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

  args.push('-vn', '-map_metadata', '0', outputName);
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
      bar = `<div class="mt-1.5 h-1 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden"><div class="file-progress-bar h-full bg-primary-500 rounded-full transition-all duration-200" style="width:0%" data-file-progress="${i}"></div></div>`;
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
      </li>`;
  }).join('');
}

async function startConversion() {
  if (selectedFiles.length === 0) return;

  stopPreview();
  convertBtn.disabled = true;
  progressSection.classList.remove('hidden');
  resultsSection.classList.add('hidden');
  convertedResults = [];

  const statuses = selectedFiles.map(f => ({ name: f.name, state: 'pending' }));
  renderProgressFileList(statuses);

  try {
    await loadFFmpeg();

    const total = selectedFiles.length;
    for (let i = 0; i < total; i++) {
      const file = selectedFiles[i];
      statuses[i].state = 'converting';
      renderProgressFileList(statuses);

      const pctBase = Math.round((i / total) * 100);
      progressStatus.textContent = `Convirtiendo ${i + 1} de ${total}: ${file.name}`;
      progressBar.style.width = `${pctBase}%`;
      progressPercent.textContent = `${pctBase}%`;

      // attach current file progress bar
      window._currentFileProgressEl = progressFileList?.querySelector(`[data-file-progress="${i}"]`);

      const inputName = `input_${i}${getExtension(file.name) || '.bin'}`;
      const outputName = `output_${i}.${outputFormat}`;

      try {
        await ffmpeg.writeFile(inputName, await fetchFileSafe(file));
        const args = buildFFmpegArgs(inputName, outputName);
        await ffmpeg.exec(args);

        const data = await ffmpeg.readFile(outputName);
        const mime = getMime(outputFormat);
        const blob = new Blob([data.buffer], { type: mime });
        const url = URL.createObjectURL(blob);
        const outName = file.name.replace(/\.[^.]+$/, '') + '.' + outputFormat;

        convertedResults.push({ name: outName, blob, url });
        statuses[i].state = 'done';
      } catch (fileErr) {
        console.error(fileErr);
        statuses[i].state = 'error';
      }

      renderProgressFileList(statuses);
      window._currentFileProgressEl = null;

      try {
        await ffmpeg.deleteFile(inputName);
        await ffmpeg.deleteFile(outputName);
      } catch (_) {}
    }

    progressBar.style.width = '100%';
    progressPercent.textContent = '100%';
    progressStatus.textContent = convertedResults.length ? '¡Listo!' : 'No se pudo convertir ningún archivo.';

    setTimeout(() => {
      progressSection.classList.add('hidden');
      if (convertedResults.length) showResults();
    }, 600);

  } catch (err) {
    console.error(err);
    progressStatus.textContent = 'Error durante la conversión.';
    progressBar.style.width = '0%';
    alert('Ocurrió un error al convertir.\n\n' + (err.message || String(err)));
  } finally {
    convertBtn.disabled = false;
  }
}

function showResults() {
  resultsSection.classList.remove('hidden');
  resultsSection.classList.add('fade-in');
  resultsList.innerHTML = convertedResults.map((r, i) => `
    <li class="flex items-center justify-between gap-3 px-4 py-3 bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-700 rounded-xl">
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <button type="button" class="result-preview-btn flex-shrink-0 w-9 h-9 rounded-lg bg-primary-50 dark:bg-primary-900/40 text-primary-600 dark:text-primary-400 flex items-center justify-center hover:bg-primary-100 dark:hover:bg-primary-900/60 transition-colors" data-index="${i}" data-playing="0" title="Previsualizar">
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
      const response = await fetch(r.url);
      const blob = await response.blob();
      zip.file(r.name, blob);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
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
    alert('No se pudo crear el ZIP. Se descargarán los archivos uno a uno.');
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
  convertedResults.forEach(r => URL.revokeObjectURL(r.url));
  convertedResults = [];
  selectedFiles = [];
  fileDurations = {};
  renderFileList();
  controls.classList.add('hidden');
  resultsSection.classList.add('hidden');
  progressSection.classList.add('hidden');
  fileInput.value = '';
  ['meta-title','meta-artist','meta-album','meta-year','meta-genre','meta-comment'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const norm = document.getElementById('normalize-audio');
  if (norm) norm.checked = false;
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

function getExtension(name) {
  const m = name.match(/\.[^.]+$/);
  return m ? m[0] : '';
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
    .replace(/"/g, '&quot;');
}

init();
