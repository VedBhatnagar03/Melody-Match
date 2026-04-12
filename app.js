/* ───────────────────────────────────────────────
   APP  —  state machine, event wiring, persistence
   Depends on: all other modules
─────────────────────────────────────────────── */

/* ───────────────────────────────────────────────
   STATE MACHINE
─────────────────────────────────────────────── */
const SCREENS = ['idle','notebuilder','recording','mic-review','processing','results','editor'];
function showScreen(name) {
  SCREENS.forEach(s => {
    document.getElementById('screen-' + s).classList.toggle('active', s === name);
  });
  document.getElementById('statusBar').textContent = name.toUpperCase();
}

/* ───────────────────────────────────────────────
   DEMO MODE
─────────────────────────────────────────────── */
function runDemo() {
  detectedPitches = [
    {midi:62,pc:2,freq:293.7},
    {midi:64,pc:4,freq:329.6},
    {midi:65,pc:5,freq:349.2},
    {midi:67,pc:7,freq:392.0},
    {midi:62,pc:2,freq:293.7},
    {midi:69,pc:9,freq:440.0},
    {midi:67,pc:7,freq:392.0},
    {midi:65,pc:5,freq:349.2},
    {midi:60,pc:0,freq:261.6},
    {midi:62,pc:2,freq:293.7},
    {midi:64,pc:4,freq:329.6},
    {midi:62,pc:2,freq:293.7},
  ];
  showScreen('processing');
  setTimeout(() => {
    buildResults();
    showScreen('results');
  }, 1000);
}

/* ───────────────────────────────────────────────
   MAIN EVENT HANDLERS
─────────────────────────────────────────────── */
document.getElementById('startBtn').addEventListener('click', async () => {
  showScreen('recording');
  const ok = await startAudio();
  if (!ok) showScreen('idle');
});

document.getElementById('stopBtn').addEventListener('click', async () => {
  stopAudio();
  showScreen('processing');
  setRecStep('Finalising recording...');

  const ok = await analyseRecording();
  if (!ok) {
    setRecStep('');
    mrAddingTake = false;
    showScreen(mrTakes.length > 0 ? 'mic-review' : 'idle');
    return;
  }

  setRecStep('');

  if (mrAddingTake) {
    // This was an overlay take — merge into existing takes
    mrAddingTake = false;
    const { seq, bpm } = mrPitchesToSequence(detectedPitches);
    const label = `Take ${mrTakes.length + 1}`;
    mrTakes.push({ notes: seq.map(n => ({ ...n })), bpm, label });
    mrActiveTake = mrTakes.length > 1 ? 'merged' : 0;
    mrSequence   = mrTakes.length > 1 ? mrMergeTakes(mrTakes) : mrTakes[0].notes.map(n => ({ ...n }));
    mrRenderTakes();
    mrDrawRoll();
    mrUpdateUI();
    const addBtn = document.getElementById('mrAddTakeBtn');
    if (addBtn) { addBtn.disabled = mrTakes.length >= 3; addBtn.textContent = '+ add take'; }
    showScreen('mic-review');
  } else {
    // First recording — initialise the review screen
    mrInitFromDetected();
    showScreen('mic-review');
  }
});

document.getElementById('reRecordBtn').addEventListener('click', () => {
  stopPlayback();
  stopAudio();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch(e) {}
  }
  mediaRecorder = null;
  recordedChunks = [];
  micStream?.getTracks().forEach(t => t.stop());
  micStream = null;
  detectedPitches = [];
  mrTakes      = [];
  mrSequence   = [];
  mrAddingTake = false;
  showScreen('idle');
});

document.getElementById('demoBtn').addEventListener('click', () => {
  nbSequence = [];
  nbSeqPlaying = false;
  nbPlayhead = -1;
  nbUpdateUI();
  nbDrawRoll();
  showScreen('notebuilder');
});

/* ───────────────────────────────────────────────
   MIC REVIEW EVENT HANDLERS
─────────────────────────────────────────────── */
document.getElementById('mrBackBtn').addEventListener('click', () => {
  stopPlayback();
  mrTakes      = [];
  mrSequence   = [];
  mrAddingTake = false;
  detectedPitches = [];
  showScreen('idle');
});

document.getElementById('mrAddTakeBtn').addEventListener('click', () => {
  mrAddTake();
});

document.getElementById('mrBpmDown').addEventListener('click', () => {
  mrBpm = Math.max(40, mrBpm - 5);
  document.getElementById('mrBpmLabel').textContent = mrBpm;
  mrDrawRoll();
});

document.getElementById('mrBpmUp').addEventListener('click', () => {
  mrBpm = Math.min(200, mrBpm + 5);
  document.getElementById('mrBpmLabel').textContent = mrBpm;
  mrDrawRoll();
});

document.getElementById('mrResetBtn').addEventListener('click', () => {
  if (mrTakes.length > 0) {
    mrActiveTake = mrTakes.length > 1 ? 'merged' : 0;
    mrSequence = mrTakes.length > 1
      ? mrMergeTakes(mrTakes)
      : mrTakes[0].notes.map(n => ({ ...n }));
  } else {
    mrSequence = [];
  }
  mrDrawRoll();
  mrUpdateUI();
});

document.getElementById('mrAutoTuneBtn').addEventListener('click', () => {
  if (typeof mrAutoTuneSequence !== 'undefined') mrAutoTuneSequence();
});

let mrRawAudioElement = null;
document.getElementById('mrPlayRawBtn').addEventListener('click', () => {
  if (typeof rawAudioBlob === 'undefined' || !rawAudioBlob) return;
  const btn = document.getElementById('mrPlayRawBtn');
  
  if (mrRawAudioElement) {
    mrRawAudioElement.pause();
    mrRawAudioElement = null;
    btn.textContent = '🎤 play raw mic';
    return;
  }
  
  const url = URL.createObjectURL(rawAudioBlob);
  mrRawAudioElement = new Audio(url);
  mrRawAudioElement.play();
  btn.textContent = '❚❚ stop raw';
  
  mrRawAudioElement.onended = () => {
    mrRawAudioElement = null;
    btn.textContent = '🎤 play raw mic';
  };
});

document.getElementById('mrPlayBtn').addEventListener('click', async () => {
  if (mrSequence.length === 0) return;
  stopPlayback();

  await Tone.start();
  const { sampler: mel } = await loadMelodySampler(melodyInstrument);
  const secPerBeat = 60 / mrBpm;
  const now = Tone.now() + 0.05;
  const gen = ++playGeneration;
  const totalLen = mrTotalBeats() * secPerBeat;

  mrPlayhead = 0;
  mrDrawRoll();

  const sorted = [...mrSequence].sort((a, b) => a.beat - b.beat);
  sorted.forEach(n => {
    const t   = now + n.beat * secPerBeat;
    const dur = n.dur * secPerBeat * 0.88;
    const delay = Math.max(0, (t - Tone.now()) * 1000);
    setTimeout(() => {
      if (playGeneration !== gen) return;
      mel.triggerAttackRelease(Tone.Frequency(n.midi, 'midi').toNote(), dur, Tone.now() + 0.01);
    }, delay);
  });

  const startTime = performance.now();
  function animPlayhead() {
    if (playGeneration !== gen) { mrPlayhead = -1; mrDrawRoll(); return; }
    const elapsed = (performance.now() - startTime) / 1000;
    mrPlayhead = elapsed / secPerBeat;
    mrDrawRoll();
    if (elapsed < totalLen) requestAnimationFrame(animPlayhead);
    else { mrPlayhead = -1; mrDrawRoll(); }
  }
  requestAnimationFrame(animPlayhead);

  setTimeout(() => { if (playGeneration === gen) stopPlayback(); }, (totalLen + 1) * 1000);
});

document.getElementById('mrAnalyseBtn').addEventListener('click', () => {
  if (mrSequence.length < 4) return;
  nbBpm = mrBpm;
  nbBars = mrBars;
  const secPerBeat = 60 / mrBpm;
  detectedPitches = [...mrSequence]
    .sort((a, b) => a.beat - b.beat)
    .map(n => ({
      midi: n.midi,
      pc:   n.pc,
      freq: 440 * Math.pow(2, (n.midi - 69) / 12),
      time: n.beat * secPerBeat * 1000,
      dur:  n.dur ?? 1,
      beat: n.beat,
    }));
  pitchSource = 'builder';
  showScreen('processing');
  setRecStep('Building scale results...');
  setTimeout(() => {
    setRecStep('');
    buildResults();
    showScreen('results');
  }, 700);
});

/* ───────────────────────────────────────────────
   INSTRUMENT + MELODY TOGGLE + REVERB
─────────────────────────────────────────────── */
function setMelodyInstrument(inst) {
  melodyInstrument = inst;
  delete melodySamplerCache[inst];
  document.querySelectorAll('.inst-btn-mel, .nb-octave-row .inst-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.inst === inst);
  });
}

function setChordInstrument(inst) {
  chordInstrument = inst;
  delete samplerCache[inst];
  document.querySelectorAll('.inst-btn-chord').forEach(b => {
    b.classList.toggle('active', b.dataset.inst === inst);
  });
}

document.getElementById('melodyToggle').addEventListener('click', () => {
  melodyEnabled = !melodyEnabled;
  const btn = document.getElementById('melodyToggle');
  btn.classList.toggle('active', melodyEnabled);
  btn.textContent = melodyEnabled ? '♪ melody on' : '♪ melody off';
  stopPlayback();
});

document.getElementById('instrumentBar-melody')?.addEventListener('click', e => {
  const btn = e.target.closest('.inst-btn-mel');
  if (!btn) return;
  setMelodyInstrument(btn.dataset.inst);
  stopPlayback();
});

document.getElementById('instrumentBar-chords')?.addEventListener('click', e => {
  const btn = e.target.closest('.inst-btn-chord');
  if (!btn) return;
  setChordInstrument(btn.dataset.inst);
  stopPlayback();
});

const reverbSlider = document.getElementById('reverbSlider');
if (reverbSlider) {
  reverbSlider.addEventListener('input', e => {
    globalReverbAmount = parseInt(e.target.value) / 100;
  });
}

// Drum toggle buttons
document.getElementById('drumBar')?.addEventListener('click', e => {
  const btn = e.target.closest('.drum-toggle-btn');
  if (!btn) return;
  const type = btn.dataset.drum;
  drumEnabled[type] = !drumEnabled[type];
  btn.classList.toggle('active', drumEnabled[type]);
  stopPlayback();
});

/* ───────────────────────────────────────────────
   SAVED MELODIES  (localStorage)
─────────────────────────────────────────────── */
const STORAGE_KEY = 'melodymatch_saved';

function savedLoad() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch(e) { return []; }
}

function savedWrite(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function savedRender() {
  const list = savedLoad();
  const el = document.getElementById('savedList');
  const section = document.getElementById('savedSection');
  section.style.display = list.length === 0 ? 'none' : '';

  if (list.length === 0) { el.innerHTML = ''; return; }

  el.innerHTML = list.map((m, i) => `
    <div class="saved-item" data-idx="${i}">
      <div class="saved-item-info">
        <div class="saved-item-name">${m.name}</div>
        <div class="saved-item-meta">${m.noteCount} notes · ${m.bpm} bpm · ${m.bars} bars · ${m.source} · ${m.date}</div>
      </div>
      <div class="saved-item-btns">
        <button class="saved-load-btn" data-idx="${i}">load</button>
        <button class="saved-delete-btn" data-idx="${i}">✕</button>
      </div>
    </div>
  `).join('');

  el.querySelectorAll('.saved-load-btn').forEach(btn => {
    btn.addEventListener('click', () => savedLoadMelody(parseInt(btn.dataset.idx)));
  });
  el.querySelectorAll('.saved-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => savedDelete(parseInt(btn.dataset.idx)));
  });
}

function savedDelete(idx) {
  const list = savedLoad();
  list.splice(idx, 1);
  savedWrite(list);
  savedRender();
}

function savedLoadMelody(idx) {
  const list = savedLoad();
  const m = list[idx];
  if (!m) return;

  stopPlayback();

  if (m.source === 'builder' && m.sequence) {
    nbSequence = m.sequence.map(n => ({ ...n }));
    nbBpm  = m.bpm  || 100;
    nbBars = m.bars || 4;
    document.getElementById('nbBpmLabel').textContent  = nbBpm;
    document.getElementById('nbBarsLabel').textContent = nbBars;
    nbUpdateUI();
    nbDrawRoll();
    showScreen('notebuilder');
  } else if (m.pitches) {
    detectedPitches = m.pitches.map(p => ({ ...p }));
    pitchSource = m.source || 'mic';
    showScreen('processing');
    setTimeout(() => { buildResults(); showScreen('results'); }, 600);
  }
}

function savedPromptName(defaultName) {
  const name = window.prompt('Name this melody:', defaultName);
  return name && name.trim() ? name.trim() : null;
}

function savedSaveFromResults() {
  if (!detectedPitches || detectedPitches.length === 0) return;
  const defaultName = document.getElementById('bestMatchName').textContent || 'My Melody';
  const name = savedPromptName(defaultName);
  if (!name) return;

  const list = savedLoad();
  const isBuilder = pitchSource === 'builder';
  list.unshift({
    name,
    date: new Date().toLocaleDateString(),
    noteCount: detectedPitches.length,
    bpm: isBuilder ? nbBpm : (window._lastBpm || 100),
    bars: isBuilder ? nbBars : 4,
    source: pitchSource || 'mic',
    pitches: detectedPitches.map(p => ({ ...p })),
    sequence: isBuilder ? nbSequence.map(n => ({ ...n })) : null,
    chords: window._lastBars ? window._lastBars.map(b => ({...b})) : null,
    scale: window._lastScaleName || null,
  });
  savedWrite(list);
  savedRender();

  const btn = document.getElementById('saveMelodyBtn');
  btn.textContent = '✓ saved!';
  btn.classList.add('saved');
  setTimeout(() => { btn.textContent = '✦ save melody'; btn.classList.remove('saved'); }, 2000);
}

function savedSaveFromBuilder() {
  if (nbSequence.length === 0) return;
  const name = savedPromptName('My Melody');
  if (!name) return;

  const list = savedLoad();
  list.unshift({
    name,
    date: new Date().toLocaleDateString(),
    noteCount: nbSequence.length,
    bpm: nbBpm,
    bars: nbBars,
    source: 'builder',
    pitches: [...nbSequence].sort((a,b) => a.beat - b.beat).map(n => ({
      ...n,
      time: n.beat * (60 / nbBpm) * 1000,
    })),
    sequence: nbSequence.map(n => ({ ...n })),
  });
  savedWrite(list);
  savedRender();

  const btn = document.getElementById('nbSaveMelodyBtn');
  btn.textContent = '✓ saved!';
  btn.classList.add('saved');
  setTimeout(() => { btn.textContent = '✦ save'; btn.classList.remove('saved'); }, 2000);
}

document.getElementById('saveMelodyBtn').addEventListener('click', savedSaveFromResults);
document.getElementById('nbSaveMelodyBtn').addEventListener('click', savedSaveFromBuilder);

// Capture bpm from results for use when saving
const _origBuildResults = buildResults;
buildResults = function() {
  _origBuildResults();
  try {
    const pcs = detectedPitches.map(p => p.pc);
    const best = rankScales(pcs)[0];
    const r = buildBarChords(detectedPitches, best.scale.profile, best.root, pitchSource === 'builder' ? nbBpm : null, best.scale.key);
    if (r) {
      window._lastBpm = r.bpm;
      window._lastBars = r.bars;
      window._lastScaleName = `${pcToName(best.root)} ${best.scale.name}`;
    }
  } catch(e) {}
};

/* ───────────────────────────────────────────────
   INIT
─────────────────────────────────────────────── */
buildKeyboard();
nbInitRoll();
mrInitRoll();
savedRender();
