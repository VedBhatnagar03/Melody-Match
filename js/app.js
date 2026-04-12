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
  // time field (ms) required by mrPitchesToSequence() for IOI-based BPM detection
  const demoNotes = [62,64,65,67,62,69,67,65,60,62,64,62];
  const PC = [2,4,5,7,2,9,7,5,0,2,4,2];
  const FREQ = [293.7,329.6,349.2,392.0,293.7,440.0,392.0,349.2,261.6,293.7,329.6,293.7];
  detectedPitches = demoNotes.map((midi, i) => ({
    midi, pc: PC[i], freq: FREQ[i],
    time: i * 500,   // evenly spaced at 500ms → ~120 BPM
    dur: 0.5,
    beat: i * 1,     // one beat apart
  }));
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
  currentSavedIdx = -1;
  showScreen('idle');
});

document.getElementById('demoBtn').addEventListener('click', () => {
  nbStopSequence(); // cancel any active playback timeouts
  nbSequence = [];
  currentSavedIdx = -1;
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
  // Reset clears undo history (we're back to the source of truth)
  mrUndoStack = []; mrRedoStack = [];
  mrDrawRoll();
  mrUpdateUI();
});

document.getElementById('mrMetronomeBtn').addEventListener('click', () => {
  mrMetronomeEnabled = !mrMetronomeEnabled;
  const btn = document.getElementById('mrMetronomeBtn');
  btn.style.borderColor = mrMetronomeEnabled ? '#fbbf24' : '';
  btn.style.color       = mrMetronomeEnabled ? '#fbbf24' : '';
  btn.style.background  = mrMetronomeEnabled ? 'rgba(251,191,36,0.15)' : '';
  btn.textContent       = mrMetronomeEnabled ? '♩ metronome on' : '♩ metronome';
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
  mrRawAudioElement.onerror = () => {
    mrRawAudioElement = null;
    btn.textContent = '🎤 play raw mic';
  };
});

async function mrStartPlaybackFrom(startBeat) {
  if (mrSequence.length === 0) return;
  stopPlayback();

  await Tone.start();
  const { sampler: mel } = await loadMelodySampler(melodyInstrument);
  const secPerBeat = 60 / mrBpm;
  const now = Tone.now() + 0.05;
  const gen = ++playGeneration;
  const totalBeats = mrTotalBeats();
  const totalLen   = totalBeats * secPerBeat;
  const startSec   = startBeat * secPerBeat;

  mrPlayhead = startBeat;
  mrDrawRoll();

  // Schedule melody notes
  const sorted = [...mrSequence].sort((a, b) => a.beat - b.beat);
  sorted.forEach(n => {
    // Skip notes that finish before the seek point
    if (n.beat + (n.dur ?? 0.5) <= startBeat) return;
    const offsetSec = (n.beat - startBeat) * secPerBeat;
    // Skip notes whose start is already in the past (with 30ms grace)
    if (offsetSec < -0.03) return;
    const dur   = n.dur * secPerBeat * 0.88;
    const delay = Math.max(0, offsetSec * 1000);
    setTimeout(() => {
      if (playGeneration !== gen) return;
      mel.triggerAttackRelease(Tone.Frequency(n.midi, 'midi').toNote(), dur, Tone.now() + 0.01);
    }, delay);
  });

  // Schedule metronome clicks
  if (mrMetronomeEnabled) {
    const clickSynth = new Tone.MembraneSynth({
      pitchDecay: 0.008, octaves: 2,
      envelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.05 },
    }).toDestination();
    clickSynth.volume.value = -6;

    const startBeatInt = Math.ceil(startBeat);
    for (let b = startBeatInt; b < totalBeats; b++) {
      const isDownbeat = b % 4 === 0;
      const delay = (b - startBeat) * secPerBeat * 1000;
      setTimeout(() => {
        if (playGeneration !== gen) return;
        clickSynth.triggerAttackRelease(
          isDownbeat ? 'C2' : 'C3',
          '32n',
          Tone.now() + 0.01
        );
      }, delay);
    }

    // Dispose click synth after playback ends
    setTimeout(() => { try { clickSynth.dispose(); } catch(e) {} },
      (totalLen - startSec + 0.5) * 1000);
  }

  const startTime = performance.now();
  function animPlayhead() {
    if (playGeneration !== gen) { mrPlayhead = -1; mrDrawRoll(); return; }
    const elapsed = (performance.now() - startTime) / 1000;
    mrPlayhead = startBeat + elapsed / secPerBeat;
    mrDrawRoll();
    if (elapsed < totalLen - startSec) requestAnimationFrame(animPlayhead);
    else { mrPlayhead = -1; mrDrawRoll(); }
  }
  requestAnimationFrame(animPlayhead);

  setTimeout(() => { if (playGeneration === gen) stopPlayback(); }, (totalLen - startSec + 1) * 1000);
}

// Called when user drags the playhead and releases
function mrSeekPlayback(beat) {
  // Only restart if currently playing
  if (playGeneration > 0 && mrPlayhead >= 0) mrStartPlaybackFrom(beat);
}

// Stored start beat for next NB play (set by scrubbing while paused)
let nbStartBeat = 0;

// Called when user drags the NB playhead and releases
function nbSeekPlayback(beat) {
  nbPlayhead = beat; // park visually first so stop() sees it >= 0
  if (nbSeqPlaying) {
    nbStopSequence(); // cancels play; nbStopSequence will read nbPlayhead and set nbStartBeat
    nbPlaySequence(beat);
  } else {
    nbStartBeat = beat;
    nbDrawRoll();
  }
}

document.getElementById('mrPlayBtn').addEventListener('click', () => mrStartPlaybackFrom(mrPlayhead >= 0 ? mrPlayhead : 0));

document.getElementById('mrCopyBtn').addEventListener('click', () => {
  mrCopySelected();
  const pasteBtn = document.getElementById('mrPasteBtn');
  if (pasteBtn) pasteBtn.disabled = mrClipboard.length === 0;
});

document.getElementById('mrPasteBtn').addEventListener('click', () => {
  mrPasteClipboard();
});

// Keyboard shortcuts for mic-review screen
document.addEventListener('keydown', e => {
  const mrScreen = document.getElementById('screen-mic-review');
  if (!mrScreen || !mrScreen.classList.contains('active')) return;
  if (e.target.tagName === 'INPUT') return;

  if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (e.shiftKey) mrRedo(); else mrUndo();
  } else if ((e.key === 'y' || e.key === 'Y') && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    mrRedo();
  } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    mrSelected = new Set(mrSequence.map((_, i) => i));
    mrDrawRoll();
  } else if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    mrCopySelected();
    const pasteBtn = document.getElementById('mrPasteBtn');
    if (pasteBtn) pasteBtn.disabled = mrClipboard.length === 0;
  } else if (e.key === 'v' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    mrPasteClipboard();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (mrSelected.size > 0) {
      e.preventDefault();
      mrPushUndo();
      const toDelete = [...mrSelected].sort((a, b) => b - a);
      toDelete.forEach(i => mrSequence.splice(i, 1));
      mrSelected.clear();
      mrUpdateUI();
      mrDrawRoll();
    }
  } else if (e.key === 'Escape') {
    mrSelected.clear();
    mrDrawRoll();
  }
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
  // Sync code default to slider's initial HTML value on load
  globalReverbAmount = parseInt(reverbSlider.value) / 100;
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

// Index of the currently loaded saved melody (-1 = unsaved / new)
let currentSavedIdx = -1;

const STORAGE_VERSION = 1;

function savedLoad() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    // Filter out entries from future/incompatible versions, warn on mismatch
    return raw.filter(m => {
      if (m.version === undefined) {
        // Legacy entry (no version field) — migrate by adding version
        m.version = STORAGE_VERSION;
        return true;
      }
      if (m.version > STORAGE_VERSION) {
        console.warn('MelodyMatch: skipping saved entry with unknown version', m.version);
        return false;
      }
      return true;
    });
  } catch(e) { return []; }
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
  currentSavedIdx = idx;

  if (m.source === 'builder' && m.sequence) {
    nbSequence = m.sequence.map(n => ({ ...n }));
    nbBpm  = m.bpm  || 100;
    nbBars = m.bars || 4;
    document.getElementById('nbBpmLabel').textContent  = nbBpm;
    document.getElementById('nbBarsLabel').textContent = nbBars;
    nbUndoStack = []; nbRedoStack = []; // fresh load = fresh history
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

// ── Save modal ──
let _saveModalCallback = null;

function savedShowModal(defaultName, onConfirm) {
  const overlay = document.getElementById('saveModal');
  const input   = document.getElementById('saveModalName');
  input.value   = defaultName;
  overlay.style.display = 'flex';
  setTimeout(() => { input.focus(); input.select(); }, 50);
  _saveModalCallback = onConfirm;
}

document.getElementById('saveModalConfirm').addEventListener('click', () => {
  const name = document.getElementById('saveModalName').value.trim();
  if (!name) return;
  document.getElementById('saveModal').style.display = 'none';
  if (_saveModalCallback) { _saveModalCallback(name); _saveModalCallback = null; }
});

document.getElementById('saveModalCancel').addEventListener('click', () => {
  document.getElementById('saveModal').style.display = 'none';
  _saveModalCallback = null;
});

document.getElementById('saveModalName').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('saveModalConfirm').click();
  if (e.key === 'Escape') document.getElementById('saveModalCancel').click();
});

document.getElementById('saveModal').addEventListener('click', e => {
  if (e.target === document.getElementById('saveModal')) document.getElementById('saveModalCancel').click();
});

function savedSaveFromResults() {
  if (!detectedPitches || detectedPitches.length === 0) return;
  const list = savedLoad();
  const isBuilder = pitchSource === 'builder';
  const isOverwrite = currentSavedIdx >= 0 && currentSavedIdx < list.length;

  const doSave = (name) => {
    const entry = {
      version: STORAGE_VERSION,
      name,
      date: new Date().toLocaleDateString(),
      noteCount: detectedPitches.length,
      bpm: isBuilder ? nbBpm : (_lastResults.bpm || 100),
      bars: isBuilder ? nbBars : 4,
      source: pitchSource || 'mic',
      pitches: detectedPitches.map(p => ({ ...p })),
      sequence: isBuilder ? nbSequence.map(n => ({ ...n })) : null,
      chords: _lastResults.bars ? _lastResults.bars.map(b => ({...b})) : null,
      scale: _lastResults.scaleName || null,
    };
    const freshList = savedLoad();
    if (isOverwrite) {
      freshList[currentSavedIdx] = entry;
    } else {
      freshList.unshift(entry);
      currentSavedIdx = 0;
    }
    savedWrite(freshList);
    savedRender();
    const btn = document.getElementById('saveMelodyBtn');
    btn.textContent = '✓ saved!';
    btn.classList.add('saved');
    setTimeout(() => { btn.textContent = '✦ save melody'; btn.classList.remove('saved'); }, 2000);
  };

  if (isOverwrite) {
    // Silent overwrite — no modal
    doSave(list[currentSavedIdx].name);
  } else {
    const bestMatchEl = document.getElementById('bestMatchName');
    const defaultName = bestMatchEl?.textContent?.trim() || 'My Melody';
    savedShowModal(defaultName, doSave);
  }
}

function savedSaveFromBuilder() {
  if (nbSequence.length === 0) return;
  const list = savedLoad();
  const isOverwrite = currentSavedIdx >= 0 && currentSavedIdx < list.length;

  const doSave = (name) => {
    const entry = {
      version: STORAGE_VERSION,
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
    };
    const freshList = savedLoad();
    if (isOverwrite) {
      freshList[currentSavedIdx] = entry;
    } else {
      freshList.unshift(entry);
      currentSavedIdx = 0;
    }
    savedWrite(freshList);
    savedRender();
    const btn = document.getElementById('nbSaveMelodyBtn');
    btn.textContent = '✓ saved!';
    btn.classList.add('saved');
    setTimeout(() => { btn.textContent = '✦ save'; btn.classList.remove('saved'); }, 2000);
  };

  if (isOverwrite) {
    doSave(list[currentSavedIdx].name);
  } else {
    savedShowModal('My Melody', doSave);
  }
}

document.getElementById('saveMelodyBtn').addEventListener('click', savedSaveFromResults);

document.getElementById('editMelodyBtn').addEventListener('click', () => {
  stopPlayback();
  // Load current melody into notebuilder
  // Use mrSequence if available (mic-review path), else fall back to detectedPitches
  let src, srcBpm, srcBars;
  if (pitchSource === 'builder') {
    src = nbSequence; srcBpm = nbBpm; srcBars = nbBars;
  } else if (mrSequence && mrSequence.length > 0) {
    src = mrSequence; srcBpm = mrBpm; srcBars = mrBars;
  } else if (detectedPitches && detectedPitches.length > 0) {
    // Convert raw pitches to sequence format
    const bpm = _lastResults.bpm || 100;
    const spb = 60 / bpm;
    src = detectedPitches.map(p => ({
      midi: p.midi, pc: p.pc, freq: p.freq,
      beat: p.beat ?? ((p.time || 0) / 1000 / spb),
      dur:  p.dur  ?? 1,
    }));
    srcBpm  = bpm;
    srcBars = (_lastResults.bars && _lastResults.bars.length > 0) ? _lastResults.bars.length : 4;
  }

  if (src && src.length > 0) {
    nbSequence = src.map(n => ({ ...n }));
    nbBpm  = srcBpm  || 100;
    nbBars = srcBars || 4;
    document.getElementById('nbBpmLabel').textContent  = nbBpm;
    document.getElementById('nbBarsLabel').textContent = nbBars;
    nbUpdateUI();
    nbDrawRoll();
  }
  showScreen('notebuilder');
});

// Undo/redo buttons for notebuilder
document.getElementById('nbUndoBtn').addEventListener('click', nbUndo);
document.getElementById('nbRedoBtn').addEventListener('click', nbRedo);

// Undo/redo buttons for mic-review
document.getElementById('mrUndoBtn').addEventListener('click', mrUndo);
document.getElementById('mrRedoBtn').addEventListener('click', mrRedo);

// Copy/paste buttons for notebuilder
document.getElementById('nbCopyBtn').addEventListener('click', () => {
  nbCopySelected();
  const pasteBtn = document.getElementById('nbPasteBtn');
  if (pasteBtn) pasteBtn.disabled = nbClipboard.length === 0;
});

document.getElementById('nbPasteBtn').addEventListener('click', () => {
  nbPasteClipboard();
});

// Keyboard shortcuts for notebuilder screen
document.addEventListener('keydown', e => {
  const nbScreen = document.getElementById('screen-notebuilder');
  if (!nbScreen || !nbScreen.classList.contains('active')) return;
  if (e.target.tagName === 'INPUT') return;

  if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (e.shiftKey) nbRedo(); else nbUndo();
  } else if ((e.key === 'y' || e.key === 'Y') && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    nbRedo();
  } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    nbSelected = new Set(nbSequence.map((_, i) => i));
    nbDrawRoll();
  } else if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    nbCopySelected();
    const pasteBtn = document.getElementById('nbPasteBtn');
    if (pasteBtn) pasteBtn.disabled = nbClipboard.length === 0;
  } else if (e.key === 'v' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    nbPasteClipboard();
    const pasteBtn = document.getElementById('nbPasteBtn');
    if (pasteBtn) pasteBtn.disabled = nbClipboard.length === 0;
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (nbSelected.size > 0) {
      e.preventDefault();
      nbPushUndo();
      const toDelete = [...nbSelected].sort((a, b) => b - a);
      toDelete.forEach(i => nbSequence.splice(i, 1));
      nbSelected.clear();
      nbUpdateUI();
      nbDrawRoll();
    }
  } else if (e.key === 'Escape') {
    nbSelected.clear();
    nbDrawRoll();
  }
});
document.getElementById('nbSaveMelodyBtn').addEventListener('click', savedSaveFromBuilder);

document.getElementById('nbMetronomeBtn').addEventListener('click', () => {
  nbMetronomeEnabled = !nbMetronomeEnabled;
  const btn = document.getElementById('nbMetronomeBtn');
  btn.classList.toggle('active', nbMetronomeEnabled);
  btn.title = nbMetronomeEnabled ? 'Metronome on (click to turn off)' : 'Toggle metronome';
});

// Module-level cache for last analysis results (avoids window.* global pollution)
const _lastResults = {};  // { bpm, bars, scaleName }

// Capture bpm from results for use when saving
const _origBuildResults = buildResults;
buildResults = function() {
  _origBuildResults();
  try {
    const pcs = detectedPitches.map(p => p.pc);
    const best = rankScales(pcs)[0];
    const r = buildBarChords(detectedPitches, best.scale.profile, best.root, pitchSource === 'builder' ? nbBpm : null, best.scale.key);
    if (r) {
      _lastResults.bpm       = r.bpm;
      _lastResults.bars      = r.bars;
      _lastResults.scaleName = `${pcToName(best.root)} ${best.scale.name}`;
    }
  } catch(e) {}
};

/* ───────────────────────────────────────────────
   ROLL RESIZE HANDLES
   Vertical drag   → row height  (pitch zoom)
   Horizontal drag → beat width  (time zoom)
   Both axes together on corner drag
─────────────────────────────────────────────── */
function makeRollResizable(handleId, {
  getRowH, setRowH, getBeatW, setBeatW, redraw,
  minRowH = 14, maxRowH = 72,
  minBeatW = 24, maxBeatW = 160,
}) {
  const handle = document.getElementById(handleId);
  if (!handle) return;

  let dragging = false;
  let startX = 0, startY = 0;
  let origRowH = 0, origBeatW = 0;

  handle.addEventListener('mousedown', e => {
    dragging  = true;
    startX    = e.clientX;
    startY    = e.clientY;
    origRowH  = getRowH();
    origBeatW = getBeatW();
    document.body.style.cursor    = 'nwse-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    const dx = e.clientX - startX;
    // 3px of drag = 1px of row height change; 2px drag = 1px of beat width change
    const newRowH  = Math.max(minRowH,  Math.min(maxRowH,  origRowH  + Math.round(dy / 3)));
    const newBeatW = Math.max(minBeatW, Math.min(maxBeatW, origBeatW + Math.round(dx / 2)));
    setRowH(newRowH);
    setBeatW(newBeatW);
    redraw();
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor    = '';
    document.body.style.userSelect = '';
  });
}

/* ───────────────────────────────────────────────
   INIT
─────────────────────────────────────────────── */
buildKeyboard();
nbInitRoll();
mrInitRoll();
savedRender();

makeRollResizable('nbRollResizeHandle', {
  getRowH:  () => NB_ROW_H,
  setRowH:  v  => { NB_ROW_H  = v; },
  getBeatW: () => NB_BEAT_W,
  setBeatW: v  => { NB_BEAT_W = v; },
  redraw:   ()  => nbDrawRoll(),
});

makeRollResizable('mrRollResizeHandle', {
  getRowH:  () => MR_ROW_H,
  setRowH:  v  => { MR_ROW_H  = v; },
  getBeatW: () => MR_BEAT_W,
  setBeatW: v  => { MR_BEAT_W = v; },
  redraw:   ()  => mrDrawRoll(),
});
