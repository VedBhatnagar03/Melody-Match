/* ───────────────────────────────────────────────
   NOTE BUILDER  —  PIANO ROLL
   Depends on: constants.js, playback.js
─────────────────────────────────────────────── */

let nbOctave = 4;
let nbSequence = []; // {midi, pc, freq, beat, dur}
let nbBpm   = 100;
let nbBars  = 4;
let nbSeqPlaying = false;

// ── Grid constants ──
const NB_ROW_H   = 28;
const NB_BEAT_W  = 48;
const NB_RESIZE_HANDLE = 8;

const NB_WHITES = [
  { name:'C', semi:0 }, { name:'D', semi:2 }, { name:'E', semi:4 },
  { name:'F', semi:5 }, { name:'G', semi:7 }, { name:'A', semi:9 }, { name:'B', semi:11 },
];
const NB_BLACKS = [
  { name:'C#', semi:1, after:0 }, { name:'D#', semi:3, after:1 },
  { name:'F#', semi:6, after:3 }, { name:'G#', semi:8, after:4 }, { name:'A#', semi:10, after:5 },
];

// ── Canvas state ──
let nbCanvas, nbCtx;
let nbDragging = null;
let nbPlayhead = -1;

function nbGetRows() {
  if (nbSequence.length === 0) return [];
  const midis = [...new Set(nbSequence.map(n => n.midi))].sort((a,b) => b - a);
  return midis;
}

function nbTotalBeats() { return nbBars * 4; }

// ── Drawing ──
function nbDrawRoll() {
  const rows  = nbGetRows();
  const beats = nbTotalBeats();
  const W = beats * NB_BEAT_W;
  const H = Math.max(rows.length, 1) * NB_ROW_H;

  nbCanvas.width  = W;
  nbCanvas.height = H;

  const ctx = nbCtx;
  ctx.clearRect(0, 0, W, H);

  // Background rows
  rows.forEach((midi, r) => {
    const isBlack = [1,3,6,8,10].includes(midi % 12);
    ctx.fillStyle = isBlack ? '#0e1828' : '#111827';
    ctx.fillRect(0, r * NB_ROW_H, W, NB_ROW_H);
  });

  // Bar dividers
  for (let b = 0; b <= beats; b++) {
    const x = b * NB_BEAT_W;
    const isBar = b % 4 === 0;
    ctx.strokeStyle = isBar ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)';
    ctx.lineWidth = isBar ? 1.5 : 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }

  // Row dividers
  rows.forEach((_, r) => {
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, r * NB_ROW_H); ctx.lineTo(W, r * NB_ROW_H); ctx.stroke();
  });

  // Note blocks
  nbSequence.forEach((note, i) => {
    const r = rows.indexOf(note.midi);
    if (r < 0) return;
    const dur = note.dur ?? 1;
    const x = note.beat * NB_BEAT_W + 2;
    const y = r * NB_ROW_H + 3;
    const w = Math.max(NB_BEAT_W * 0.4, dur * NB_BEAT_W - 4);
    const h = NB_ROW_H - 6;
    const isActive = nbDragging?.noteIdx === i;

    ctx.shadowColor = '#00d4ff';
    ctx.shadowBlur  = isActive ? 12 : 4;
    ctx.fillStyle   = isActive ? '#40e0ff' : '#00d4ff';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 3);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Resize handle
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.roundRect(x + w - NB_RESIZE_HANDLE, y, NB_RESIZE_HANDLE, h, [0, 3, 3, 0]);
    ctx.fill();

    // Resize grip lines
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    const gx = x + w - NB_RESIZE_HANDLE / 2;
    [h * 0.3, h * 0.5, h * 0.7].forEach(gy => {
      ctx.beginPath(); ctx.moveTo(gx - 1, y + gy); ctx.lineTo(gx + 1, y + gy); ctx.stroke();
    });

    // Note label
    ctx.fillStyle = '#060912';
    ctx.font = 'bold 10px "Space Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pcToName(note.pc), x + (w - NB_RESIZE_HANDLE) / 2, y + h / 2);
  });

  // Playhead
  if (nbPlayhead >= 0) {
    const x = nbPlayhead * NB_BEAT_W;
    ctx.strokeStyle = '#ff4757';
    ctx.lineWidth   = 2;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }

  // Update pitch labels sidebar
  const sidebar = document.getElementById('nbPitchLabels');
  sidebar.innerHTML = '';
  if (rows.length === 0) {
    sidebar.style.height = NB_ROW_H + 'px';
    return;
  }
  rows.forEach(midi => {
    const lbl = document.createElement('div');
    lbl.className = 'nb-pitch-label';
    lbl.style.height = NB_ROW_H + 'px';
    lbl.textContent = pcToName(midi % 12) + (Math.floor(midi / 12) - 1);
    sidebar.appendChild(lbl);
  });
}

// ── Hit test ──
function nbHitNote(cx, cy) {
  const rows = nbGetRows();
  const r    = Math.floor(cy / NB_ROW_H);
  const midi = rows[r];
  if (midi === undefined) return null;
  for (let i = nbSequence.length - 1; i >= 0; i--) {
    const n   = nbSequence[i];
    if (n.midi !== midi) continue;
    const dur = n.dur ?? 1;
    const nx  = n.beat * NB_BEAT_W + 2;
    const nw  = Math.max(NB_BEAT_W * 0.4, dur * NB_BEAT_W - 4);
    if (cx >= nx && cx <= nx + nw) {
      const mode = cx >= nx + nw - NB_RESIZE_HANDLE ? 'resize' : 'move';
      return { idx: i, mode };
    }
  }
  return null;
}

// ── Snap beat to grid (0.5 beat = 8th note) ──
function nbSnapBeat(beat) {
  return Math.max(0, Math.min(nbTotalBeats() - 1, Math.round(beat * 2) / 2));
}

// ── Add note at next free beat slot ──
function nbAddNote(semi) {
  const midi = (nbOctave + 1) * 12 + semi;
  const pc   = midi % 12;
  const freq = 440 * Math.pow(2, (midi - 69) / 12);

  const usedBeats = nbSequence.map(n => n.beat);
  let beat = 0;
  if (usedBeats.length > 0) {
    beat = nbSnapBeat(Math.max(...usedBeats) + 1);
    if (beat >= nbTotalBeats()) beat = nbTotalBeats() - 1;
  }

  nbSequence.push({ midi, pc, freq, beat, dur: 1 });
  nbUpdateUI();
  nbDrawRoll();

  const key = document.querySelector(`#nbKeyboard [data-semi="${semi}"]`);
  if (key) { key.classList.add('lit'); setTimeout(() => key.classList.remove('lit'), 200); }
}

function nbUpdateUI() {
  document.getElementById('nbCount').textContent =
    nbSequence.length + (nbSequence.length === 1 ? ' note' : ' notes');
  document.getElementById('nbAnalyseBtn').disabled = nbSequence.length < 4;
  document.getElementById('nbPlaySeqBtn').disabled = nbSequence.length === 0;
  document.getElementById('nbSaveMelodyBtn').disabled = nbSequence.length === 0;
}

function updateOctaveLabel() {
  document.getElementById('nbOctaveLabel').textContent = nbOctave;
}

// ── Canvas coordinate helper ──
function nbCanvasXY(e) {
  const rect = nbCanvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
}

function nbOnMouseDown(e) {
  const { x, y } = nbCanvasXY(e);
  const hit = nbHitNote(x, y);
  if (!hit) return;
  const n = nbSequence[hit.idx];
  nbDragging = { noteIdx: hit.idx, mode: hit.mode, startX: x, origBeat: n.beat, origDur: n.dur ?? 1 };
  nbCanvas.style.cursor = hit.mode === 'resize' ? 'ew-resize' : 'grabbing';
  nbDrawRoll();
}

function nbOnMouseMove(e) {
  if (!nbDragging) {
    const { x, y } = nbCanvasXY(e);
    const hit = nbHitNote(x, y);
    nbCanvas.style.cursor = !hit ? 'crosshair' : hit.mode === 'resize' ? 'ew-resize' : 'grab';
    return;
  }
  const { x } = nbCanvasXY(e);
  const dx = x - nbDragging.startX;
  const beatDelta = dx / NB_BEAT_W;
  const n = nbSequence[nbDragging.noteIdx];
  if (nbDragging.mode === 'move') {
    n.beat = nbSnapBeat(nbDragging.origBeat + beatDelta);
  } else {
    n.dur = Math.max(0.5, Math.round((nbDragging.origDur + beatDelta) * 2) / 2);
  }
  nbDrawRoll();
}

function nbOnMouseUp(e) {
  if (!nbDragging) return;
  const { x } = nbCanvasXY(e);
  const moved = Math.abs(x - nbDragging.startX);
  if (moved < 4 && nbDragging.mode === 'move') {
    nbSequence.splice(nbDragging.noteIdx, 1);
    nbUpdateUI();
  }
  nbDragging = null;
  nbCanvas.style.cursor = 'crosshair';
  nbDrawRoll();
}

function nbOnTouchStart(e) { e.preventDefault(); nbOnMouseDown(e.touches[0]); }
function nbOnTouchMove(e)  { e.preventDefault(); nbOnMouseMove(e.touches[0]); }
function nbOnTouchEnd(e)   { e.preventDefault(); nbOnMouseUp(e.changedTouches[0]); }

// ── Play single note preview ──
async function nbPlayNote(midi) {
  await Tone.start();
  const { sampler: s } = await loadMelodySampler(melodyInstrument);
  s.triggerAttackRelease(Tone.Frequency(midi, 'midi').toNote(), '8n', Tone.now() + 0.05);
}

async function nbPlaySequence() {
  const btn = document.getElementById('nbPlaySeqBtn');
  if (nbSeqPlaying) {
    nbSeqPlaying = false;
    nbPlayhead = -1;
    playGeneration++;
    btn.textContent = '▶  play sequence';
    btn.classList.remove('playing');
    nbDrawRoll();
    return;
  }
  if (nbSequence.length === 0) return;

  await Tone.start();
  const { sampler: s } = await loadMelodySampler(melodyInstrument);

  nbSeqPlaying = true;
  btn.textContent = '■  stop';
  btn.classList.add('playing');

  const secPerBeat = 60 / nbBpm;
  const sorted = [...nbSequence].sort((a, b) => a.beat - b.beat);
  const now = Tone.now() + 0.05;
  const t0 = performance.now();
  const totalSec = (nbTotalBeats()) * secPerBeat;
  const gen = playGeneration;

  sorted.forEach(p => {
    const delay = p.beat * secPerBeat * 1000;
    setTimeout(() => {
      if (playGeneration !== gen) return;
      s.triggerAttackRelease(
        Tone.Frequency(p.midi, 'midi').toNote(),
        Math.max(0.05, (p.dur ?? 1) * secPerBeat * 0.95),
        Tone.now() + 0.01
      );
    }, delay);
  });

  function animatePlayhead() {
    if (!nbSeqPlaying) return;
    const elapsed = (performance.now() - t0) / 1000;
    nbPlayhead = elapsed / secPerBeat;
    nbDrawRoll();
    if (elapsed < totalSec + 0.5) requestAnimationFrame(animatePlayhead);
    else {
      nbSeqPlaying = false;
      nbPlayhead = -1;
      btn.textContent = '▶  play sequence';
      btn.classList.remove('playing');
      nbDrawRoll();
    }
  }
  requestAnimationFrame(animatePlayhead);
}

// ── Build keyboard ──
function buildKeyboard() {
  const kb = document.getElementById('nbKeyboard');
  kb.innerHTML = '';
  const WHITE_W = 46;

  NB_WHITES.forEach(k => {
    const key = document.createElement('div');
    key.className = 'nb-key white';
    key.textContent = k.name;
    key.dataset.semi = k.semi;
    kb.appendChild(key);
  });

  NB_BLACKS.forEach(k => {
    const key = document.createElement('div');
    key.className = 'nb-key black';
    key.textContent = k.name;
    key.dataset.semi = k.semi;
    key.style.left = (k.after * WHITE_W + WHITE_W - 15) + 'px';
    kb.appendChild(key);
  });

  kb.style.width = (NB_WHITES.length * WHITE_W) + 'px';
}

function nbInitRoll() {
  nbCanvas = document.getElementById('nbRollCanvas');
  nbCtx    = nbCanvas.getContext('2d');

  nbCanvas.addEventListener('mousedown',  nbOnMouseDown);
  nbCanvas.addEventListener('mousemove',  nbOnMouseMove);
  nbCanvas.addEventListener('mouseup',    nbOnMouseUp);
  nbCanvas.addEventListener('mouseleave', nbOnMouseUp);
  nbCanvas.addEventListener('touchstart', nbOnTouchStart, { passive: false });
  nbCanvas.addEventListener('touchmove',  nbOnTouchMove,  { passive: false });
  nbCanvas.addEventListener('touchend',   nbOnTouchEnd,   { passive: false });

  nbDrawRoll();
}

// ── Event wiring ──
document.getElementById('nbKeyboard').addEventListener('click', e => {
  const key = e.target.closest('.nb-key');
  if (!key) return;
  const semi = +key.dataset.semi;
  nbAddNote(semi);
  nbPlayNote((nbOctave + 1) * 12 + semi);
});

document.getElementById('nbPlaySeqBtn').addEventListener('click', nbPlaySequence);

document.getElementById('nbClearBtn').addEventListener('click', () => {
  nbSequence = [];
  nbSeqPlaying = false;
  nbPlayhead = -1;
  document.getElementById('nbPlaySeqBtn').textContent = '▶  play sequence';
  document.getElementById('nbPlaySeqBtn').classList.remove('playing');
  nbUpdateUI();
  nbDrawRoll();
});

document.getElementById('nbOctDown').addEventListener('click', () => {
  if (nbOctave > 2) { nbOctave--; updateOctaveLabel(); }
});
document.getElementById('nbOctUp').addEventListener('click', () => {
  if (nbOctave < 6) { nbOctave++; updateOctaveLabel(); }
});

document.getElementById('nbBpmDown').addEventListener('click', () => {
  nbBpm = Math.max(40, nbBpm - 5);
  document.getElementById('nbBpmLabel').textContent = nbBpm;
});
document.getElementById('nbBpmUp').addEventListener('click', () => {
  nbBpm = Math.min(200, nbBpm + 5);
  document.getElementById('nbBpmLabel').textContent = nbBpm;
});

document.getElementById('nbBarsDown').addEventListener('click', () => {
  if (nbBars > 1) {
    nbBars--;
    document.getElementById('nbBarsLabel').textContent = nbBars;
    nbSequence = nbSequence.filter(n => n.beat < nbTotalBeats());
    nbUpdateUI(); nbDrawRoll();
  }
});
document.getElementById('nbBarsUp').addEventListener('click', () => {
  if (nbBars < 8) {
    nbBars++;
    document.getElementById('nbBarsLabel').textContent = nbBars;
    nbDrawRoll();
  }
});

document.querySelector('.nb-octave-row').addEventListener('click', e => {
  const btn = e.target.closest('.inst-btn[data-inst]');
  if (!btn) return;
  setMelodyInstrument(btn.dataset.inst);
});

document.getElementById('nbAnalyseBtn').addEventListener('click', () => {
  const secPerBeat = 60 / nbBpm;
  detectedPitches = [...nbSequence]
    .sort((a, b) => a.beat - b.beat)
    .map(n => ({ ...n, time: n.beat * secPerBeat * 1000, dur: n.dur ?? 1 }));
  pitchSource = 'builder';
  showScreen('processing');
  setTimeout(() => { buildResults(); showScreen('results'); }, 1000);
});

document.getElementById('nbBackBtn').addEventListener('click', () => {
  showScreen('idle');
});
