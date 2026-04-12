/* ───────────────────────────────────────────────
   AUDIO ENGINE  — record-then-analyse approach
   1. MediaRecorder captures audio to a blob
   2. After stop: decodeAudioData → offline YIN
      on every 10ms frame, onset detection via
      RMS envelope, produces clean notes with
      real durations
   Depends on: constants.js
─────────────────────────────────────────────── */

let micStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recTimerInterval = null;
let recStartTime = 0;
let waveformAnimId = null;
let recAnalyser = null;
let recAudioCtx = null;

let detectedPitches = []; // [{midi, pc, freq, time, dur}]
let pitchSource = 'mic';  // 'mic' | 'builder'
let rawAudioBlob = null;
let mrWaveformData = null; // Float32Array of RMS amplitudes, normalised 0-1, for roll overlay

function setRecStep(msg) {
  const el = document.getElementById('procStep');
  if (el) el.textContent = msg;
}

/* ───────────────────────────────────────────────
   PITCH DETECTION  (YIN algorithm)
─────────────────────────────────────────────── */
function detectPitch(buf, sampleRate) {
  const SIZE = buf.length;
  const HALF = SIZE >> 1;

  // RMS silence gate
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  if (Math.sqrt(rms / SIZE) < 0.01) return null;

  const minLag = Math.floor(sampleRate / 1100); // ~1100 Hz ceiling
  const maxLag = Math.min(Math.ceil(sampleRate / 60), HALF); // ~60 Hz floor

  // Step 1: difference function
  const d = new Float32Array(maxLag + 1);
  for (let tau = 1; tau <= maxLag; tau++) {
    let s = 0;
    for (let i = 0; i < HALF; i++) {
      const diff = buf[i] - buf[i + tau];
      s += diff * diff;
    }
    d[tau] = s;
  }

  // Step 2: cumulative mean normalised difference
  const cmnd = new Float32Array(maxLag + 1);
  cmnd[0] = 1;
  let runSum = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    runSum += d[tau];
    cmnd[tau] = runSum === 0 ? 0 : d[tau] * tau / runSum;
  }

  // Step 3: find first dip below threshold
  const THRESHOLD = 0.15;
  let bestTau = -1;
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (cmnd[tau] < THRESHOLD) {
      while (tau + 1 <= maxLag && cmnd[tau + 1] < cmnd[tau]) tau++;
      bestTau = tau;
      break;
    }
  }

  // Fallback: take the global minimum if no dip found
  if (bestTau === -1) {
    let minVal = Infinity;
    for (let tau = minLag; tau <= maxLag; tau++) {
      if (cmnd[tau] < minVal) { minVal = cmnd[tau]; bestTau = tau; }
    }
    if (minVal > 0.35) return null; // too noisy
  }

  // Step 4: parabolic interpolation for sub-sample accuracy
  if (bestTau > 0 && bestTau < maxLag) {
    const s0 = cmnd[bestTau - 1], s1 = cmnd[bestTau], s2 = cmnd[bestTau + 1];
    bestTau += (s2 - s0) / (2 * (2 * s1 - s0 - s2));
  }

  const freq = sampleRate / bestTau;
  return (freq >= 60 && freq <= 1100) ? freq : null;
}

async function startAudio() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 44100,
      }
    });
  } catch(e) {
    alert('Microphone access denied. Please allow mic access and try again.\n\nNote: this app must be served over HTTP or opened from localhost. Opening directly from file:// may block mic access in some browsers.');
    return false;
  }

  // ── MediaRecorder for full-quality capture ──
  recordedChunks = [];
  const mimeType = ['audio/webm;codecs=opus','audio/webm','audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  mediaRecorder = new MediaRecorder(micStream, mimeType ? { mimeType } : {});
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.start(100); // chunk every 100ms

  // ── Live waveform visualiser ──
  recAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  recAnalyser = recAudioCtx.createAnalyser();
  recAnalyser.fftSize = 1024;
  recAnalyser.smoothingTimeConstant = 0.6;
  const src = recAudioCtx.createMediaStreamSource(micStream);
  src.connect(recAnalyser);

  const canvas = document.getElementById('waveformCanvas');
  canvas.width = canvas.offsetWidth * window.devicePixelRatio;
  canvas.height = 90 * window.devicePixelRatio;
  const ctx2d = canvas.getContext('2d');
  ctx2d.scale(window.devicePixelRatio, window.devicePixelRatio);
  const W = canvas.offsetWidth, H = 90;

  // Scrolling waveform history
  const HIST_FRAMES = 120;
  const rmsHistory = new Float32Array(HIST_FRAMES);
  let histIdx = 0;

  const timeBuf = new Float32Array(recAnalyser.fftSize);

  function drawWaveform() {
    waveformAnimId = requestAnimationFrame(drawWaveform);
    recAnalyser.getFloatTimeDomainData(timeBuf);

    // Compute RMS for level meter
    let rms = 0;
    for (let i = 0; i < timeBuf.length; i++) rms += timeBuf[i] * timeBuf[i];
    rms = Math.sqrt(rms / timeBuf.length);

    // Store in history
    rmsHistory[histIdx % HIST_FRAMES] = rms;
    histIdx++;

    // Level meter
    const levelPct = Math.min(100, rms * 400);
    const fill = document.getElementById('recLevelFill');
    if (fill) {
      fill.style.width = levelPct + '%';
      fill.classList.toggle('clipping', levelPct > 90);
    }

    // Draw waveform
    ctx2d.clearRect(0, 0, W, H);

    // Background grid lines
    ctx2d.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx2d.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(frac => {
      ctx2d.beginPath();
      ctx2d.moveTo(0, H * frac);
      ctx2d.lineTo(W, H * frac);
      ctx2d.stroke();
    });

    // Draw scrolling RMS bars
    const barW = W / HIST_FRAMES;
    for (let i = 0; i < HIST_FRAMES; i++) {
      const frameIdx = (histIdx - HIST_FRAMES + i + HIST_FRAMES) % HIST_FRAMES;
      const val = rmsHistory[frameIdx];
      const barH = Math.max(1, val * 3.5 * H);
      const x = i * barW;
      const alpha = 0.3 + (i / HIST_FRAMES) * 0.7;
      const hue = 180 + val * 60; // cyan → teal as louder
      ctx2d.fillStyle = `hsla(${hue}, 100%, 65%, ${alpha})`;
      ctx2d.fillRect(x, (H - barH) / 2, Math.max(1, barW - 1), barH);
    }

    // Centre line
    ctx2d.strokeStyle = 'rgba(0,212,255,0.15)';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, H / 2);
    ctx2d.lineTo(W, H / 2);
    ctx2d.stroke();
  }
  drawWaveform();

  // ── Recording timer ──
  recStartTime = Date.now();
  recTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recStartTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    const el = document.getElementById('recTimer');
    if (el) el.textContent = `${m}:${s.toString().padStart(2,'0')}`;
  }, 500);

  detectedPitches = [];
  pitchSource = 'mic';
  return true;
}

function stopAudio() {
  clearInterval(recTimerInterval);
  cancelAnimationFrame(waveformAnimId);
  recAudioCtx?.close();
  recAudioCtx = recAnalyser = null;
}

// ── Post-recording offline analysis ──
async function analyseRecording() {
  if (!mediaRecorder) return;

  await new Promise(resolve => {
    mediaRecorder.onstop = resolve;
    if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    else resolve();
  });

  micStream?.getTracks().forEach(t => t.stop());
  micStream = null;

  if (recordedChunks.length === 0) {
    alert('No audio was captured. Please try again.');
    return false;
  }

  rawAudioBlob = new Blob(recordedChunks, { type: recordedChunks[0].type || 'audio/webm' });
  const arrayBuf = await rawAudioBlob.arrayBuffer();

  setRecStep('Decoding audio...');
  let audioBuffer;
  try {
    const decodeCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
    audioBuffer = await decodeCtx.decodeAudioData(arrayBuf);
    decodeCtx.close();
  } catch(e) {
    try {
      const decodeCtx2 = new (window.AudioContext || window.webkitAudioContext)();
      audioBuffer = await decodeCtx2.decodeAudioData(arrayBuf.slice(0));
      decodeCtx2.close();
    } catch(e2) {
      alert('Could not decode the recording. Please try a different browser (Chrome or Firefox recommended).');
      return false;
    }
  }

  // Downsample mono waveform to ~800 RMS buckets for roll overlay
  try {
    const mono = audioBuffer.numberOfChannels > 1
      ? (() => {
          const L = audioBuffer.getChannelData(0);
          const R = audioBuffer.getChannelData(1);
          const m = new Float32Array(L.length);
          for (let i = 0; i < L.length; i++) m[i] = (L[i] + R[i]) * 0.5;
          return m;
        })()
      : audioBuffer.getChannelData(0);
    const NUM_BUCKETS = 800;
    const bucketSize = Math.floor(mono.length / NUM_BUCKETS);
    const buckets = new Float32Array(NUM_BUCKETS);
    for (let b = 0; b < NUM_BUCKETS; b++) {
      let sum = 0;
      const start = b * bucketSize;
      for (let s = 0; s < bucketSize; s++) sum += mono[start + s] ** 2;
      buckets[b] = Math.sqrt(sum / bucketSize);
    }
    const peak = Math.max(...buckets, 0.0001);
    mrWaveformData = buckets.map(v => v / peak);
  } catch(e) {
    mrWaveformData = null;
  }

  setRecStep('Running pitch analysis...');
  await new Promise(r => setTimeout(r, 30)); // yield to let UI update
  detectedPitches = await analyseAudioBuffer(audioBuffer);
  pitchSource = 'mic';

  if (detectedPitches.length === 0) {
    alert('No notes detected in the recording. Please try singing/humming more clearly, closer to the microphone.');
    return false;
  }

  setRecStep(`Detected ${detectedPitches.length} notes · building results...`);
  await new Promise(r => setTimeout(r, 80));
  return true;
}

/* ───────────────────────────────────────────────
   OFFLINE PITCH ANALYSIS
─────────────────────────────────────────────── */
async function analyseAudioBuffer(audioBuffer) {
  const sr = audioBuffer.sampleRate;
  // Mix down to mono
  const mono = audioBuffer.numberOfChannels > 1
    ? (() => {
        const L = audioBuffer.getChannelData(0);
        const R = audioBuffer.getChannelData(1);
        const m = new Float32Array(L.length);
        for (let i = 0; i < L.length; i++) m[i] = (L[i] + R[i]) * 0.5;
        return m;
      })()
    : audioBuffer.getChannelData(0);

  const totalSamples = mono.length;
  const frameSize  = 2048;
  const hopSize    = Math.round(sr * 0.010); // 10ms hop
  const silenceRms = 0.012;

  // ── Pass 1: YIN pitch + RMS for every frame ──
  const rawFrames = [];
  const totalFrames = Math.floor((totalSamples - frameSize) / hopSize) + 1;
  const YIELD_EVERY = 200;

  for (let fi = 0; fi < totalFrames; fi++) {
    if (fi > 0 && fi % YIELD_EVERY === 0) {
      const pct = Math.round(fi / totalFrames * 100);
      setRecStep(`Analysing pitch... ${pct}%`);
      await new Promise(r => setTimeout(r, 0));
    }

    const pos   = fi * hopSize;
    const frame = mono.subarray(pos, pos + frameSize);

    let rms = 0;
    for (let i = 0; i < frame.length; i++) rms += frame[i] * frame[i];
    rms = Math.sqrt(rms / frame.length);

    const timeSec = pos / sr;
    if (rms < silenceRms) {
      rawFrames.push({ timeSec, rms, freq: null });
      continue;
    }

    const freq = detectPitch(frame, sr);
    rawFrames.push({ timeSec, rms, freq });
  }

  // ── Pass 1b: Median Filter (Size 5) on Raw Frequencies ──
  // Rejects transient octave-jumps instantly without blurring active note edges.
  const medFrames = [];
  for (let i = 0; i < rawFrames.length; i++) {
    const f = rawFrames[i];
    let freqWindow = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(rawFrames.length - 1, i + 2); j++) {
      if (rawFrames[j].freq !== null) freqWindow.push(rawFrames[j].freq);
    }
    let medFreq = null;
    if (freqWindow.length > 0) {
      freqWindow.sort((a,b) => a - b);
      medFreq = freqWindow[Math.floor(freqWindow.length / 2)];
    }
    medFrames.push({ timeSec: f.timeSec, rms: f.rms, freq: medFreq, rawFreq: f.freq });
  }

  // ── Pass 1c: Hysteresis MIDI Quantization ("Autotune Snap") ──
  // Only shift to a new note if pitch drifts by >50 cents from the explicitly locked note.
  const frames = [];
  let currentLockedMidi = null;
  const HYSTERESIS_THRESHOLD = 0.50; // cents / 100

  for (let i = 0; i < medFrames.length; i++) {
    const f = medFrames[i];
    let midi = null;
    
    if (f.freq !== null) {
      const floatMidi = 12 * Math.log2(f.freq / 440) + 69;
      if (currentLockedMidi === null) {
        currentLockedMidi = Math.round(floatMidi);
      } else {
        if (Math.abs(floatMidi - currentLockedMidi) > HYSTERESIS_THRESHOLD) {
          currentLockedMidi = Math.round(floatMidi);
        }
      }
      midi = (currentLockedMidi >= 36 && currentLockedMidi <= 96) ? currentLockedMidi : null;
    } else {
      currentLockedMidi = null;
    }
    frames.push({ ...f, midi });
  }

  // ── Pass 2: majority-vote smoothing ──
  const SMOOTH_FRAMES = 7; // Raised from 5 to 7 (slower Retune speed)
  const smoothed = frames.map((f, i) => {
    if (f.midi === null) return { ...f, midi: null };
    const window = frames.slice(Math.max(0, i - SMOOTH_FRAMES), i + SMOOTH_FRAMES + 1)
      .map(x => x.midi).filter(m => m !== null);
    if (window.length === 0) return { ...f, midi: null };
    const counts = {};
    let best = f.midi, bestC = 0;
    for (const m of window) {
      counts[m] = (counts[m] || 0) + 1;
      if (counts[m] > bestC) { bestC = counts[m]; best = m; }
    }
    return { ...f, midi: best };
  });

  // ── Pass 3: onset segmentation ──
  const MIN_NOTE_MS  = 100;  // Raised from 80ms, but lower than 130 to catch snappier notes
  const MIN_NOTE_RMS = 0.016; 
  const GLUE_GAP_MS  = 60;

  const raw = [];
  let i = 0;
  while (i < smoothed.length) {
    const f = smoothed[i];
    if (f.midi === null) { i++; continue; }

    let j = i + 1;
    while (j < smoothed.length && smoothed[j].midi === f.midi) j++;

    const startSec = f.timeSec;
    const endSec   = smoothed[j - 1].timeSec + hopSize / sr;
    const durMs    = (endSec - startSec) * 1000;

    let runRms = 0;
    for (let k = i; k < j; k++) runRms += smoothed[k].rms;
    runRms /= (j - i);

    if (durMs >= MIN_NOTE_MS && runRms >= MIN_NOTE_RMS) {
      raw.push({ midi: f.midi, startSec, endSec, durMs, rms: runRms });
    }
    i = j;
  }

  // ── Merge notes separated by very short silences (legato phrasing) ──
  const merged = [];
  for (const note of raw) {
    if (merged.length > 0) {
      const prev = merged[merged.length - 1];
      const gapMs = (note.startSec - prev.endSec) * 1000;
      if (gapMs < GLUE_GAP_MS && prev.midi === note.midi) {
        prev.endSec = note.endSec;
        prev.durMs  = (prev.endSec - prev.startSec) * 1000;
        continue;
      }
    }
    merged.push({ ...note });
  }

  if (merged.length === 0) return [];

  // ── Convert to detectedPitches format ──
  const avgDurSec = merged.reduce((s, n) => s + (n.endSec - n.startSec), 0) / merged.length;
  const estBpm = Math.min(180, Math.max(60, 60 / (avgDurSec * 2)));
  const secPerBeatEst = 60 / estBpm;

  const t0 = merged[0].startSec;
  return merged.map(n => {
    const relSec    = n.startSec - t0;
    const beatPos   = relSec / secPerBeatEst;
    const durBeats  = (n.endSec - n.startSec) / secPerBeatEst;
    const midi      = n.midi;
    return {
      midi,
      pc:   midiToPc(midi),
      freq: 440 * Math.pow(2, (midi - 69) / 12),
      time: n.startSec * 1000,
      dur:  Math.max(0.25, durBeats),
    };
  });
}
