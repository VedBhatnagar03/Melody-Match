/* ───────────────────────────────────────────────
   NOTE BUILDER  —  PIANO ROLL
   Depends on: constants.js, playback.js
─────────────────────────────────────────────── */

let nbOctave = 4;
let nbSequence = []; // {midi, pc, freq, beat, dur}
let nbBpm   = 100;
let nbBars  = 4;
let nbSeqPlaying = false;
let nbSeqPaused = false;

// ── Grid constants (mutable for zoom) ──
let NB_ROW_H   = 28;
let NB_BEAT_W  = 48;
const NB_RESIZE_HANDLE = 8;

// ── Selection / copy-paste state ──
let nbSelected  = new Set(); // indices of selected notes
let nbClipboard = [];        // [{midi,pc,freq,beat,dur}]
let nbBoxSel    = null;      // {startX,startY,endX,endY} while rubber-banding
let nbBoxShift  = false;     // was Shift held when box-drag started?

// Metronome
let nbMetronomeEnabled = false;

const NB_WHITES = [
  { name:'C', semi:0 }, { name:'D', semi:2 }, { name:'E', semi:4 },
  { name:'F', semi:5 }, { name:'G', semi:7 }, { name:'A', semi:9 }, { name:'B', semi:11 },
];
const NB_BLACKS = [
  { name:'C#', semi:1, after:0 }, { name:'D#', semi:3, after:1 },
  { name:'F#', semi:6, after:3 }, { name:'G#', semi:8, after:4 }, { name:'A#', semi:10, after:5 },
];

// ── Undo / redo ──
let nbUndoStack = []; // array of deep-copied nbSequence snapshots
let nbRedoStack = [];

function nbPushUndo() {
  nbUndoStack.push(nbSequence.map(n => ({ ...n })));
  if (nbUndoStack.length > 10) nbUndoStack.shift();
  nbRedoStack = []; // new action clears redo
}

function nbUndo() {
  if (nbUndoStack.length === 0) return;
  nbRedoStack.push(nbSequence.map(n => ({ ...n })));
  nbSequence = nbUndoStack.pop();
  nbSelected.clear();
  nbUpdateUI();
  nbDrawRoll();
}

function nbRedo() {
  if (nbRedoStack.length === 0) return;
  nbUndoStack.push(nbSequence.map(n => ({ ...n })));
  nbSequence = nbRedoStack.pop();
  nbSelected.clear();
  nbUpdateUI();
  nbDrawRoll();
}

// ── Canvas state ──
let nbCanvas, nbCtx;
let nbDragging  = null;
let nbScrubbing = false;
let nbPlayhead  = -1;
let nbTimeouts  = []; // tracked so they can be cancelled on stop

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
    const isActive   = nbDragging?.noteIdx === i;
    const isSelected = nbSelected.has(i);

    ctx.shadowColor = isSelected ? '#a78bfa' : '#00d4ff';
    ctx.shadowBlur  = isActive ? 12 : isSelected ? 10 : 4;
    ctx.fillStyle   = isActive ? '#40e0ff' : isSelected ? '#c4b5fd' : '#00d4ff';
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

  // Box selection rectangle
  if (nbBoxSel) {
    const bx = Math.min(nbBoxSel.startX, nbBoxSel.endX);
    const by = Math.min(nbBoxSel.startY, nbBoxSel.endY);
    const bw = Math.abs(nbBoxSel.endX - nbBoxSel.startX);
    const bh = Math.abs(nbBoxSel.endY - nbBoxSel.startY);
    ctx.strokeStyle = 'rgba(167,139,250,0.9)';
    ctx.fillStyle   = 'rgba(167,139,250,0.08)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 2);
    ctx.fill(); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Playhead
  if (nbPlayhead >= 0) {
    const x = nbPlayhead * NB_BEAT_W;
    ctx.strokeStyle = '#ff4757';
    ctx.lineWidth   = 2;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    // Draggable handle triangle at top
    ctx.fillStyle = '#ff4757';
    ctx.beginPath();
    ctx.moveTo(x - 7, 0);
    ctx.lineTo(x + 7, 0);
    ctx.lineTo(x, 10);
    ctx.closePath();
    ctx.fill();
  }

  // Update pitch labels sidebar
  const sidebar = document.getElementById('nbPitchLabels');
  sidebar.innerHTML = '';
  const fontSize = Math.max(7, Math.min(13, NB_ROW_H * 0.45));
  if (rows.length === 0) {
    sidebar.style.height = NB_ROW_H + 'px';
    return;
  }
  sidebar.style.height = H + 'px';
  rows.forEach(midi => {
    const lbl = document.createElement('div');
    lbl.className = 'nb-pitch-label';
    lbl.style.height   = NB_ROW_H + 'px';
    lbl.style.fontSize = fontSize + 'px';
    lbl.style.flexShrink = '0';
    lbl.textContent = pcToName(midi % 12) + (Math.floor(midi / 12) - 1);
    sidebar.appendChild(lbl);
  });
}

// ── Playhead hit test (within 10px of the line) ──
function nbHitPlayhead(x) {
  if (nbPlayhead < 0) return false;
  return Math.abs(x - nbPlayhead * NB_BEAT_W) <= 10;
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

// ── Add note at playhead if visible, otherwise at end ──
function nbAddNoteByMidi(midi) {
  const insertBeat = nbPlayhead >= 0
    ? nbSnapBeat(nbPlayhead)
    : (nbSequence.length > 0 ? Math.max(...nbSequence.map(n => n.beat + (n.dur ?? 1))) : 0);
  const dur = 1;
  const pc = midi % 12;
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  nbSequence.push({ midi, pc, freq, beat: insertBeat, dur });
  nbBars = Math.max(nbBars, Math.ceil((insertBeat + dur) / 4));
  nbUpdateUI();
  nbDrawRoll();

  const key = document.querySelector(`#nbKeyboard [data-midi="${midi}"]`);
  if (key) { key.classList.add('lit'); setTimeout(() => key.classList.remove('lit'), 200); }
}

// ── Legacy helper (used by octave-based calls if any) ──
function nbAddNote(semi) {
  nbAddNoteByMidi((nbOctave + 1) * 12 + semi);
}

function nbUpdateUI() {
  document.getElementById('nbCount').textContent =
    nbSequence.length + (nbSequence.length === 1 ? ' note' : ' notes');
  document.getElementById('nbAnalyseBtn').disabled = nbSequence.length < 4;
  document.getElementById('nbPlaySeqBtn').disabled = nbSequence.length === 0;
  document.getElementById('nbSaveMelodyBtn').disabled = nbSequence.length === 0;
  // Show playhead at beat 0 as soon as there are notes; hide when sequence is empty
  if (nbSequence.length > 0 && nbPlayhead < 0) {
    nbPlayhead = 0;
    if (typeof nbStartBeat !== 'undefined') nbStartBeat = 0;
  } else if (nbSequence.length === 0) {
    nbPlayhead = -1;
    if (typeof nbStartBeat !== 'undefined') nbStartBeat = 0;
  }
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

  // 0 — playhead scrub
  if (nbHitPlayhead(x)) {
    nbScrubbing = true;
    nbCanvas.style.cursor = 'col-resize';
    return;
  }

  const hit = nbHitNote(x, y);

  if (!hit) {
    // Start box selection on empty area
    nbBoxShift = e.shiftKey;
    if (!nbBoxShift) nbSelected.clear();
    nbBoxSel = { startX: x, startY: y, endX: x, endY: y };
    nbDrawRoll();
    return;
  }

  const n = nbSequence[hit.idx];

  if (e.shiftKey) {
    // Shift-click toggles selection
    if (nbSelected.has(hit.idx)) nbSelected.delete(hit.idx);
    else nbSelected.add(hit.idx);
    nbDrawRoll();
    return;
  }

  if (hit.mode === 'resize') {
    nbPushUndo();
    nbDragging = { noteIdx: hit.idx, mode: 'resize', startX: x, startY: y, origBeat: n.beat, origDur: n.dur ?? 1 };
    nbCanvas.style.cursor = 'ew-resize';
    nbDrawRoll();
    return;
  }

  // Move: if clicking a selected note, move the whole group; otherwise select just this note
  if (!nbSelected.has(hit.idx)) {
    nbSelected.clear();
    nbSelected.add(hit.idx);
  }

  // Store original beats and midis for all selected notes
  const origBeats = {};
  const origMidis = {};
  nbSelected.forEach(i => {
    origBeats[i] = nbSequence[i].beat;
    origMidis[i] = nbSequence[i].midi;
  });

  nbPushUndo();
  nbDragging = { noteIdx: hit.idx, mode: 'move', startX: x, startY: y, origBeat: n.beat, origDur: n.dur ?? 1, origMidi: n.midi, origBeats, origMidis };
  nbCanvas.style.cursor = 'grabbing';
  nbDrawRoll();
}

function nbOnMouseMove(e) {
  const { x, y } = nbCanvasXY(e);

  if (nbScrubbing) {
    nbPlayhead = Math.max(0, Math.min(nbTotalBeats(), x / NB_BEAT_W));
    nbDrawRoll();
    return;
  }

  if (nbBoxSel) {
    nbBoxSel.endX = x;
    nbBoxSel.endY = y;
    // Update selection from box
    const rows = nbGetRows();
    const bx1 = Math.min(nbBoxSel.startX, x);
    const bx2 = Math.max(nbBoxSel.startX, x);
    const by1 = Math.min(nbBoxSel.startY, y);
    const by2 = Math.max(nbBoxSel.startY, y);
    if (!nbBoxShift) nbSelected.clear();
    nbSequence.forEach((n, i) => {
      const r = rows.indexOf(n.midi);
      if (r < 0) return;
      const dur = n.dur ?? 1;
      const nx1 = n.beat * NB_BEAT_W + 2;
      const nx2 = nx1 + Math.max(NB_BEAT_W * 0.4, dur * NB_BEAT_W - 4);
      const ny1 = r * NB_ROW_H;
      const ny2 = ny1 + NB_ROW_H;
      if (nx1 < bx2 && nx2 > bx1 && ny1 < by2 && ny2 > by1) nbSelected.add(i);
    });
    nbDrawRoll();
    return;
  }

  if (!nbDragging) {
    if (nbHitPlayhead(x)) { nbCanvas.style.cursor = 'col-resize'; return; }
    const hit = nbHitNote(x, y);
    nbCanvas.style.cursor = !hit ? 'crosshair' : hit.mode === 'resize' ? 'ew-resize' : 'grab';
    return;
  }

  const dx = x - nbDragging.startX;
  const dy = y - (nbDragging.startY ?? y);
  const beatDelta  = dx / NB_BEAT_W;
  const pitchDelta = -Math.round(dy / NB_ROW_H); // up = higher midi

  if (nbDragging.mode === 'move') {
    // Move all selected notes together (horizontal + vertical)
    nbSelected.forEach(i => {
      nbSequence[i].beat = nbSnapBeat(nbDragging.origBeats[i] + beatDelta);
      const newMidi = Math.max(21, Math.min(108, nbDragging.origMidis[i] + pitchDelta));
      nbSequence[i].midi = newMidi;
      nbSequence[i].pc   = newMidi % 12;
      nbSequence[i].freq = 440 * Math.pow(2, (newMidi - 69) / 12);
    });
  } else {
    const n = nbSequence[nbDragging.noteIdx];
    n.dur = Math.max(0.5, Math.round((nbDragging.origDur + beatDelta) * 2) / 2);
  }
  nbDrawRoll();
}

function nbOnMouseUp(e) {
  if (nbScrubbing) {
    nbScrubbing = false;
    nbCanvas.style.cursor = 'crosshair';
    if (nbPlayhead >= 0) nbSeekPlayback(nbPlayhead);
    return;
  }

  if (nbBoxSel) {
    nbBoxSel = null;
    nbDrawRoll();
    return;
  }

  if (!nbDragging) return;

  // No delete on click — click selects, Backspace/Delete removes
  nbDragging = null;
  nbCanvas.style.cursor = 'crosshair';
  nbDrawRoll();
}

function nbOnTouchStart(e) { e.preventDefault(); nbOnMouseDown(e.touches[0]); }
function nbOnTouchMove(e)  { e.preventDefault(); nbOnMouseMove(e.touches[0]); }
function nbOnTouchEnd(e)   { e.preventDefault(); nbOnMouseUp(e.changedTouches[0]); }

// ── Copy / paste ──
function nbCopySelected() {
  if (nbSelected.size === 0) return;
  const sel = [...nbSelected].map(i => nbSequence[i]);
  const minBeat = Math.min(...sel.map(n => n.beat));
  nbClipboard = sel.map(n => ({ ...n, beat: n.beat - minBeat })); // normalise to beat 0
}

function nbPasteClipboard() {
  if (nbClipboard.length === 0) return;
  nbPushUndo();
  const maxBeat = nbSequence.length > 0 ? Math.max(...nbSequence.map(n => n.beat + (n.dur ?? 1))) : 0;
  const insertBeat = nbSnapBeat(maxBeat);
  nbSelected.clear();
  nbClipboard.forEach(n => {
    const newNote = { ...n, beat: nbSnapBeat(insertBeat + n.beat) };
    nbSequence.push(newNote);
    nbSelected.add(nbSequence.length - 1);
  });
  nbUpdateUI();
  nbDrawRoll();
}

// ── Play single note preview ──
async function nbPlayNote(midi) {
  await Tone.start();
  const { sampler: s } = await loadMelodySampler(melodyInstrument);
  s.triggerAttackRelease(Tone.Frequency(midi, 'midi').toNote(), '8n', Tone.now() + 0.05);
}

function nbStopSequence(pause = false) {
  // Cancel all pending timeouts from the last play call
  nbTimeouts.forEach(id => clearTimeout(id));
  nbTimeouts = [];
  nbSeqPlaying = false;
  nbSeqPaused = pause;
  playGeneration++; // animatePlayhead will see this and bail
  if (pause) {
    // Keep playhead exactly where it is (animatePlayhead may fire one more frame, so clamp)
    if (nbPlayhead < 0) nbPlayhead = 0;
    nbStartBeat = nbPlayhead;
  } else {
    // Full stop — hide playhead
    nbPlayhead = -1;
    if (typeof nbStartBeat !== 'undefined') nbStartBeat = 0;
  }
  const btn = document.getElementById('nbPlaySeqBtn');
  btn.textContent = pause ? '▶  resume' : '▶  play sequence';
  btn.classList.remove('playing');
  nbDrawRoll();
}

async function nbPlaySequence(startBeat = 0) {
  if (nbSequence.length === 0) return;

  // Cancel any lingering timeouts before starting fresh
  nbTimeouts.forEach(id => clearTimeout(id));
  nbTimeouts = [];

  await Tone.start();
  const { sampler: s } = await loadMelodySampler(melodyInstrument);

  const btn = document.getElementById('nbPlaySeqBtn');
  nbSeqPlaying = true;
  btn.textContent = '■  stop';
  btn.classList.add('playing');

  const secPerBeat = 60 / nbBpm;
  const sorted = [...nbSequence].sort((a, b) => a.beat - b.beat);
  const t0 = performance.now();
  const totalSec   = nbTotalBeats() * secPerBeat;
  const startSec   = startBeat * secPerBeat;
  const gen = ++playGeneration;

  sorted.forEach(p => {
    // Skip notes that finish before the start point
    if (p.beat + (p.dur ?? 1) <= startBeat) return;
    const offsetSec = (p.beat - startBeat) * secPerBeat;
    if (offsetSec < -0.03) return;
    const delay = Math.max(0, offsetSec * 1000);
    nbTimeouts.push(setTimeout(() => {
      if (playGeneration !== gen) return;
      s.triggerAttackRelease(
        Tone.Frequency(p.midi, 'midi').toNote(),
        Math.max(0.05, (p.dur ?? 1) * secPerBeat * 0.95),
        Tone.now() + 0.01
      );
    }, delay));
  });

  // Metronome clicks
  if (nbMetronomeEnabled) {
    const clickSynth = new Tone.MembraneSynth({
      pitchDecay: 0.008, octaves: 2,
      envelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.05 },
    }).toDestination();
    clickSynth.volume.value = -6;
    const totalBeats = nbTotalBeats();
    for (let b = Math.ceil(startBeat); b < totalBeats; b++) {
      const isDownbeat = b % 4 === 0;
      const delay = (b - startBeat) * secPerBeat * 1000;
      nbTimeouts.push(setTimeout(() => {
        if (playGeneration !== gen) return;
        clickSynth.triggerAttackRelease(isDownbeat ? 'C2' : 'C3', '32n', Tone.now() + 0.01);
      }, delay));
    }
    nbTimeouts.push(setTimeout(() => { try { clickSynth.dispose(); } catch(e) {} }, (totalSec - startSec + 0.5) * 1000));
  }

  function animatePlayhead() {
    if (playGeneration !== gen) {
      // Stopped externally — only reset playhead if NOT paused
      if (!nbSeqPaused) {
        nbSeqPlaying = false;
        nbPlayhead = -1;
        nbDrawRoll();
      }
      return;
    }
    const nbScreen = document.getElementById('screen-notebuilder');
    if (!nbScreen || !nbScreen.classList.contains('active')) {
      nbSeqPlaying = false; return;
    }
    const elapsed = (performance.now() - t0) / 1000;
    nbPlayhead = startBeat + elapsed / secPerBeat;
    nbDrawRoll();
    if (elapsed < totalSec - startSec + 0.5) requestAnimationFrame(animatePlayhead);
    else {
      nbSeqPlaying = false;
      nbPlayhead = -1; // return to hidden after full playthrough
      if (typeof nbStartBeat !== 'undefined') nbStartBeat = 0;
      btn.textContent = '▶  play sequence';
      btn.classList.remove('playing');
      nbDrawRoll();
    }
  }
  requestAnimationFrame(animatePlayhead);
}

// ── Keyboard layout constants ──
const NB_KB_LOW  = 2;  // C2
const NB_KB_HIGH = 5;  // B5  (4 octaves: C2–B5)
const WHITE_W    = 36; // white key width in px
const WHITE_GAP  = 2;  // margin-right on each white key
const WHITE_SLOT = WHITE_W + WHITE_GAP; // total horizontal space per white key = 38px
const BLACK_W    = 22; // black key width

// Computer keyboard → MIDI mapping (standard DAW two-row layout)
// Lower row (z/x/c...): C3 octave  |  Home row (a/s/d...): C4 octave  |  Top row (q/w/e...): one octave up whites + sharps
const KB_MAP = {
  // C3 octave — whites on z row, sharps on a row
  'z':48, 's':49, 'x':50, 'd':51, 'c':52,
  'v':53, 'g':54, 'b':55, 'h':56, 'n':57, 'j':58, 'm':59,
  // C4 octave — whites on q row, sharps on number row
  'q':60, '2':61, 'w':62, '3':63, 'e':64,
  'r':65, '5':66, 't':67, '6':68, 'y':69, '7':70, 'u':71,
  // C5 octave — whites continue on i/o/p, sharps on 9/0
  'i':72, '9':73, 'o':74, '0':75, 'p':76,
};

// Build reverse map midi → key label for displaying on keys
const MIDI_TO_KEY = {};
for (const [k, midi] of Object.entries(KB_MAP)) MIDI_TO_KEY[midi] = k.toUpperCase();

function buildKeyboard() {
  const kb = document.getElementById('nbKeyboard');
  kb.innerHTML = '';

  let whiteIdx = 0;

  for (let oct = NB_KB_LOW; oct <= NB_KB_HIGH; oct++) {
    const octStart = whiteIdx;

    // White keys
    NB_WHITES.forEach(k => {
      const midi = (oct + 1) * 12 + k.semi;
      const key = document.createElement('div');
      key.className = 'nb-key white' + (k.semi === 0 ? ' octave-c' : '');
      key.dataset.midi = midi;

      // Two-line label: note name on top, keyboard shortcut below
      const noteName = k.semi === 0 ? `C${oct}` : k.name;
      const kbLabel  = MIDI_TO_KEY[midi] || '';
      key.innerHTML = `<span class="key-note">${noteName}</span>${kbLabel ? `<span class="key-kb">${kbLabel}</span>` : ''}`;

      kb.appendChild(key);
      whiteIdx++;
    });

    // Black keys — positioned absolutely within .nb-keyboard
    // Each black key sits centred between its two flanking white keys.
    // The centre of black key after white index i = i * WHITE_SLOT + WHITE_W - (BLACK_W / 2)
    NB_BLACKS.forEach(k => {
      const midi = (oct + 1) * 12 + k.semi;
      const key = document.createElement('div');
      key.className = 'nb-key black';
      key.dataset.midi = midi;

      const whiteAfterIdx = octStart + k.after; // index of the white key this black sits after
      const leftPx = whiteAfterIdx * WHITE_SLOT + WHITE_W - Math.floor(BLACK_W / 2);
      key.style.left = leftPx + 'px';

      const kbLabel = MIDI_TO_KEY[midi] || '';
      key.innerHTML = `<span class="key-note">${k.name}</span>${kbLabel ? `<span class="key-kb">${kbLabel}</span>` : ''}`;

      kb.appendChild(key);
    });
  }

  kb.style.width = (whiteIdx * WHITE_SLOT) + 'px';
}

// ── Computer keyboard playback ──
const _nbKeysHeld = new Set();
document.addEventListener('keydown', e => {
  if (e.repeat || e.target.tagName === 'INPUT') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // leave shortcuts to app.js
  const midi = KB_MAP[e.key.toLowerCase()];
  if (!midi || _nbKeysHeld.has(midi)) return;
  // Only fire when note builder screen is active
  const nbScreen = document.getElementById('screen-notebuilder');
  if (!nbScreen || !nbScreen.classList.contains('active')) return;
  _nbKeysHeld.add(midi);
  nbPushUndo();
  nbAddNoteByMidi(midi);
  nbPlayNote(midi);
  // Light up the key
  const keyEl = document.querySelector(`#nbKeyboard [data-midi="${midi}"]`);
  if (keyEl) keyEl.classList.add('lit');
});
document.addEventListener('keyup', e => {
  const midi = KB_MAP[e.key.toLowerCase()];
  if (!midi) return;
  _nbKeysHeld.delete(midi);
  const keyEl = document.querySelector(`#nbKeyboard [data-midi="${midi}"]`);
  if (keyEl) keyEl.classList.remove('lit');
});

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
  if (!key || !key.dataset.midi) return;
  const midi = +key.dataset.midi;
  nbPushUndo();
  nbAddNoteByMidi(midi);
  nbPlayNote(midi);
});

document.getElementById('nbPlaySeqBtn').addEventListener('click', () => {
  if (nbSeqPlaying) { nbStopSequence(true); return; } // pause
  nbSeqPaused = false;
  // Start from the parked playhead position (set by scrubbing or pause), or beat 0
  const start = (typeof nbStartBeat !== 'undefined' && nbStartBeat >= 0) ? nbStartBeat : 0;
  nbPlaySequence(start);
});

document.getElementById('nbClearBtn').addEventListener('click', () => {
  nbPushUndo();
  nbStopSequence(); // cancels all pending timeouts first
  nbSequence = [];
  nbUpdateUI();
  nbDrawRoll();
});

document.getElementById('nbOctDown')?.addEventListener('click', () => {
  if (nbOctave > 2) { nbOctave--; updateOctaveLabel(); }
});
document.getElementById('nbOctUp')?.addEventListener('click', () => {
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
    nbPushUndo();
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
  nbStopSequence(); // stop any active playback before leaving
  showScreen('idle');
});

document.getElementById('nbJumpEndBtn').addEventListener('click', () => {
  nbPlayhead = nbSequence.length > 0 ? Math.max(...nbSequence.map(n => n.beat + (n.dur ?? 1))) : nbTotalBeats();
  nbStartBeat = nbPlayhead;
  nbDrawRoll();
});
