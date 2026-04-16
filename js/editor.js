/* ───────────────────────────────────────────────
   EDITOR & EXPORT
   Depends on: constants.js, audio.js, playback.js, Tone.js
─────────────────────────────────────────────── */

let edBars = [];
let edPitches = [];
let edBpm = 100;
let edScaleResult = null;
let edRecorder = null;
let edCanvas, edCtx;
let edCurrentSavedIdx = -1; // index in savedList (-1 = unsaved new session)

// Grid configuration
let ED_ROW_H     = 24;
let ED_BEAT_W    = 54;
const ED_CHORD_ROW_H      = 130; // taller to accommodate 12 root positions
const ED_CHORD_BLOCK_H    = 36;  // fixed height of each chord block
const ED_CHORD_PAD        = 6;   // padding inside zone (top & bottom)
const ED_RESIZE_HANDLE    = 8;
const ED_CHORD_SEMITONE_H = 10;

let edRows = [];
let edDragging = null;

// Chord selection & clipboard
let edChordSelected  = new Set();
let edChordClipboard = [];

// Melody box selection
let edBoxSel   = null;
let edSelected = new Set();

// Undo / redo
let edUndoStack = [];
let edRedoStack = [];

// Playhead
let edPlayhead  = -1;
let edSeqPaused = false;
let edPlayMode  = 'chords'; // 'chords' | 'raw' | 'raw+notes'

// Raw audio player — kept at module scope so pause/resume can access it
let edRawPlayer     = null;
let edRawStartedAt  = 0;   // AudioContext time when raw player started
let edRawPausedAt   = 0;   // seconds into the clip when paused

// ── Undo / Redo ──
function edPushUndo() {
  edUndoStack.push({
    pitches: edPitches.map(p => ({ ...p })),
    bars:    edBars.map(b => ({ ...b })),
  });
  if (edUndoStack.length > 30) edUndoStack.shift();
  edRedoStack = [];
}

function edUndo() {
  if (!edUndoStack.length) return;
  edRedoStack.push({ pitches: edPitches.map(p => ({...p})), bars: edBars.map(b => ({...b})) });
  const snap = edUndoStack.pop();
  edPitches = snap.pitches; edBars = snap.bars;
  edSelected.clear(); edChordSelected.clear();
  edRebuildRows(); edDrawRoll();
}

function edRedo() {
  if (!edRedoStack.length) return;
  edUndoStack.push({ pitches: edPitches.map(p => ({...p})), bars: edBars.map(b => ({...b})) });
  const snap = edRedoStack.pop();
  edPitches = snap.pitches; edBars = snap.bars;
  edSelected.clear(); edChordSelected.clear();
  edRebuildRows(); edDrawRoll();
}

// ── Row helpers ──
function edRebuildRows() {
  if (edPitches.length === 0) {
    edRows = [];
    for (let m = 72; m >= 48; m--) edRows.push(m);
    return;
  }
  let min = Math.min(...edPitches.map(p => p.midi));
  let max = Math.max(...edPitches.map(p => p.midi));
  edRows = [];
  for (let m = max + 3; m >= min - 3; m--) edRows.push(m);
}

function edGetTotalBeats() {
  const maxChordBeat = edBars.length > 0
    ? Math.max(...edBars.map(b => (b.beatOffset || 0) + (b.dur || 4))) : 0;
  const maxMelBeat = edPitches.length > 0
    ? Math.max(...edPitches.map(p => (p.beat || 0) + (p.dur || 1))) : 0;
  return Math.ceil(Math.max(16, maxChordBeat + 4, maxMelBeat + 4) / 4) * 4;
}

function edSnapBeat(b) { return Math.max(0, Math.round(b * 4) / 4); }
function edSnap8th(b)  { return Math.max(0, Math.round(b * 2) / 2); }

// Returns the canvas y for the top of a chord block given its root (0–11).
// Root 11 (B) sits near the top, root 0 (C) near the bottom — matching piano convention.
function edChordBlockY(root) {
  const usable = ED_CHORD_ROW_H - ED_CHORD_PAD * 2 - ED_CHORD_BLOCK_H;
  // root 11 → y = melH + ED_CHORD_PAD, root 0 → y = melH + ED_CHORD_PAD + usable
  return edChordY() + ED_CHORD_PAD + (1 - root / 11) * usable;
}

function edUpdateUI() {
  const lbl = document.getElementById('edBpmLabel');
  if (lbl) lbl.textContent = edBpm;
  edBuildChordPalette();
}

// ── Chord palette ──
function edBuildChordPalette() {
  const container = document.getElementById('edChordPalette');
  if (!container) return;
  container.innerHTML = '';

  if (!edScaleResult?.scale) {
    container.innerHTML = '<span style="color:var(--text3);font-size:11px;font-family:\'Space Mono\',monospace">no scale loaded</span>';
    return;
  }

  const { root, scale } = edScaleResult;
  const flavours = SCALE_CHORD_FLAVOURS[scale.key] || {};
  const scalePcs = scale.profile.map((v, pc) => v === 1 ? pc : -1).filter(v => v !== -1);

  scalePcs.forEach(degree => {
    const chordRoot = (root + degree) % 12;
    const quality   = flavours[degree] || 'maj';
    const intervals = CHORD_TYPES[quality] || [0, 4, 7];
    const name = pcToName(chordRoot) + (CHORD_SUFFIXES[quality] ?? '');

    const btn = document.createElement('button');
    btn.className = 'ed-chord-palette-btn';
    btn.textContent = name;
    btn.title = `Add ${name}`;
    btn.addEventListener('click', () => {
      edPushUndo();
      const lastBeat = edBars.length > 0
        ? Math.max(...edBars.map(b => (b.beatOffset || 0) + (b.dur || 4))) : 0;
      edBars.push({ root: chordRoot, quality, intervals: intervals.map(iv => chordRoot + iv), beatOffset: lastBeat, dur: 4 });
      edDrawRoll();
    });
    container.appendChild(btn);
  });
}

// ── Initialise state ──
function initEdState(bars, pitches, bpm, scaleResult) {
  edBars = bars.map((b, i) => ({
    ...b,
    beatOffset: b.beatOffset != null ? b.beatOffset : i * 4,
    dur:        b.dur        != null ? b.dur        : 4,
  }));

  if (pitchSource !== 'builder') {
    if (pitches.length > 0) {
      const alreadyInBeats = pitches[0].beat != null;
      if (alreadyInBeats) {
        edPitches = pitches.map(p => ({ ...p }));
      } else {
        const t0ms = pitches[0].time;
        const secPerBeat = 60 / bpm;
        edPitches = pitches.map(p => ({
          ...p,
          beat: edSnap8th((p.time - t0ms) / 1000 / secPerBeat),
          dur:  p.dur ?? 1,
        }));
      }
    } else {
      edPitches = [];
    }
  } else {
    edPitches = pitches.map(p => ({ ...p }));
  }

  edBpm = bpm || 100;
  edScaleResult = scaleResult;
  edUndoStack = []; edRedoStack = [];
  edSelected.clear(); edChordSelected.clear();
  edRebuildRows();
  edUpdateUI();
  requestAnimationFrame(edDrawRoll);
}

function openEditor(bars, pitches, bpm, scaleResult) {
  edCurrentSavedIdx = -1; // reset — overridden by savedLoadMelody when loading a save
  edPlayMode = 'chords';  // reset play mode each time editor opens
  stopEdPlayback();
  initEdState(bars, pitches, bpm, scaleResult);
  showScreen('editor');
  if (!edCanvas) initEdCanvas();
  else { edDrawRoll(); edBuildChordPalette(); }
  edUpdatePlayModeBtn();
}

function initEdCanvas() {
  edCanvas = document.getElementById('edRollCanvas');
  edCtx    = edCanvas.getContext('2d');
  edCanvas.addEventListener('mousedown',   edOnMouseDown);
  edCanvas.addEventListener('mousemove',   edOnMouseMove);
  edCanvas.addEventListener('mouseup',     edOnMouseUp);
  edCanvas.addEventListener('mouseleave',  edOnMouseUp);
  edCanvas.addEventListener('contextmenu', edOnContextMenu);
  edCanvas.addEventListener('touchstart',  e => { e.preventDefault(); edOnMouseDown(e.touches[0]); }, { passive: false });
  edCanvas.addEventListener('touchmove',   e => { e.preventDefault(); edOnMouseMove(e.touches[0]); }, { passive: false });
  edCanvas.addEventListener('touchend',    e => { e.preventDefault(); edOnMouseUp(e.changedTouches[0]); }, { passive: false });

  document.addEventListener('keydown', edOnKey);

  (function drawLoop() {
    if (Tone.Transport.state === 'started') edDrawRoll();
    requestAnimationFrame(drawLoop);
  })();

  edDrawRoll();
}

// ── Canvas coordinates ──
function edCanvasXY(e) {
  const rect = edCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// ── Zone geometry ──
function edMelodyHeight() { return edRows.length * ED_ROW_H; }
function edChordY()        { return edMelodyHeight(); }

// ── Hit testing ──
function edHitPlayhead(x) {
  if (edPlayhead < 0) return false;
  return Math.abs(x - edPlayhead * ED_BEAT_W) <= 10;
}

function edHitMelody(cx, cy) {
  if (cy >= edMelodyHeight()) return null;
  const r = Math.floor(cy / ED_ROW_H);
  const midi = edRows[r];
  if (midi === undefined) return null;
  for (let i = edPitches.length - 1; i >= 0; i--) {
    const p  = edPitches[i];
    if (p.midi !== midi) continue;
    const nx = p.beat * ED_BEAT_W + 2;
    const nw = Math.max(ED_BEAT_W * 0.3, p.dur * ED_BEAT_W - 4);
    if (cx >= nx && cx <= nx + nw) {
      return { idx: i, mode: cx >= nx + nw - ED_RESIZE_HANDLE ? 'resize' : 'move' };
    }
  }
  return null;
}

function edHitChord(cx, cy) {
  const cY = edChordY();
  if (cy < cY || cy > cY + ED_CHORD_ROW_H) return null;
  for (let i = edBars.length - 1; i >= 0; i--) {
    const b  = edBars[i];
    const nx = b.beatOffset * ED_BEAT_W + 2;
    const nw = Math.max(ED_BEAT_W * 0.5, (b.dur || 4) * ED_BEAT_W - 4);
    const by = edChordBlockY(b.root);
    if (cx >= nx && cx <= nx + nw && cy >= by && cy <= by + ED_CHORD_BLOCK_H) {
      const rightEdge = cx >= nx + nw - ED_RESIZE_HANDLE;
      const pitchZone = (cy - by) < ED_CHORD_SEMITONE_H;
      const mode = rightEdge ? 'resize' : pitchZone ? 'pitch' : 'move';
      return { idx: i, mode };
    }
  }
  return null;
}

// ── Context menu ──
function edOnContextMenu(e) {
  e.preventDefault();
  const { x, y } = edCanvasXY(e);
  const ch = edHitChord(x, y);
  if (!ch) return;
  if (!edChordSelected.has(ch.idx)) {
    edChordSelected.clear();
    edChordSelected.add(ch.idx);
    edDrawRoll();
  }
  edShowChordMenu(e.clientX, e.clientY);
}

function edShowChordMenu(screenX, screenY) {
  document.querySelector('.ed-ctx-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'ed-ctx-menu';
  menu.style.cssText = `position:fixed;left:${screenX}px;top:${screenY}px;z-index:9999`;

  const items = [
    { label: '⎘  copy chord(s)',    action: edCopyChords },
    { label: '⎘  paste chord(s)',   action: edPasteChords, disabled: edChordClipboard.length === 0 },
    { label: '⧉  duplicate',        action: () => edDuplicateChords() },
    { label: '✕  delete',           action: edDeleteSelectedChords, cls: 'danger' },
  ];
  items.forEach(item => {
    const el = document.createElement('button');
    el.className = 'ed-ctx-item' + (item.cls ? ' ' + item.cls : '');
    el.textContent = item.label;
    el.disabled = !!item.disabled;
    el.addEventListener('mousedown', e => { e.stopPropagation(); });
    el.addEventListener('click', () => { menu.remove(); item.action(); });
    menu.appendChild(el);
  });
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

// ── Chord clipboard ops ──
function edCopyChords() {
  if (edChordSelected.size === 0) return;
  edChordClipboard = [...edChordSelected].sort((a,b)=>a-b).map(i => ({ ...edBars[i] }));
  const btn = document.getElementById('edCopyChordBtn');
  if (btn) { btn.textContent = '✓ copied'; setTimeout(() => btn.textContent = '⎘ copy', 1200); }
}

function edPasteChords() {
  if (edChordClipboard.length === 0) return;
  edPushUndo();
  const lastBeat = edBars.length > 0
    ? Math.max(...edBars.map(b => (b.beatOffset || 0) + (b.dur || 4))) : 0;
  const minOrig = Math.min(...edChordClipboard.map(b => b.beatOffset || 0));
  const insertAt = edBars.length;
  edChordClipboard.forEach(b => {
    edBars.push({ ...b, beatOffset: (b.beatOffset || 0) - minOrig + lastBeat });
  });
  edChordSelected = new Set(edChordClipboard.map((_, k) => insertAt + k));
  edDrawRoll();
}

function edDuplicateChords() {
  if (edChordSelected.size === 0) return;
  edPushUndo();
  const sel = [...edChordSelected].sort((a,b)=>a-b);
  const lastBeat = edBars.length > 0
    ? Math.max(...edBars.map(b => (b.beatOffset || 0) + (b.dur || 4))) : 0;
  const minOrig = Math.min(...sel.map(i => edBars[i].beatOffset || 0));
  const insertAt = edBars.length;
  sel.forEach(i => {
    const b = edBars[i];
    edBars.push({ ...b, beatOffset: (b.beatOffset || 0) - minOrig + lastBeat });
  });
  edChordSelected = new Set(sel.map((_, k) => insertAt + k));
  edDrawRoll();
}

function edDeleteSelectedChords() {
  if (edChordSelected.size === 0) return;
  edPushUndo();
  edBars = edBars.filter((_, i) => !edChordSelected.has(i));
  edChordSelected.clear();
  edDrawRoll();
}

// ── Mouse handlers ──
function edOnMouseDown(e) {
  const { x, y } = edCanvasXY(e);
  document.querySelector('.ed-ctx-menu')?.remove();

  // 1 — playhead scrub
  if (edHitPlayhead(x) && y < edMelodyHeight()) {
    edDragging = { type: 'playhead' };
    edCanvas.style.cursor = 'col-resize';
    return;
  }

  // 2 — chord zone
  const chordHit = edHitChord(x, y);
  if (chordHit) {
    if (!e.shiftKey && !edChordSelected.has(chordHit.idx)) edChordSelected.clear();
    edChordSelected.add(chordHit.idx);
    edSelected.clear();
    edPushUndo();
    const b = edBars[chordHit.idx];
    if (chordHit.mode === 'move') {
      if (edChordSelected.size > 1) {
        edDragging = {
          type: 'chordSelection', startX: x,
          origBeats: [...edChordSelected].map(i => ({ i, beat: edBars[i].beatOffset || 0 })),
        };
      } else {
        edDragging = { type: 'chord', idx: chordHit.idx, mode: 'move', startX: x, origBeat: b.beatOffset };
      }
    } else if (chordHit.mode === 'resize') {
      edDragging = { type: 'chord', idx: chordHit.idx, mode: 'resize', startX: x, origDur: b.dur || 4 };
    } else {
      edDragging = { type: 'chord', idx: chordHit.idx, mode: 'pitch', startY: y, origRoot: b.root };
    }
    edCanvas.style.cursor = chordHit.mode === 'resize' ? 'ew-resize'
                          : chordHit.mode === 'pitch'  ? 'ns-resize' : 'grabbing';
    edDrawRoll();
    return;
  }

  // Clicked empty chord area — deselect
  if (y >= edMelodyHeight()) {
    edChordSelected.clear();
    edDrawRoll();
    return;
  }

  // 3 — melody note
  const melHit = edHitMelody(x, y);
  if (melHit) {
    edChordSelected.clear();
    edPushUndo();
    if (edSelected.has(melHit.idx) && melHit.mode === 'move' && edSelected.size > 1) {
      edDragging = {
        type: 'melodySelection', startX: x, startY: y,
        origBeats: [...edSelected].map(i => ({ i, beat: edPitches[i].beat })),
        origMidis: [...edSelected].map(i => ({ i, midi: edPitches[i].midi })),
      };
    } else {
      if (!e.shiftKey) edSelected.clear();
      edSelected.add(melHit.idx);
      const p = edPitches[melHit.idx];
      edDragging = { type: 'melody', noteIdx: melHit.idx, mode: melHit.mode,
        startX: x, startY: y, origBeat: p.beat, origDur: p.dur ?? 1, origMidi: p.midi };
    }
    edCanvas.style.cursor = melHit.mode === 'resize' ? 'ew-resize' : 'grabbing';
    edDrawRoll();
    return;
  }

  // 4 — empty melody space → box select
  edChordSelected.clear();
  if (!e.shiftKey) edSelected.clear();
  edBoxSel = { startX: x, startY: y, endX: x, endY: y };
  edDrawRoll();
}

function edOnMouseMove(e) {
  const { x, y } = edCanvasXY(e);

  if (edDragging?.type === 'playhead') {
    edPlayhead = Math.max(0, Math.min(edGetTotalBeats(), x / ED_BEAT_W));
    edDrawRoll();
    return;
  }

  if (edBoxSel) {
    edBoxSel.endX = x; edBoxSel.endY = y;
    const bx1 = Math.min(edBoxSel.startX, x), bx2 = Math.max(edBoxSel.startX, x);
    const by1 = Math.min(edBoxSel.startY, y), by2 = Math.max(edBoxSel.startY, y);
    edPitches.forEach((p, i) => {
      const nx = p.beat * ED_BEAT_W + 2;
      const nw = Math.max(ED_BEAT_W * 0.3, p.dur * ED_BEAT_W - 4);
      const r  = edRows.indexOf(p.midi);
      if (r < 0) return;
      const ny = r * ED_ROW_H + 2, nh = ED_ROW_H - 4;
      const overlaps = nx < bx2 && nx + nw > bx1 && ny < by2 && ny + nh > by1;
      if (overlaps) edSelected.add(i); else if (!e.shiftKey) edSelected.delete(i);
    });
    edDrawRoll();
    return;
  }

  if (edDragging) {
    const dx = x - (edDragging.startX ?? x);
    const dy = y - (edDragging.startY ?? y);

    if (edDragging.type === 'chordSelection') {
      const beatDelta = edSnap8th(dx / ED_BEAT_W);
      edDragging.origBeats.forEach(({ i, beat }) => {
        edBars[i].beatOffset = Math.max(0, beat + beatDelta);
      });
    } else if (edDragging.type === 'chord') {
      const b = edBars[edDragging.idx];
      if (edDragging.mode === 'move') {
        b.beatOffset = Math.max(0, edSnap8th(edDragging.origBeat + dx / ED_BEAT_W));
      } else if (edDragging.mode === 'resize') {
        b.dur = Math.max(1, edSnap8th(edDragging.origDur + dx / ED_BEAT_W));
      } else {
        const semitonesDelta = -Math.round(dy / ED_CHORD_SEMITONE_H);
        b.root = ((edDragging.origRoot + semitonesDelta) % 12 + 12) % 12;
        if (b.quality && CHORD_TYPES[b.quality]) {
          b.intervals = CHORD_TYPES[b.quality].map(iv => b.root + iv);
        }
      }
    } else if (edDragging.type === 'melodySelection') {
      const beatDelta  = edSnapBeat(dx / ED_BEAT_W);
      const pitchDelta = -Math.round(dy / ED_ROW_H);
      edDragging.origBeats.forEach(({ i, beat }) => { edPitches[i].beat = Math.max(0, beat + beatDelta); });
      edDragging.origMidis.forEach(({ i, midi }) => {
        const nm = Math.max(21, Math.min(108, midi + pitchDelta));
        edPitches[i].midi = nm; edPitches[i].pc = nm % 12;
      });
      edRebuildRows();
    } else if (edDragging.type === 'melody') {
      const p = edPitches[edDragging.noteIdx];
      if (edDragging.mode === 'move') {
        p.beat = Math.max(0, edSnapBeat(edDragging.origBeat + dx / ED_BEAT_W));
        const pitchDelta = -Math.round(dy / ED_ROW_H);
        const nm = Math.max(21, Math.min(108, edDragging.origMidi + pitchDelta));
        p.midi = nm; p.pc = nm % 12;
        edRebuildRows();
      } else {
        p.dur = Math.max(0.25, edSnapBeat(edDragging.origDur + dx / ED_BEAT_W));
      }
    }
    edDrawRoll();
    return;
  }

  // Cursor hints
  if (edHitPlayhead(x) && y < edMelodyHeight()) { edCanvas.style.cursor = 'col-resize'; return; }
  const ch = edHitChord(x, y);
  if (ch) {
    edCanvas.style.cursor = ch.mode === 'resize' ? 'ew-resize'
                          : ch.mode === 'pitch'  ? 'ns-resize' : 'grab';
    return;
  }
  const mh = edHitMelody(x, y);
  edCanvas.style.cursor = mh ? (mh.mode === 'resize' ? 'ew-resize' : 'grab') : 'crosshair';
}

function edOnMouseUp() {
  if (edDragging?.type === 'playhead') {
    edDragging = null;
    edCanvas.style.cursor = 'default';
    return;
  }
  if (edBoxSel) { edBoxSel = null; edDrawRoll(); return; }
  if (!edDragging) return;
  edDragging = null;
  edCanvas.style.cursor = 'crosshair';
  edDrawRoll();
}

// ── Keyboard shortcuts ──
function edOnKey(e) {
  const screen = document.getElementById('screen-editor');
  if (!screen || screen.classList.contains('hidden')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); edUndo(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); edRedo(); return; }

  if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
    e.preventDefault();
    if (edChordSelected.size > 0) edCopyChords();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
    e.preventDefault();
    if (edChordClipboard.length > 0) edPasteChords();
    return;
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (edChordSelected.size > 0) {
      edDeleteSelectedChords();
    } else if (edSelected.size > 0) {
      edPushUndo();
      edPitches = edPitches.filter((_, i) => !edSelected.has(i));
      edSelected.clear();
      edRebuildRows();
      edDrawRoll();
    }
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    e.preventDefault();
    edPitches.forEach((_, i) => edSelected.add(i));
    edDrawRoll();
  }
}

// ── Drawing ──
function edDrawRoll() {
  if (!edCanvas) return;
  const beats = edGetTotalBeats();
  const melH  = edRows.length * ED_ROW_H;
  const W     = Math.max(beats * ED_BEAT_W, 400);
  const H     = melH + ED_CHORD_ROW_H;

  edCanvas.width  = W;
  edCanvas.height = H;

  const ctx = edCtx;
  ctx.clearRect(0, 0, W, H);

  // 1. Melody grid
  edRows.forEach((midi, r) => {
    const isBlack = [1,3,6,8,10].includes(midi % 12);
    const isC     = midi % 12 === 0;
    ctx.fillStyle = isBlack ? '#0d1726' : (isC ? '#14213a' : '#111827');
    ctx.fillRect(0, r * ED_ROW_H, W, ED_ROW_H);
  });

  // 2. Chord zone background + root grid lines
  ctx.fillStyle = '#161e30';
  ctx.fillRect(0, melH, W, ED_CHORD_ROW_H);

  // Draw 12 horizontal root-position lanes with note names on left
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const isBlackKey = [false,true,false,true,false,false,true,false,true,false,true,false];
  for (let root = 0; root <= 11; root++) {
    const ly = edChordBlockY(root) + ED_CHORD_BLOCK_H / 2;
    // Subtle horizontal guide line
    ctx.strokeStyle = isBlackKey[root] ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.09)';
    ctx.lineWidth = isBlackKey[root] ? 0.5 : 1;
    ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(W, ly); ctx.stroke();
  }

  // 3. Grid lines
  for (let b = 0; b <= beats; b++) {
    const bx = b * ED_BEAT_W;
    const isBar = b % 4 === 0;
    ctx.strokeStyle = isBar ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
    ctx.lineWidth   = isBar ? 1.5 : 1;
    ctx.beginPath(); ctx.moveTo(bx, 0); ctx.lineTo(bx, H); ctx.stroke();
  }
  for (let s = 0; s <= beats * 4; s++) {
    if (s % 4 === 0) continue;
    const bx = s * ED_BEAT_W * 0.25;
    ctx.strokeStyle = 'rgba(255,255,255,0.025)';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(bx, 0); ctx.lineTo(bx, melH); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, melH); ctx.lineTo(W, melH); ctx.stroke();

  // 4. Chord blocks — vertically positioned by root note (C=bottom, B=top)
  edBars.forEach((b, i) => {
    const isDragged  = (edDragging?.type === 'chord' && edDragging.idx === i)
                    || (edDragging?.type === 'chordSelection' && edChordSelected.has(i));
    const isSelected = edChordSelected.has(i);
    const bx = b.beatOffset * ED_BEAT_W + 2;
    const by = edChordBlockY(b.root);
    const bw = Math.max(ED_BEAT_W * 0.5, (b.dur || 4) * ED_BEAT_W - 4);
    const bh = ED_CHORD_BLOCK_H;

    ctx.globalAlpha = isDragged ? 1.0 : 0.88;
    ctx.fillStyle   = isDragged ? '#a78bfa' : isSelected ? '#9061f9' : '#7c3aed';
    ctx.shadowColor = '#a78bfa';
    ctx.shadowBlur  = isDragged ? 14 : isSelected ? 10 : 4;
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 4); ctx.fill();
    ctx.shadowBlur  = 0;
    ctx.globalAlpha = 1;

    if (isSelected) {
      ctx.strokeStyle = '#c4b5fd';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(bx - 1, by - 1, bw + 2, bh + 2, 5); ctx.stroke();
    }

    // Pitch drag stripe (top of block)
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath(); ctx.roundRect(bx, by, bw, ED_CHORD_SEMITONE_H, [4,4,0,0]); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('▲▼', bx + bw / 2, by + ED_CHORD_SEMITONE_H / 2);

    // Chord name
    const name = pcToName(b.root) + (CHORD_SUFFIXES[b.quality] ?? '');
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px "Space Mono", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(name, bx + bw / 2, by + ED_CHORD_SEMITONE_H + (bh - ED_CHORD_SEMITONE_H) / 2);

    // Resize handle
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.roundRect(bx + bw - ED_RESIZE_HANDLE, by, ED_RESIZE_HANDLE, bh, [0,4,4,0]); ctx.fill();
  });

  // 5. Melody notes
  edPitches.forEach((p, i) => {
    const r = edRows.indexOf(p.midi);
    if (r < 0) return;
    const isDragged  = edDragging?.type === 'melody' && edDragging.noteIdx === i;
    const isSelected = edSelected.has(i);
    const nx = p.beat * ED_BEAT_W + 2;
    const ny = r * ED_ROW_H + 2;
    const nw = Math.max(ED_BEAT_W * 0.3, p.dur * ED_BEAT_W - 4);
    const nh = ED_ROW_H - 4;

    ctx.shadowColor = isSelected ? '#a78bfa' : '#00d4ff';
    ctx.shadowBlur  = isDragged ? 14 : isSelected ? 10 : 4;
    ctx.fillStyle   = isDragged ? '#40e0ff' : isSelected ? '#c4b5fd' : '#00d4ff';
    ctx.beginPath(); ctx.roundRect(nx, ny, nw, nh, 3); ctx.fill();
    ctx.shadowBlur  = 0;

    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.roundRect(nx + nw - ED_RESIZE_HANDLE, ny, ED_RESIZE_HANDLE, nh, [0,3,3,0]); ctx.fill();

    if (nw > 20) {
      ctx.fillStyle = '#040a12';
      ctx.font = 'bold 9px "Space Mono", monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(pcToName(p.pc ?? p.midi % 12), nx + (nw - ED_RESIZE_HANDLE) / 2, ny + nh / 2);
    }
  });

  // 6. Box selection
  if (edBoxSel) {
    const bx = Math.min(edBoxSel.startX, edBoxSel.endX);
    const by = Math.min(edBoxSel.startY, edBoxSel.endY);
    const bw = Math.abs(edBoxSel.endX - edBoxSel.startX);
    const bh = Math.abs(edBoxSel.endY - edBoxSel.startY);
    ctx.strokeStyle = 'rgba(167,139,250,0.9)';
    ctx.fillStyle   = 'rgba(167,139,250,0.07)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 2);
    ctx.fill(); ctx.stroke();
    ctx.setLineDash([]);
  }

  // 7. Playhead
  const transportBeat = Tone.Transport.state === 'started'
    ? Tone.Transport.ticks / Tone.Transport.PPQ : -1;
  const headBeat = transportBeat >= 0 ? transportBeat : edPlayhead;
  if (headBeat >= 0) {
    const hx = headBeat * ED_BEAT_W;
    ctx.strokeStyle = '#ff4757'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, H); ctx.stroke();
    ctx.fillStyle = '#ff4757';
    ctx.beginPath();
    ctx.moveTo(hx - 7, 0); ctx.lineTo(hx + 7, 0); ctx.lineTo(hx, 10);
    ctx.closePath(); ctx.fill();
  }

  // 8. Pitch labels sidebar
  const sidebar = document.getElementById('edPitchLabels');
  if (sidebar) {
    sidebar.innerHTML = '';
    edRows.forEach(midi => {
      const lbl = document.createElement('div');
      lbl.className = 'nb-pitch-label';
      lbl.style.height = ED_ROW_H + 'px';
      lbl.textContent  = pcToName(midi % 12) + (Math.floor(midi / 12) - 1);
      sidebar.appendChild(lbl);
    });
    // Chord zone sidebar: show root note labels at their lane positions
    const cZone = document.createElement('div');
    cZone.style.cssText = `position:relative;height:${ED_CHORD_ROW_H}px;border-top:1px solid rgba(255,255,255,0.1);flex-shrink:0;`;
    const NOTE_NAMES_SB = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const isBlackKeySB  = [false,true,false,true,false,false,true,false,true,false,true,false];
    for (let root = 11; root >= 0; root--) {
      const usable = ED_CHORD_ROW_H - ED_CHORD_PAD * 2 - ED_CHORD_BLOCK_H;
      const topOffset = ED_CHORD_PAD + (1 - root / 11) * usable + ED_CHORD_BLOCK_H / 2;
      const lbl = document.createElement('div');
      lbl.className = 'nb-pitch-label';
      lbl.style.cssText = `position:absolute;top:${topOffset}px;transform:translateY(-50%);height:auto;font-size:9px;opacity:${isBlackKeySB[root] ? 0.45 : 0.75};`;
      lbl.textContent = NOTE_NAMES_SB[root];
      cZone.appendChild(lbl);
    }
    sidebar.appendChild(cZone);
  }
}

// ── Refine melody ──
function edRefineMelody() {
  if (!edScaleResult?.scale) return;
  edPushUndo();
  const scalePcs = edScaleResult.scale.profile
    .map((v, pc) => v === 1 ? (edScaleResult.root + pc) % 12 : -1)
    .filter(v => v !== -1);
  edPitches.forEach(p => {
    p.beat = edSnap8th(p.beat);
    p.dur  = Math.max(0.5, edSnap8th(p.dur));
    if (!scalePcs.includes(p.midi % 12)) {
      let best = p.midi, minD = Infinity;
      for (const spc of scalePcs) {
        for (let oct = -1; oct <= 1; oct++) {
          const cand = spc + (Math.floor(p.midi / 12) + oct) * 12;
          const d = Math.abs(cand - p.midi);
          if (d < minD) { minD = d; best = cand; }
        }
      }
      p.midi = best; p.pc = best % 12;
    }
  });
  edRebuildRows();
  edDrawRoll();
}

function edUpdatePlayModeBtn() {
  const btn = document.getElementById('edPlayBtn');
  if (!btn) return;
  const labels = { chords: '▶ play', raw: '🎤 play', 'raw+notes': '🎤+♪ play' };
  if (Tone.Transport.state !== 'started') {
    btn.textContent = labels[edPlayMode] || '▶ play';
  }
  // Show/hide raw options based on whether a recording is available
  const hasBlob = typeof rawAudioBlob !== 'undefined' && rawAudioBlob != null;
  document.querySelectorAll('#edPlayMenu [data-mode="raw"], #edPlayMenu [data-mode="raw+notes"]').forEach(el => {
    el.style.display = hasBlob ? '' : 'none';
  });
  const noAudioNote = document.getElementById('edPlayMenuNoAudio');
  if (noAudioNote) noAudioNote.style.display = hasBlob ? 'none' : '';
  // If current mode needs blob but none exists, reset to chords
  if (!hasBlob && (edPlayMode === 'raw' || edPlayMode === 'raw+notes')) {
    edPlayMode = 'chords';
    if (Tone.Transport.state !== 'started') btn.textContent = '▶ play';
  }
}

// ── PLAYBACK ──
async function edTogglePlay(isExport = false, mode = null) {
  if (mode !== null && mode !== edPlayMode) {
    stopEdPlayback();
    edPlayMode = mode;
    edUpdatePlayModeBtn();
  }

  const btn = document.getElementById('edPlayBtn');

  if (!isExport) {
    if (Tone.Transport.state === 'started') {
      // Pause raw player and record position
      if (edRawPlayer) {
        try {
          const elapsed = Tone.getContext().currentTime - edRawStartedAt;
          edRawPausedAt = Math.max(0, elapsed);
          edRawPlayer.stop();
        } catch(e) {}
      }
      Tone.Transport.pause();
      edSeqPaused = true;
      if (btn) { btn.textContent = '▶ resume'; btn.classList.remove('playing'); }
      return null;
    } else if (Tone.Transport.state === 'paused') {
      // Resume raw player from where it was paused
      if (edRawPlayer) {
        try {
          edRawStartedAt = Tone.getContext().currentTime - edRawPausedAt;
          edRawPlayer.start(Tone.now(), edRawPausedAt);
        } catch(e) {}
      }
      Tone.Transport.start();
      edSeqPaused = false;
      if (btn) { btn.textContent = '❚❚ pause'; btn.classList.add('playing'); }
      return null;
    }
  }

  stopEdPlayback();
  await Tone.start();

  const playRaw    = edPlayMode === 'raw' || edPlayMode === 'raw+notes';
  const playMelody = edPlayMode === 'chords' || edPlayMode === 'raw+notes';
  const hasBlob    = typeof rawAudioBlob !== 'undefined' && rawAudioBlob != null;

  if (isExport) {
    if (!edRecorder) edRecorder = new Tone.Recorder();
  } else {
    if (btn) { btn.textContent = '❚❚ pause'; btn.classList.add('playing'); }
  }

  edRawPlayer = null; edRawStartedAt = 0; edRawPausedAt = 0;
  let chordHandle, melodyHandle;
  try {
    chordHandle  = await loadSampler(chordInstrument);
    melodyHandle = await loadMelodySampler(melodyInstrument);
    if (playRaw && hasBlob) {
      await new Promise(resolve => {
        edRawPlayer = new Tone.Player({
          url: URL.createObjectURL(rawAudioBlob),
          onload: resolve,
          onerror: () => { edRawPlayer = null; resolve(); },
        });
      });
    }
  } catch(e) { stopEdPlayback(); return null; }

  const chordGain = chordHandle.gain;
  const melGain   = melodyHandle.gain;

  const reverbCfg = edScaleResult?.scale?.reverb || { decay: 1.2, wet: 0.18 };
  const targetWet = reverbCfg.wet * (globalReverbAmount / 0.18);
  const reverb  = new Tone.Reverb({ decay: reverbCfg.decay, wet: Math.min(1.0, targetWet), preDelay: 0.02 });
  const chordEQ = new Tone.EQ3({ low: 2, mid: -1, high: -4 });
  const melEQ   = new Tone.EQ3({ low: -2, mid: 1, high: -2 });

  await reverb.generate();

  chordGain.disconnect(); melGain.disconnect();
  chordGain.gain.value = 0.45; melGain.gain.value = 1.1;
  chordGain.connect(chordEQ); chordEQ.connect(reverb);
  melGain.connect(melEQ);     melEQ.connect(reverb);

  if (isExport) {
    reverb.connect(edRecorder);
    reverb.toDestination();
    edRecorder.start();
  } else {
    reverb.toDestination();
  }

  const cleanup = () => {
    try { if (edRawPlayer) { edRawPlayer.dispose(); edRawPlayer = null; } } catch(e){}
    try { chordGain.disconnect(); melGain.disconnect(); } catch(e){}
    try { chordEQ.dispose(); melEQ.dispose(); reverb.dispose(); } catch(e){}
    try { chordGain.gain.value = 1.0; melGain.gain.value = 1.0;
          chordGain.toDestination(); melGain.toDestination(); } catch(e){}
  };

  Tone.Transport.bpm.value = Math.max(40, Math.min(240, edBpm));
  const secPerBeat = 60 / Tone.Transport.bpm.value;
  const barLen     = secPerBeat * 4;
  const pseudoRand = seed => (Math.sin(seed * 9301 + 49297) * 0.5 + 0.5);

  // Schedule chords
  edBars.forEach((bar, i) => {
    const tStart = bar.beatOffset * secPerBeat;
    const barSec = (bar.dur || 4) * secPerBeat;
    const clamp  = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    const cs     = chordHandle.sampler;
    const bassNote   = Tone.Frequency(clamp(bar.root + 36, 21, 60), 'midi').toNote();
    const intervals  = bar.intervals || CHORD_TYPES[bar.quality] || [0, 4, 7];
    const midNotes   = intervals.map(o => Tone.Frequency(clamp(bar.root + 48 + (o >= 12 ? o - 12 : o), 36, 84), 'midi').toNote());
    const core       = intervals.slice(0, 3);
    const upperNotes = [
      ...core.slice(1).map(o => Tone.Frequency(clamp(bar.root + 60 + o, 48, 108), 'midi').toNote()),
      Tone.Frequency(clamp(bar.root + 72, 60, 108), 'midi').toNote(),
    ];
    Tone.Transport.schedule(time => {
      cs.triggerAttackRelease(bassNote, barSec * 0.93, time);
      midNotes.forEach((n, j) => cs.triggerAttackRelease(n, barSec * 0.93, time + j * (0.018 + pseudoRand(i*10+j)*0.012)));
      upperNotes.forEach((n, j) => cs.triggerAttackRelease(n, barSec * 0.55, time + 0.04 + j * (0.015 + pseudoRand(i*20+j)*0.01)));
    }, `+${tStart}`);
  });

  // Schedule melody
  if (playMelody) {
    edPitches.forEach(p => {
      const tStart = p.beat * secPerBeat;
      const dur    = p.dur ?? 1;
      Tone.Transport.schedule(time => {
        const d = Math.min(dur * secPerBeat * 0.9, barLen);
        melodyHandle.sampler.triggerAttackRelease(Tone.Frequency(p.midi, 'midi').toNote(), Math.max(0.05, d), time);
      }, `+${Math.max(0, tStart)}`);
    });
  }

  const totalBeats = edGetTotalBeats();
  const totalSec   = totalBeats * secPerBeat;

  // Schedule raw audio — restart at each loop boundary (up to 8 loops)
  if (playRaw && edRawPlayer && hasBlob) {
    edRawPlayer.connect(reverb);
    for (let loop = 0; loop < 8; loop++) {
      const loopOffset = loop * totalSec;
      Tone.Transport.schedule(time => {
        try {
          if (loop > 0) { try { edRawPlayer.stop(); } catch(e){} }
          edRawStartedAt = time;
          edRawPausedAt  = 0;
          edRawPlayer.start(time, 0);
        } catch(e){}
      }, `+${loopOffset}`);
    }
  }

  if (!isExport) {
    Tone.Transport.loop = true;
    Tone.Transport.loopStart = 0;
    Tone.Transport.loopEnd   = totalSec;
  } else {
    Tone.Transport.loop = false;
    Tone.Transport.schedule(time => {
      Tone.Draw.schedule(() => { stopEdPlayback(); cleanup(); }, time);
    }, `+${totalSec}`);
  }

  Tone.Transport.start();

  if (isExport) {
    return new Promise(resolve => {
      setTimeout(async () => {
        const recording = await edRecorder.stop();
        cleanup();
        resolve(recording);
      }, (totalSec + 2) * 1000);
    });
  }
  return null;
}

function stopEdPlayback() {
  Tone.Transport.stop();
  Tone.Transport.cancel();
  Tone.Transport.loop = false;
  edSeqPaused = false;
  if (edRawPlayer) {
    try { edRawPlayer.stop(); } catch(e){}
    try { edRawPlayer.dispose(); } catch(e){}
    edRawPlayer = null;
  }
  edRawStartedAt = 0; edRawPausedAt = 0;
  const btn = document.getElementById('edPlayBtn');
  if (btn) { btn.classList.remove('playing'); edUpdatePlayModeBtn(); }
  requestAnimationFrame(edDrawRoll);
}

// ── DOM BINDINGS ──
document.addEventListener('DOMContentLoaded', () => {

  document.getElementById('editorBackBtn')?.addEventListener('click', () => {
    stopEdPlayback();
    document.querySelector('.ed-ctx-menu')?.remove();
    showScreen('results');
  });

  document.getElementById('editorRefineBtn')?.addEventListener('click', edRefineMelody);

  document.getElementById('edPlayBtn')?.addEventListener('click', () => edTogglePlay());

  // Play mode split dropdown
  document.getElementById('edPlayArrow')?.addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('edPlayMenu')?.classList.toggle('open');
  });
  document.getElementById('edPlayMenu')?.addEventListener('click', e => {
    const item = e.target.closest('[data-mode]');
    if (!item) return;
    document.getElementById('edPlayMenu').classList.remove('open');
    const mode = item.dataset.mode;
    stopEdPlayback();
    edPlayMode = mode;
    edUpdatePlayModeBtn();
    edTogglePlay(false, mode);
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#edPlaySplit')) {
      document.getElementById('edPlayMenu')?.classList.remove('open');
    }
  });

  document.getElementById('edBpmDown')?.addEventListener('click', () => { edBpm = Math.max(40, edBpm - 5); edUpdateUI(); });
  document.getElementById('edBpmUp')?.addEventListener('click',   () => { edBpm = Math.min(240, edBpm + 5); edUpdateUI(); });

  document.getElementById('edUndoBtn')?.addEventListener('click', edUndo);
  document.getElementById('edRedoBtn')?.addEventListener('click', edRedo);

  document.getElementById('edCopyChordBtn')?.addEventListener('click', edCopyChords);
  document.getElementById('edPasteChordBtn')?.addEventListener('click', edPasteChords);

  document.getElementById('editorSaveBtn')?.addEventListener('click', () => {
    if (typeof savedSaveFromEditor === 'function') savedSaveFromEditor();
  });

  // Roll resize handle — same utility used by nb/mr rolls
  if (typeof makeRollResizable === 'function') {
    makeRollResizable('edRollResizeHandle', {
      getRowH:  () => ED_ROW_H,
      setRowH:  v  => { ED_ROW_H  = v; },
      getBeatW: () => ED_BEAT_W,
      setBeatW: v  => { ED_BEAT_W = v; },
      redraw:   ()  => edDrawRoll(),
      minRowH: 14, maxRowH: 72,
      minBeatW: 24, maxBeatW: 200,
    });
  }

  document.getElementById('editorExportBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('editorExportBtn');
    btn.textContent = '⤓ exporting...';
    btn.disabled = true;
    stopEdPlayback();
    const secPerBeat = 60 / edBpm;
    const dur = (edGetTotalBeats() * secPerBeat).toFixed(1);
    const status = document.getElementById('edPlayStatus');
    if (status) status.textContent = `Rendering audio (${dur}s)... please wait`;
    try {
      const blob = await edTogglePlay(true);
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.download = 'MelodyMatch_Export.wav';
        a.href = url; a.click();
        URL.revokeObjectURL(url);
        if (status) status.textContent = 'Export complete!';
      } else {
        if (status) status.textContent = 'Export failed.';
      }
    } catch(e) {
      console.error(e);
      if (status) status.textContent = 'Export failed.';
    }
    btn.textContent = '⤓ export audio';
    btn.disabled = false;
    setTimeout(() => { const s = document.getElementById('edPlayStatus'); if (s) s.textContent = ''; }, 4000);
  });
});
