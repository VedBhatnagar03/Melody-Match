/* ───────────────────────────────────────────────
   MIC REVIEW — multi-take piano roll editor
   After offline analysis, notes land here for
   the user to inspect, correct, add extra takes,
   and finally send to scale/chord analysis.
   Depends on: constants.js, audio.js, playback.js
─────────────────────────────────────────────── */

// ── State ──
let mrTakes      = [];   // [{notes:[{midi,pc,beat,dur,conf}], bpm, label}]
let mrActiveTake = 0;
let mrSequence   = [];   // working copy — what the user edits
let mrBpm        = 100;
let mrBars       = 4;

// Canvas
let mrCanvas, mrCtx;
let mrDragging = null;  // {noteIdx, startX, origBeat, origDur, mode:'move'|'resize'}
let mrPlayhead = -1;

const MR_ROW_H         = 28;
const MR_BEAT_W        = 54;
const MR_RESIZE_HANDLE = 8;

// ── Helpers ──
function mrGetRows() {
  if (mrSequence.length === 0) return [];
  const midis = [...new Set(mrSequence.map(n => n.midi))].sort((a, b) => b - a);
  const lo = Math.min(...midis) - 2;
  const hi = Math.max(...midis) + 2;
  const full = [];
  for (let m = hi; m >= lo; m--) full.push(m);
  return full;
}
function mrTotalBeats() { return mrBars * 4; }
function mrSnapBeat(b)  { return Math.max(0, Math.round(b * 4) / 4); } // snap to 16th note

// ── Convert detectedPitches → mrSequence beats ──
function mrPitchesToSequence(pitches) {
  if (pitches.length === 0) return { seq: [], bpm: 100, bars: 4 };

  const ioiMs = [];
  for (let i = 1; i < pitches.length; i++) {
    const d = pitches[i].time - pitches[i - 1].time;
    if (d > 60 && d < 2500) ioiMs.push(d);
  }

  let bpm = 100;
  if (ioiMs.length >= 2) {
    ioiMs.sort((a, b) => a - b);
    const med = ioiMs[Math.floor(ioiMs.length / 2)];
    const candidates = [med * 0.5, med, med * 2].map(period => {
      const bpmCandidate = Math.round(60000 / period);
      return { bpm: bpmCandidate, period };
    }).filter(c => c.bpm >= 50 && c.bpm <= 200);

    let bestFit = 0, bestBpm = 100;
    for (const c of candidates) {
      let fit = 0;
      for (const ioi of ioiMs) {
        const ratio = ioi / c.period;
        const err   = Math.abs(ratio - Math.round(ratio));
        if (err < 0.18) fit++;
      }
      if (fit > bestFit) { bestFit = fit; bestBpm = c.bpm; }
    }
    bpm = bestBpm;
  }

  const secPerBeat = 60 / bpm;
  const t0ms = pitches[0].time; // first note = beat 0

  const seq = pitches.map(p => {
    const relSec  = (p.time - t0ms) / 1000;
    const beat    = mrSnapBeat(relSec / secPerBeat);
    const durBeats = Math.max(0.25, mrSnapBeat(p.dur ?? 0.5));
    return { midi: p.midi, pc: p.pc, beat, dur: durBeats, conf: 1 };
  });

  const maxBeat = Math.max(...seq.map(n => n.beat + n.dur));
  const bars = Math.max(2, Math.min(8, Math.ceil(maxBeat / 4)));

  return { seq, bpm, bars };
}

// ── Merge multiple takes by majority vote ──
function mrMergeTakes(takes) {
  if (takes.length === 0) return [];
  if (takes.length === 1) return takes[0].notes.map(n => ({ ...n, conf: 1 }));

  const GRID = 0.25; // 16th note
  const slotMap = new Map();

  for (const take of takes) {
    for (const note of take.notes) {
      const slot = Math.round(note.beat / GRID) * GRID;
      if (!slotMap.has(slot)) slotMap.set(slot, []);
      slotMap.get(slot).push(note.midi);
    }
  }

  const merged = [];
  for (const [slot, midis] of [...slotMap.entries()].sort((a, b) => a[0] - b[0])) {
    const counts = {};
    for (const m of midis) counts[m] = (counts[m] || 0) + 1;
    let bestMidi = midis[0], bestCount = 0;
    for (const [m, c] of Object.entries(counts)) {
      if (c > bestCount) { bestCount = c; bestMidi = +m; }
    }
    const conf = bestCount / takes.length;

    if (conf >= 0.5) {
      const ref = takes.flatMap(t => t.notes).find(n =>
        Math.abs(n.beat - slot) < GRID * 0.6 && n.midi === bestMidi
      );
      const dur = ref ? ref.dur : 0.5;
      merged.push({ midi: bestMidi, pc: midiToPc(bestMidi), beat: slot, dur, conf });
    }
  }
  return merged;
}

// ── Draw the piano roll ──
function mrDrawRoll(highlightTake = null) {
  if (!mrCanvas) return;
  const rows  = mrGetRows();
  const beats = mrTotalBeats();
  const W = Math.max(beats * MR_BEAT_W, 200);
  const H = Math.max(rows.length, 4) * MR_ROW_H;

  mrCanvas.width  = W;
  mrCanvas.height = H;

  const ctx = mrCtx;
  ctx.clearRect(0, 0, W, H);

  // Background rows
  rows.forEach((midi, r) => {
    const isBlack = [1, 3, 6, 8, 10].includes(midi % 12);
    const isC     = midi % 12 === 0;
    ctx.fillStyle = isBlack ? '#0d1726' : (isC ? '#14213a' : '#111827');
    ctx.fillRect(0, r * MR_ROW_H, W, MR_ROW_H);
  });

  // Beat / bar grid lines
  for (let b = 0; b <= beats; b++) {
    const x = b * MR_BEAT_W;
    const isBar = b % 4 === 0;
    ctx.strokeStyle = isBar ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.05)';
    ctx.lineWidth   = isBar ? 1.5 : 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  // 16th note grid (subtle)
  for (let b16 = 0; b16 <= beats * 4; b16++) {
    if (b16 % 4 === 0) continue;
    const x = b16 * MR_BEAT_W * 0.25;
    ctx.strokeStyle = 'rgba(255,255,255,0.025)';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }

  // Row dividers
  rows.forEach((_, r) => {
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, r * MR_ROW_H); ctx.lineTo(W, r * MR_ROW_H); ctx.stroke();
  });

  // Highlight take overlay (faint amber)
  if (highlightTake !== null && mrTakes[highlightTake]) {
    for (const note of mrTakes[highlightTake].notes) {
      const r = rows.indexOf(note.midi);
      if (r < 0) continue;
      const x = note.beat * MR_BEAT_W + 2;
      const y = r * MR_ROW_H + 3;
      const w = Math.max(MR_BEAT_W * 0.25, note.dur * MR_BEAT_W - 4);
      const h = MR_ROW_H - 6;
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = '#ff8c42';
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 3); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // Note blocks
  mrSequence.forEach((note, i) => {
    const r = rows.indexOf(note.midi);
    if (r < 0) return;
    const x = note.beat * MR_BEAT_W + 2;
    const y = r * MR_ROW_H + 3;
    const w = Math.max(MR_BEAT_W * 0.3, note.dur * MR_BEAT_W - 4);
    const h = MR_ROW_H - 6;
    const isActive = mrDragging?.noteIdx === i;
    const conf = note.conf ?? 1;

    const alpha = 0.5 + conf * 0.5;
    ctx.globalAlpha = alpha;
    ctx.shadowColor = '#00d4ff';
    ctx.shadowBlur  = isActive ? 14 : (conf > 0.7 ? 5 : 2);
    ctx.fillStyle   = isActive ? '#40e0ff' : `hsl(${185 + (1 - conf) * 30}, 80%, ${50 + conf * 15}%)`;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 3); ctx.fill();
    ctx.shadowBlur  = 0;
    ctx.globalAlpha = 1;

    // Resize handle
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.roundRect(x + w - MR_RESIZE_HANDLE, y, MR_RESIZE_HANDLE, h, [0,3,3,0]); ctx.fill();

    // Label
    ctx.fillStyle = '#040a12';
    ctx.font = 'bold 10px "Space Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (w > 20) ctx.fillText(pcToName(note.pc), x + (w - MR_RESIZE_HANDLE) / 2, y + h / 2);
  });

  // Playhead
  if (mrPlayhead >= 0) {
    const x = mrPlayhead * MR_BEAT_W;
    ctx.strokeStyle = '#ff4757';
    ctx.lineWidth   = 2;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }

  // Update pitch label sidebar
  const sidebar = document.getElementById('mrPitchLabels');
  if (!sidebar) return;
  sidebar.innerHTML = '';
  rows.forEach(midi => {
    const lbl = document.createElement('div');
    lbl.className = 'nb-pitch-label';
    lbl.style.height = MR_ROW_H + 'px';
    lbl.textContent = pcToName(midi % 12) + (Math.floor(midi / 12) - 1);
    sidebar.appendChild(lbl);
  });
}

// ── Hit test ──
function mrHitNote(cx, cy) {
  const rows = mrGetRows();
  const r    = Math.floor(cy / MR_ROW_H);
  const midi = rows[r];
  if (midi === undefined) return null;
  for (let i = mrSequence.length - 1; i >= 0; i--) {
    const n  = mrSequence[i];
    if (n.midi !== midi) continue;
    const nx = n.beat * MR_BEAT_W + 2;
    const nw = Math.max(MR_BEAT_W * 0.3, n.dur * MR_BEAT_W - 4);
    if (cx >= nx && cx <= nx + nw) {
      const mode = cx >= nx + nw - MR_RESIZE_HANDLE ? 'resize' : 'move';
      return { idx: i, mode };
    }
  }
  return null;
}

// ── Canvas coordinate helper — accounts for scroll correctly ──
function mrCanvasXY(e) {
  const rect     = mrCanvas.getBoundingClientRect();
  const scroller = document.getElementById('mrRollScroll');
  return {
    x: (e.clientX - rect.left) + (scroller ? scroller.scrollLeft : 0),
    y: (e.clientY - rect.top),
  };
}

// ── Update UI counts ──
function mrUpdateUI() {
  const el = document.getElementById('mrNoteCount');
  if (el) el.textContent = mrSequence.length + (mrSequence.length === 1 ? ' note' : ' notes');
  const analyseBtn = document.getElementById('mrAnalyseBtn');
  if (analyseBtn) analyseBtn.disabled = mrSequence.length < 4;
  const playBtn = document.getElementById('mrPlayBtn');
  if (playBtn) playBtn.disabled = mrSequence.length === 0;
  document.getElementById('mrBpmLabel').textContent = mrBpm;
}

// ── Render takes strip ──
function mrRenderTakes() {
  const dots   = document.getElementById('mrTakeDots');
  const thumbs = document.getElementById('mrTakeThumbs');
  if (!dots || !thumbs) return;

  // Dots
  dots.innerHTML = '';
  mrTakes.forEach((take, i) => {
    const d = document.createElement('div');
    d.className = 'mr-take-dot' + (i === mrActiveTake ? ' active' : '');
    d.title = take.label;
    d.style.marginRight = '4px';
    dots.appendChild(d);
  });

  // Thumbnails
  thumbs.innerHTML = '';
  mrTakes.forEach((take, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'mr-take-thumb' + (i === mrActiveTake ? ' selected' : '');
    thumb.innerHTML = `
      <div class="mr-take-thumb-label">${take.label}</div>
      <canvas width="200" height="32"></canvas>
      <div class="mr-take-thumb-info">${take.notes.length} notes · ${take.bpm} bpm</div>
      <button class="mr-take-del" data-idx="${i}" title="remove take">✕</button>
    `;
    thumb.addEventListener('click', e => {
      if (e.target.closest('.mr-take-del')) return;
      mrActiveTake = i;
      mrSequence   = mrTakes.length > 1 ? mrMergeTakes(mrTakes) : mrTakes[0].notes.map(n => ({ ...n }));
      mrRenderTakes();
      mrDrawRoll(i);
      mrUpdateUI();
    });
    const delBtn = thumb.querySelector('.mr-take-del');
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      mrTakes.splice(i, 1);
      if (mrActiveTake >= mrTakes.length) mrActiveTake = Math.max(0, mrTakes.length - 1);
      if (mrTakes.length > 0) {
        mrSequence = mrTakes.length > 1 ? mrMergeTakes(mrTakes) : mrTakes[0].notes.map(n => ({ ...n }));
      } else {
        mrSequence = [];
      }
      mrRenderTakes();
      mrDrawRoll();
      mrUpdateUI();
    });
    thumbs.appendChild(thumb);

    // Draw mini thumbnail of this take
    const c = thumb.querySelector('canvas');
    const cc = c.getContext('2d');
    const W = c.width, H = c.height;
    const beats = mrTotalBeats();
    cc.fillStyle = '#111827';
    cc.fillRect(0, 0, W, H);
    const midis = take.notes.map(n => n.midi);
    const loM = Math.min(...midis) - 2, hiM = Math.max(...midis) + 2;
    const pitchRange = Math.max(1, hiM - loM);
    take.notes.forEach(note => {
      const x  = (note.beat / beats) * W;
      const nw = Math.max(2, (note.dur  / beats) * W - 1);
      const ny = ((hiM - note.midi) / pitchRange) * (H - 4) + 2;
      cc.fillStyle = i === mrActiveTake ? '#00d4ff' : 'rgba(0,212,255,0.5)';
      cc.fillRect(x, ny, nw, 4);
    });
  });

  const addBtn = document.getElementById('mrAddTakeBtn');
  if (addBtn) addBtn.disabled = mrTakes.length >= 3;
}

// ── Initialise from detectedPitches ──
function mrInitFromDetected() {
  const { seq, bpm, bars } = mrPitchesToSequence(detectedPitches);
  mrBpm  = bpm;
  mrBars = bars;

  const takeLabel = `Take ${mrTakes.length + 1}`;
  mrTakes = [{ notes: seq.map(n => ({ ...n })), bpm, label: takeLabel }];
  mrActiveTake = 0;
  mrSequence   = seq.map(n => ({ ...n }));

  mrUpdateUI();
  mrRenderTakes();
  mrDrawRoll();

  const sub = document.getElementById('mrSub');
  if (sub) sub.textContent = `${seq.length} notes detected at ~${bpm} BPM · adjust as needed`;
}

// ── Add another take ──
let mrAddingTake = false;

async function mrAddTake() {
  if (mrAddingTake) return;
  mrAddingTake = true;
  const addBtn = document.getElementById('mrAddTakeBtn');
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = '● recording...'; }

  showScreen('recording');
  const hint = document.getElementById('recHint');
  if (hint) hint.textContent = `Recording Take ${mrTakes.length + 1} — sing the same melody again`;

  const ok = await startAudio();
  if (!ok) {
    mrAddingTake = false;
    showScreen('mic-review');
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = '+ add take'; }
  }
  // Flow continues in stopBtn handler in app.js which checks mrAddingTake
}

// ── Mouse/touch interaction on the review roll ──
function mrOnMouseDown(e) {
  const { x, y } = mrCanvasXY(e);
  const hit = mrHitNote(x, y);
  if (!hit) return;
  const n = mrSequence[hit.idx];
  mrDragging = { noteIdx: hit.idx, mode: hit.mode, startX: x,
    origBeat: n.beat, origDur: n.dur ?? 0.5 };
  mrCanvas.style.cursor = hit.mode === 'resize' ? 'ew-resize' : 'grabbing';
  mrDrawRoll();
}

function mrOnMouseMove(e) {
  if (!mrDragging) {
    const { x, y } = mrCanvasXY(e);
    const hit = mrHitNote(x, y);
    mrCanvas.style.cursor = !hit ? 'default' : (hit.mode === 'resize' ? 'ew-resize' : 'grab');
    return;
  }
  const { x } = mrCanvasXY(e);
  const dx = x - mrDragging.startX;
  const n  = mrSequence[mrDragging.noteIdx];
  if (mrDragging.mode === 'move') {
    n.beat = Math.max(0, Math.min(mrTotalBeats() - (n.dur ?? 0.25),
      mrSnapBeat(mrDragging.origBeat + dx / MR_BEAT_W)));
  } else {
    n.dur = Math.max(0.25, mrSnapBeat(mrDragging.origDur + dx / MR_BEAT_W));
  }
  mrDrawRoll();
}

function mrOnMouseUp(e) {
  if (!mrDragging) return;
  const { x } = mrCanvasXY(e);
  if (Math.abs(x - mrDragging.startX) < 5 && mrDragging.mode === 'move') {
    mrSequence.splice(mrDragging.noteIdx, 1);
    mrUpdateUI();
  }
  mrDragging = null;
  mrCanvas.style.cursor = 'default';
  mrDrawRoll();
}

function mrOnTouchStart(e) { e.preventDefault(); mrOnMouseDown(e.touches[0]); }
function mrOnTouchMove(e)  { e.preventDefault(); mrOnMouseMove(e.touches[0]); }
function mrOnTouchEnd(e)   { e.preventDefault(); mrOnMouseUp(e.changedTouches[0]); }

function mrInitRoll() {
  mrCanvas = document.getElementById('mrRollCanvas');
  mrCtx    = mrCanvas.getContext('2d');
  mrCanvas.addEventListener('mousedown',  mrOnMouseDown);
  mrCanvas.addEventListener('mousemove',  mrOnMouseMove);
  mrCanvas.addEventListener('mouseup',    mrOnMouseUp);
  mrCanvas.addEventListener('mouseleave', mrOnMouseUp);
  mrCanvas.addEventListener('touchstart', mrOnTouchStart, { passive: false });
  mrCanvas.addEventListener('touchmove',  mrOnTouchMove,  { passive: false });
  mrCanvas.addEventListener('touchend',   mrOnTouchEnd,   { passive: false });
}
