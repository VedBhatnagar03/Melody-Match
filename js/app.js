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

document.getElementById('logoHomeBtn').addEventListener('click', () => {
  stopPlayback();
  showScreen('idle');
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
  mrWaveformData = null;
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
  mrWaveformData = null;
  if (mrRawAudioElement) { cancelAnimationFrame(mrRawAnimId); mrRawAnimId = null; mrRawAudioElement.pause(); mrRawAudioElement = null; }
  const kbWrap = document.getElementById('mrKeyboardWrap');
  if (kbWrap) kbWrap.style.display = 'none';
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
let mrRawAnimId = null;
let mrNotesPlaying = false;
// mrSeqPaused is declared in mic-review.js

// Play raw audio and drive the roll playhead from its currentTime.
// startBeat: if provided, seeks raw audio to the equivalent time offset.
function mrStopRaw() {
  if (mrRawAudioElement) {
    cancelAnimationFrame(mrRawAnimId); mrRawAnimId = null;
    mrRawAudioElement.pause();
    mrRawAudioElement = null;
  }
}

// Build a ready-to-play Audio element from rawAudioBlob.
// Returns a Promise that resolves once metadata is loaded.
function mrCreateRawAudio() {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(rawAudioBlob);
    const el = new Audio(url);
    if (el.readyState >= 1) { resolve(el); return; }
    el.addEventListener('loadedmetadata', () => resolve(el), { once: true });
    el.addEventListener('error', reject, { once: true });
  });
}

// Start the raw-audio rAF loop that drives mrPlayhead from el.currentTime.
function mrStartRawAnim(el) {
  const secPerBeat = 60 / mrBpm;
  function animRaw() {
    if (mrRawAudioElement !== el) return; // superseded
    // rawAudioBlob is trimmed to start at beat 0, so currentTime maps directly to beats
    mrPlayhead = el.currentTime / secPerBeat;
    mrDrawRoll();
    mrRawAnimId = requestAnimationFrame(animRaw);
  }
  mrRawAnimId = requestAnimationFrame(animRaw);
}

document.getElementById('mrPlayRawBtn').addEventListener('click', async () => {
  const btn = document.getElementById('mrPlayRawBtn');

  // Resume if paused
  if (mrRawAudioElement && mrRawAudioElement.paused) {
    mrRawAudioElement.play().catch(() => {});
    btn.textContent = '❚❚ pause raw';
    mrStartRawAnim(mrRawAudioElement);
    return;
  }

  // Pause if playing
  if (mrRawAudioElement && !mrRawAudioElement.paused) {
    mrRawAudioElement.pause();
    cancelAnimationFrame(mrRawAnimId); mrRawAnimId = null;
    btn.textContent = '▶ raw audio';
    return;
  }

  // Not loaded yet — start fresh
  if (typeof rawAudioBlob === 'undefined' || !rawAudioBlob) return;

  const el = await mrCreateRawAudio();
  mrRawAudioElement = el;

  el.onended = () => {
    mrStopRaw();
    mrPlayhead = -1;
    mrDrawRoll();
    btn.textContent = '🎤 raw audio';
  };
  el.onerror = () => {
    mrStopRaw();
    btn.textContent = '🎤 raw audio';
  };

  el.play().catch(() => {});
  btn.textContent = '❚❚ pause raw';
  mrStartRawAnim(el);
});

// "Play notes over raw" — load everything first, then start both in the same tick
document.getElementById('mrPlayWithRawBtn').addEventListener('click', async () => {
  if (typeof rawAudioBlob === 'undefined' || !rawAudioBlob) return;
  const btn = document.getElementById('mrPlayWithRawBtn');

  // Toggle off
  if (mrRawAudioElement) {
    mrStopRaw();
    stopPlayback();
    mrPlayhead = -1;
    mrDrawRoll();
    btn.textContent = '🎤+♪ notes over raw';
    return;
  }

  const startBeat = mrPlayhead >= 0 ? mrPlayhead : 0;
  btn.textContent = '⟳ loading...';

  // Load BOTH the raw audio metadata AND the melody sampler before starting either
  let rawEl, preloadedSampler;
  try {
    let melHandle;
    [rawEl, , melHandle] = await Promise.all([
      mrCreateRawAudio(),
      Tone.start(),
      loadMelodySampler(melodyInstrument),
    ]);
    preloadedSampler = melHandle.sampler;
  } catch(e) {
    btn.textContent = '🎤+♪ notes over raw';
    return;
  }

  // rawAudioBlob is trimmed to start at beat 0, so seek directly by beat
  const secPerBeat = 60 / mrBpm;
  rawEl.currentTime = startBeat * secPerBeat;

  // Stop any previous note playback (stopPlayback increments playGeneration)
  stopPlayback();

  // Register raw element AFTER stopPlayback so mrStopRaw inside stop handler doesn't kill it
  mrRawAudioElement = rawEl;
  rawEl.onended = () => {
    mrStopRaw();
    mrPlayhead = -1;
    mrDrawRoll();
    btn.textContent = '🎤+♪ notes over raw';
  };
  rawEl.onerror = () => {
    mrStopRaw();
    btn.textContent = '🎤+♪ notes over raw';
  };

  // Start raw audio
  rawEl.play().catch(() => {});
  btn.textContent = '❚❚ stop';

  // Start note playback — mrStartPlaybackFrom drives its own animPlayhead loop.
  // We skip it here and instead drive the playhead purely from raw audio currentTime
  // so the scrubber stays locked to the audio.
  mrStartRawAnim(rawEl);
  mrStartPlaybackFrom(startBeat, preloadedSampler);
});

async function mrStartPlaybackFrom(startBeat, preloadedSampler = null) {
  if (mrSequence.length === 0) return;
  stopPlayback();

  if (!preloadedSampler) {
    await Tone.start();
    const { sampler } = await loadMelodySampler(melodyInstrument);
    preloadedSampler = sampler;
  }
  const mel = preloadedSampler;
  const secPerBeat = 60 / mrBpm;
  const now = Tone.now() + 0.05;
  const gen = ++playGeneration;
  mrNotesPlaying = true;
  mrSeqPaused = false;
  const playBtn = document.getElementById('mrPlayBtn');
  if (playBtn) { playBtn.textContent = '❚❚  pause'; playBtn.classList.add('playing'); }
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
    if (playGeneration !== gen) {
      if (!mrRawAudioElement && !mrSeqPaused) {
        mrNotesPlaying = false;
        const pb = document.getElementById('mrPlayBtn');
        pb.textContent = '▶  play sequence'; pb.classList.remove('playing');
        mrPlayhead = -1; mrDrawRoll();
      }
      return;
    }
    // If raw audio is also playing, let mrStartRawAnim own the playhead
    if (!mrRawAudioElement) {
      const elapsed = (performance.now() - startTime) / 1000;
      mrPlayhead = startBeat + elapsed / secPerBeat;
      mrDrawRoll();
      if (elapsed < totalLen - startSec) requestAnimationFrame(animPlayhead);
      else {
        mrNotesPlaying = false;
        const pb = document.getElementById('mrPlayBtn');
        if (pb && !mrSeqPaused) { pb.textContent = '▶  play sequence'; pb.classList.remove('playing'); }
        mrPlayhead = -1; mrDrawRoll();
      }
    } else {
      // Raw audio owns playhead — just keep looping until notes are done
      const elapsed = (performance.now() - startTime) / 1000;
      if (elapsed < totalLen - startSec) requestAnimationFrame(animPlayhead);
    }
  }
  requestAnimationFrame(animPlayhead);

  setTimeout(() => { if (playGeneration === gen) stopPlayback(); }, (totalLen - startSec + 1) * 1000);
}

// Called when user drags the playhead and releases
function mrSeekPlayback(beat) {
  if (mrRawAudioElement) {
    mrRawAudioElement.currentTime = beat * (60 / mrBpm);
  }
  // If note playback is running, restart from new position
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

document.getElementById('mrPlayBtn').addEventListener('click', async () => {
  const btn = document.getElementById('mrPlayBtn');
  if (mrNotesPlaying) {
    // Pause: capture position, set paused flag BEFORE stopPlayback so animPlayhead sees it
    const pausedAt = mrPlayhead >= 0 ? mrPlayhead : 0;
    mrSeqPaused = true;      // set BEFORE stopPlayback increments playGeneration
    mrNotesPlaying = false;
    stopPlayback();
    mrPlayhead = pausedAt;   // restore after stopPlayback (animPlayhead may have clobbered it)
    btn.textContent = '▶  resume';
    btn.classList.remove('playing');
    mrDrawRoll();
    return;
  }
  mrSeqPaused = false;
  const start = mrPlayhead >= 0 ? mrPlayhead : 0;
  await mrStartPlaybackFrom(start);
});

document.getElementById('mrJumpEndBtn').addEventListener('click', () => {
  const endBeat = mrSequence.length > 0 ? Math.max(...mrSequence.map(n => n.beat + n.dur)) : mrTotalBeats();
  mrPlayhead = endBeat;
  mrDrawRoll();
});

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

document.getElementById('mrKeyboardWrap')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-mr-inst]');
  if (!btn) return;
  setMelodyInstrument(btn.dataset.mrInst);
  document.querySelectorAll('#mrKeyboardWrap [data-mr-inst]').forEach(b =>
    b.classList.toggle('active', b.dataset.mrInst === btn.dataset.mrInst));
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

// Returns true on success, false if quota exceeded
function savedWrite(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch(e) {
    if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') return false;
    throw e;
  }
}

// ── Storage-full modal ──
// pendingRetrySave: function to call after user frees space
let _storageFullRetry = null;

function showStorageFullModal(retryFn) {
  _storageFullRetry = retryFn;
  renderStorageFullList();
  document.getElementById('storageFullModal').style.display = 'flex';
}

function renderStorageFullList() {
  const list = savedLoad();
  const el = document.getElementById('storageFullList');
  if (list.length === 0) {
    el.innerHTML = '<p style="color:var(--text3);font-size:12px;text-align:center;">No saved melodies found.</p>';
    return;
  }
  el.innerHTML = list.map((m, i) => `
    <div class="storage-full-item" id="sfi-${i}">
      <div class="storage-full-item-name">${m.name}</div>
      <div class="storage-full-item-meta">${m.noteCount} notes · ${m.bpm} bpm · ${m.date}</div>
      <button class="storage-full-delete-btn" data-idx="${i}">✕ delete</button>
    </div>
  `).join('');
  el.querySelectorAll('.storage-full-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      savedDelete(idx);
      renderStorageFullList(); // re-render after delete
    });
  });
}

document.getElementById('storageFullCancel').addEventListener('click', () => {
  document.getElementById('storageFullModal').style.display = 'none';
  _storageFullRetry = null;
});
document.getElementById('storageFullRetry').addEventListener('click', () => {
  if (_storageFullRetry) {
    document.getElementById('storageFullModal').style.display = 'none';
    _storageFullRetry();
    _storageFullRetry = null;
  }
});
document.getElementById('storageFullModal').addEventListener('click', e => {
  if (e.target === document.getElementById('storageFullModal')) {
    document.getElementById('storageFullCancel').click();
  }
});

function savedRender() {
  const list = savedLoad();
  const el = document.getElementById('savedList');
  const section = document.getElementById('savedSection');
  section.style.display = list.length === 0 ? 'none' : '';

  if (list.length === 0) { el.innerHTML = ''; return; }

  el.innerHTML = list.map((m, i) => {
    const isEditor  = m.source === 'editor';
    const isMic     = m.source === 'mic';
    const badge     = isEditor
      ? `<span class="saved-source-badge saved-source-editor">✏️ edited</span>`
      : isMic
        ? `<span class="saved-source-badge saved-source-mic">🎤 recorded</span>`
        : `<span class="saved-source-badge saved-source-builder">🎹 built</span>`;
    const audioHint = (isMic && !m.rawAudioB64) ? ` · <span title="Original audio not saved (too large)">no audio</span>` : '';
    const chordHint = isEditor && m.edBars ? ` · ${m.edBars.length} chords` : '';
    const loadLabel = isEditor ? 'open editor' : 'load';
    return `
    <div class="saved-item${isEditor ? ' saved-item-editor' : ''}" data-idx="${i}">
      <div class="saved-item-info">
        <div class="saved-item-name">${m.name} ${badge}</div>
        <div class="saved-item-meta">${m.noteCount} notes · ${m.bpm} bpm · ${m.bars} bars${chordHint} · ${m.date}${audioHint}</div>
      </div>
      <div class="saved-item-btns">
        <button class="saved-load-btn" data-idx="${i}">${loadLabel}</button>
        <button class="saved-delete-btn" data-idx="${i}">✕</button>
      </div>
    </div>
  `;
  }).join('');

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

  if (m.source === 'editor' && m.edBars) {
    const restoreAndOpen = () => {
      detectedPitches = (m.pitches || []).map(p => ({ ...p }));
      pitchSource = 'mic';
      if (typeof openEditor === 'function') {
        openEditor(m.edBars.map(b => ({ ...b })), m.pitches || [], m.bpm || 100, m.scaleResult || null);
        // openEditor resets edCurrentSavedIdx to -1; restore it so subsequent saves overwrite
        edCurrentSavedIdx = idx;
      }
    };

    if (m.rawAudioB64 && m.rawAudioType) {
      // Blob was saved — decode and restore it
      rawAudioBlob = null;
      try {
        const binary = atob(m.rawAudioB64);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const restoredBlob = new Blob([bytes], { type: m.rawAudioType });
        restoredBlob.arrayBuffer().then(ab => {
          const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
          ctx.decodeAudioData(ab).then(audioBuf => {
            ctx.close();
            rawAudioBlob = restoredBlob;
            restoreAndOpen();
          }).catch(() => { ctx.close(); restoreAndOpen(); });
        }).catch(() => restoreAndOpen());
      } catch(e) { restoreAndOpen(); }
    } else {
      // Blob wasn't saved (too large) — keep whatever rawAudioBlob is already in memory
      // (e.g. the user is in the same session they recorded in)
      restoreAndOpen();
    }
    return;
  }

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
  } else if (m.source === 'mic' && m.sequence) {
    // Recorded melody saved from mic-review — restore to mic-review screen
    mrSequence   = m.sequence.map(n => ({ ...n }));
    mrBpm        = m.bpm  || 100;
    mrBars       = m.bars || 4;
    mrTakes      = [{ notes: mrSequence.map(n => ({ ...n })), bpm: mrBpm, label: 'Saved Take' }];
    mrActiveTake = 0;
    mrUndoStack  = []; mrRedoStack = [];

    // Restore raw audio blob if saved — trim to beat 0 if it's an old untrimmed save
    rawAudioBlob = null;
    mrWaveformData = null;
    if (m.rawAudioB64 && m.rawAudioType) {
      try {
        const binary = atob(m.rawAudioB64);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const restoredBlob = new Blob([bytes], { type: m.rawAudioType });

        // Decode, trim to beat 0, recompute waveform, then set rawAudioBlob.
        restoredBlob.arrayBuffer().then(ab => {
          const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
          ctx.decodeAudioData(ab).then(audioBuf => {
            ctx.close();
            const sr = audioBuf.sampleRate;

            // Determine trim offset:
            // 1. Explicit rawBeat0Sec from older saves that stored it
            // 2. Auto-detect: scan RMS in 10ms hops, find first frame above noise floor
            // 3. Fall back to 0 (new saves already trimmed)
            let offsetSec = m.rawBeat0Sec || 0;
            if (!offsetSec) {
              const mono0 = audioBuf.numberOfChannels > 1
                ? (() => { const L = audioBuf.getChannelData(0), R = audioBuf.getChannelData(1), mx = new Float32Array(L.length); for (let i=0;i<L.length;i++) mx[i]=(L[i]+R[i])*0.5; return mx; })()
                : audioBuf.getChannelData(0);
              const hopSamples = Math.round(sr * 0.01); // 10ms
              const NOISE_FLOOR = 0.018;
              for (let pos = 0; pos + hopSamples < mono0.length; pos += hopSamples) {
                let rms = 0;
                for (let i = 0; i < hopSamples; i++) rms += mono0[pos + i] ** 2;
                rms = Math.sqrt(rms / hopSamples);
                if (rms > NOISE_FLOOR) { offsetSec = pos / sr; break; }
              }
            }

            let buf = audioBuf;
            if (offsetSec > 0.05) {
              const startSample = Math.floor(offsetSec * sr);
              const numSamples  = audioBuf.length - startSample;
              const trimCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: sr });
              buf = trimCtx.createBuffer(audioBuf.numberOfChannels, numSamples, sr);
              for (let ch = 0; ch < audioBuf.numberOfChannels; ch++) {
                buf.copyToChannel(audioBuf.getChannelData(ch).subarray(startSample), ch);
              }
              trimCtx.close();
              rawAudioBlob = audioBufferToWavBlob(buf);
            } else {
              rawAudioBlob = restoredBlob; // already trimmed / no silence to remove
            }

            const mono = buf.numberOfChannels > 1
              ? (() => { const L = buf.getChannelData(0), R = buf.getChannelData(1), m2 = new Float32Array(L.length); for (let i=0;i<L.length;i++) m2[i]=(L[i]+R[i])*0.5; return m2; })()
              : buf.getChannelData(0);
            const NUM = 800, bsz = Math.floor(mono.length / NUM);
            const buckets = new Float32Array(NUM);
            for (let b=0;b<NUM;b++) { let s=0; for (let j=0;j<bsz;j++) s+=mono[b*bsz+j]**2; buckets[b]=Math.sqrt(s/bsz); }
            const peak = Math.max(...buckets, 0.0001);
            mrWaveformData = buckets.map(v => v/peak);
            mrDrawRoll();
          }).catch(() => ctx.close());
        }).catch(() => {});
      } catch(e) { rawAudioBlob = null; }
    }

    pitchSource  = 'mic';
    detectedPitches = mrSequence.map(n => ({ ...n, time: n.beat * (60 / mrBpm) * 1000 }));
    mrUpdateUI();
    mrRenderTakes();
    mrDrawRoll();
    const sub = document.getElementById('mrSub');
    if (sub) sub.textContent = `${mrSequence.length} notes · ${mrBpm} BPM · loaded from saved`;
    showScreen('mic-review');
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
    const ok = savedWrite(freshList);
    if (!ok) {
      // Quota exceeded — revert the unshift so list stays clean, then prompt
      if (!isOverwrite) freshList.shift();
      showStorageFullModal(() => doSave(name));
      return;
    }
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
    const ok = savedWrite(freshList);
    if (!ok) {
      if (!isOverwrite) freshList.shift();
      showStorageFullModal(() => doSave(name));
      return;
    }
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

async function savedSaveFromMicReview() {
  if (mrSequence.length === 0) return;
  const list = savedLoad();
  const isOverwrite = currentSavedIdx >= 0 && currentSavedIdx < list.length;

  const doSave = async (name) => {
    // Try to encode rawAudioBlob as base64 — skip if too large (>3MB blob → ~4MB base64)
    let rawAudioB64 = null;
    let rawAudioType = null;
    if (typeof rawAudioBlob !== 'undefined' && rawAudioBlob && rawAudioBlob.size < 3 * 1024 * 1024) {
      try {
        const ab = await rawAudioBlob.arrayBuffer();
        const bytes = new Uint8Array(ab);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        rawAudioB64 = btoa(binary);
        rawAudioType = rawAudioBlob.type || 'audio/webm';
      } catch(e) { rawAudioB64 = null; }
    }

    const entry = {
      version: STORAGE_VERSION,
      name,
      date: new Date().toLocaleDateString(),
      noteCount: mrSequence.length,
      bpm: mrBpm,
      bars: mrBars,
      source: 'mic',
      pitches: [...mrSequence].sort((a, b) => a.beat - b.beat).map(n => ({
        ...n,
        time: n.beat * (60 / mrBpm) * 1000,
      })),
      sequence: mrSequence.map(n => ({ ...n })),
      rawAudioB64,
      rawAudioType,
    };

    const freshList = savedLoad();
    if (isOverwrite) {
      freshList[currentSavedIdx] = entry;
    } else {
      freshList.unshift(entry);
      currentSavedIdx = 0;
    }
    let ok = savedWrite(freshList);
    if (!ok && entry.rawAudioB64) {
      // First retry: drop the raw audio to save space
      entry.rawAudioB64 = null;
      entry.rawAudioType = null;
      ok = savedWrite(freshList);
    }
    if (!ok) {
      // Still no space — revert and show the storage-full modal
      if (!isOverwrite) freshList.shift();
      showStorageFullModal(() => doSave(name));
      return;
    }
    savedRender();
    const btn = document.getElementById('mrSaveMelodyBtn');
    btn.textContent = '✓ saved!';
    btn.classList.add('saved');
    setTimeout(() => { btn.textContent = '✦ save'; btn.classList.remove('saved'); }, 2000);
  };

  if (isOverwrite) {
    doSave(list[currentSavedIdx].name);
  } else {
    savedShowModal('My Recording', doSave);
  }
}

async function savedSaveFromEditor() {
  if (!edPitches || edBars.length === 0) return;

  const list = savedLoad();
  const isOverwrite = edCurrentSavedIdx >= 0
    && edCurrentSavedIdx < list.length
    && list[edCurrentSavedIdx].source === 'editor';

  const doSave = async (name) => {
    let rawAudioB64 = null, rawAudioType = null;
    if (typeof rawAudioBlob !== 'undefined' && rawAudioBlob && rawAudioBlob.size < 3 * 1024 * 1024) {
      try {
        const ab = await rawAudioBlob.arrayBuffer();
        const bytes = new Uint8Array(ab);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        rawAudioB64  = btoa(binary);
        rawAudioType = rawAudioBlob.type || 'audio/wav';
      } catch(e) { rawAudioB64 = null; }
    }

    const entry = {
      version:     STORAGE_VERSION,
      name,
      date:        new Date().toLocaleDateString(),
      source:      'editor',
      noteCount:   edPitches.length,
      bpm:         edBpm,
      bars:        Math.ceil(edBars.reduce((mx, b) => Math.max(mx, (b.beatOffset || 0) + (b.dur || 4)), 0) / 4),
      pitches:     edPitches.map(p => ({ ...p })),
      edBars:      edBars.map(b => ({ ...b })),
      scaleResult: edScaleResult ? { ...edScaleResult } : null,
      rawAudioB64,
      rawAudioType,
    };

    const freshList = savedLoad();
    if (isOverwrite) {
      freshList[edCurrentSavedIdx] = entry;
    } else {
      freshList.unshift(entry);
      edCurrentSavedIdx = 0;
    }
    let ok = savedWrite(freshList);
    if (!ok && entry.rawAudioB64) {
      entry.rawAudioB64 = null; entry.rawAudioType = null;
      ok = savedWrite(freshList);
    }
    if (!ok) {
      if (!isOverwrite) { freshList.shift(); edCurrentSavedIdx = -1; }
      showStorageFullModal(() => doSave(name));
      return;
    }
    savedRender();
    const btn = document.getElementById('editorSaveBtn');
    if (btn) {
      btn.textContent = '✓ saved!';
      btn.classList.add('saved');
      setTimeout(() => { btn.textContent = '✦ save'; btn.classList.remove('saved'); }, 2000);
    }
  };

  if (isOverwrite) {
    // Silent overwrite — no name modal
    doSave(list[edCurrentSavedIdx].name);
  } else {
    const defaultName = edScaleResult?.scale?.name
      ? `${pcToName(edScaleResult.root ?? 0)} ${edScaleResult.scale.name} – edit`
      : 'Edited Version';
    savedShowModal(defaultName, doSave);
  }
}

document.getElementById('mrSaveMelodyBtn').addEventListener('click', savedSaveFromMicReview);

document.getElementById('saveMelodyBtn').addEventListener('click', savedSaveFromResults);

document.getElementById('editMelodyBtn').addEventListener('click', () => {
  stopPlayback();

  // Load current notes into mic-review
  const bpm = (mrSequence && mrSequence.length > 0) ? mrBpm : (_lastResults.bpm || 100);
  let pitches = (mrSequence && mrSequence.length > 0) ? mrSequence : detectedPitches;
  if (!pitches || pitches.length === 0) return;

  const spb = 60 / bpm;
  const seq = pitches.map(p => ({
    midi: p.midi,
    pc:   p.pc ?? (p.midi % 12),
    beat: p.beat ?? ((p.time || 0) / 1000 / spb),
    dur:  p.dur  ?? 0.5,
    conf: p.conf ?? 1,
  }));
  const maxBeat = seq.length > 0 ? Math.max(...seq.map(n => n.beat + n.dur)) : 4;
  mrSequence = seq;
  mrBpm      = bpm;
  mrBars     = Math.max(2, Math.min(8, Math.ceil(maxBeat / 4)));
  mrUndoStack = []; mrRedoStack = [];
  if (mrTakes.length === 0) {
    mrTakes = [{ notes: seq.map(n => ({ ...n })), bpm: mrBpm, label: 'Edited' }];
    mrActiveTake = 0;
  }
  mrUpdateUI();
  mrRenderTakes();
  mrDrawRoll();

  const sub = document.getElementById('mrSub');
  if (sub) sub.textContent = `${seq.length} notes · ${mrBpm} BPM · editing`;

  // Show the piano keyboard panel on this screen
  const kbWrap = document.getElementById('mrKeyboardWrap');
  if (kbWrap) {
    kbWrap.style.display = '';
    if (typeof buildMrKeyboard === 'function') buildMrKeyboard();
  }

  showScreen('mic-review');
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
      _lastResults.scaleRoot    = best.root;
      _lastResults.scaleProfile = best.scale.profile;
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
    // 8px of drag = 1px of row height change; 6px drag = 1px of beat width change
    const newRowH  = Math.max(minRowH,  Math.min(maxRowH,  origRowH  + Math.round(dy / 8)));
    const newBeatW = Math.max(minBeatW, Math.min(maxBeatW, origBeatW + Math.round(dx / 6)));
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

/* ───────────────────────────────────────────────
   VERSION CHECK
   Compares the embedded commit hash in version.js
   against the latest commit on GitHub.
─────────────────────────────────────────────── */
(async function checkVersion() {
  const badge = document.getElementById('versionBadge');
  if (!badge || typeof APP_VERSION === 'undefined') return;

  const short = APP_VERSION.commit.slice(0, 7);
  badge.style.display = '';

  try {
    const res = await fetch(
      `https://api.github.com/repos/${APP_VERSION.repo}/commits/${APP_VERSION.branch}`,
      { headers: { Accept: 'application/vnd.github.v3+json' }, cache: 'no-store' }
    );
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    const latestCommit = data.sha;
    const latestShort  = latestCommit.slice(0, 7);

    if (latestCommit === APP_VERSION.commit) {
      badge.textContent = `● ${short}`;
      badge.className   = 'version-badge version-ok';
      badge.title       = `Up to date (${short})`;
    } else {
      badge.textContent = `⚠ update available`;
      badge.className   = 'version-badge version-outdated';
      badge.title       = `You are on ${short}, latest is ${latestShort}. Hard-refresh (Ctrl+Shift+R) to update.`;
    }
  } catch(e) {
    // Offline or API rate-limited — just show current hash quietly
    badge.textContent = short;
    badge.className   = 'version-badge version-unknown';
    badge.title       = `Version ${short} (could not check for updates)`;
  }
})();
