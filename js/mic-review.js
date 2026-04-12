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

// Playhead scrub
let mrScrubbing = false;

// Metronome
let mrMetronomeEnabled = false;

// Box selection / copy-paste
let mrBoxSel = null;        // {startX, startY, endX, endY} while dragging
let mrSelected = new Set(); // indices of selected notes
let mrClipboard = [];       // copied notes [{midi,pc,beat,dur,conf}]

let MR_ROW_H         = 28;
let MR_BEAT_W        = 54;
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
    const isActive   = mrDragging?.noteIdx === i;
    const isSelected = mrSelected.has(i);
    const conf = note.conf ?? 1;

    const alpha = 0.5 + conf * 0.5;
    ctx.globalAlpha = alpha;
    ctx.shadowColor = isSelected ? '#a78bfa' : '#00d4ff';
    ctx.shadowBlur  = isActive ? 14 : isSelected ? 10 : (conf > 0.7 ? 5 : 2);
    ctx.fillStyle   = isActive ? '#40e0ff'
                    : isSelected ? '#c4b5fd'
                    : `hsl(${185 + (1 - conf) * 30}, 80%, ${50 + conf * 15}%)`;
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

  // Box selection rectangle
  if (mrBoxSel) {
    const bx = Math.min(mrBoxSel.startX, mrBoxSel.endX);
    const by = Math.min(mrBoxSel.startY, mrBoxSel.endY);
    const bw = Math.abs(mrBoxSel.endX - mrBoxSel.startX);
    const bh = Math.abs(mrBoxSel.endY - mrBoxSel.startY);
    ctx.strokeStyle = 'rgba(167,139,250,0.9)';
    ctx.fillStyle   = 'rgba(167,139,250,0.08)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 2);
    ctx.fill(); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Playhead
  if (mrPlayhead >= 0) {
    const x = mrPlayhead * MR_BEAT_W;
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

  // Update pitch label sidebar
  const sidebar = document.getElementById('mrPitchLabels');
  if (!sidebar) return;
  sidebar.innerHTML = '';
  const fontSize = Math.max(7, Math.min(13, MR_ROW_H * 0.45));
  sidebar.style.height = H + 'px';
  rows.forEach(midi => {
    const lbl = document.createElement('div');
    lbl.className = 'nb-pitch-label';
    lbl.style.height   = MR_ROW_H + 'px';
    lbl.style.fontSize = fontSize + 'px';
    lbl.style.flexShrink = '0';
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
  const totalTabs = mrTakes.length > 1 ? mrTakes.length + 1 : mrTakes.length;
  for (let i = 0; i < totalTabs; i++) {
    const isMerged = i === mrTakes.length;
    const d = document.createElement('div');
    const active = (mrActiveTake === 'merged' && isMerged) || (mrActiveTake === i && !isMerged);
    d.className = 'mr-take-dot' + (active ? ' active' : '');
    d.title = isMerged ? 'Merged Take' : mrTakes[i].label;
    d.style.marginRight = '4px';
    dots.appendChild(d);
  }

  // Thumbnails
  thumbs.innerHTML = '';
  const renderThumb = (takeData, i, isMerged) => {
    const thumb = document.createElement('div');
    const isSelected = isMerged ? (mrActiveTake === 'merged') : (mrActiveTake === i);
    thumb.className = 'mr-take-thumb' + (isSelected ? ' selected' : '');
    thumb.innerHTML = `
      <div class="mr-take-thumb-label">${isMerged ? 'Merged Take ✨' : takeData.label}</div>
      <canvas width="200" height="32"></canvas>
      <div class="mr-take-thumb-info">${takeData.notes.length} notes · ${takeData.bpm} bpm</div>
      ${!isMerged ? `<button class="mr-take-del" data-idx="${i}" title="remove take">✕</button>` : ''}
    `;
    thumb.addEventListener('click', e => {
      if (!isMerged && e.target.closest('.mr-take-del')) return;
      mrActiveTake = isMerged ? 'merged' : i;
      mrSequence = isMerged ? mrMergeTakes(mrTakes) : mrTakes[i].notes.map(n => ({ ...n }));
      mrRenderTakes();
      mrDrawRoll((isMerged || mrActiveTake === 'merged') ? null : i); // no faint highlighting on merged
      mrUpdateUI();
    });
    
    if (!isMerged) {
      const delBtn = thumb.querySelector('.mr-take-del');
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        mrTakes.splice(i, 1);
        if (mrTakes.length <= 1) mrActiveTake = 0;
        else if (mrActiveTake === i) mrActiveTake = Math.max(0, i - 1);
        else if (mrActiveTake > i && mrActiveTake !== 'merged') mrActiveTake--;
        
        if (mrTakes.length > 0) {
          mrSequence = mrActiveTake === 'merged' ? mrMergeTakes(mrTakes) : mrTakes[mrActiveTake].notes.map(n => ({ ...n }));
        } else {
          mrSequence = [];
        }
        mrRenderTakes();
        mrDrawRoll();
        mrUpdateUI();
      });
    }
    thumbs.appendChild(thumb);

    // Draw mini thumbnail
    const c = thumb.querySelector('canvas');
    const cc = c.getContext('2d');
    const W = c.width, H = c.height;
    const beats = mrTotalBeats();
    cc.fillStyle = '#111827';
    cc.fillRect(0, 0, W, H);
    if(takeData.notes.length === 0) return;
    const midis = takeData.notes.map(n => n.midi);
    const loM = Math.min(...midis) - 2, hiM = Math.max(...midis) + 2;
    const pitchRange = Math.max(1, hiM - loM);
    takeData.notes.forEach(note => {
      const x  = (note.beat / beats) * W;
      const nw = Math.max(2, (note.dur  / beats) * W - 1);
      const ny = ((hiM - note.midi) / pitchRange) * (H - 4) + 2;
      cc.fillStyle = isSelected ? '#00d4ff' : 'rgba(0,212,255,0.5)';
      if (isMerged) cc.fillStyle = isSelected ? '#a78bfa' : 'rgba(167, 139, 250, 0.5)'; // purple merged
      cc.fillRect(x, ny, nw, 4);
    });
  };

  mrTakes.forEach((take, i) => renderThumb(take, i, false));
  if (mrTakes.length > 1) {
    const mergedSeq = mrMergeTakes(mrTakes);
    renderThumb({ notes: mergedSeq, bpm: Math.round(mrTakes.reduce((a, b) => a + b.bpm, 0) / mrTakes.length) }, 'merged', true);
  }

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

// ── Strict Quantization (Auto-Tune Timing) ──
function mrAutoTuneSequence() {
  if (mrSequence.length === 0) return;
  mrSequence.forEach(n => {
    n.beat = Math.round(n.beat * 2) / 2; // snap to 8th
    n.dur = Math.max(0.25, Math.round((n.dur || 0.5) * 2) / 2);
  });
  
  // Merge overlapping or identical consecutive notes after snapping
  const snapped = [];
  mrSequence.sort((a,b) => a.beat - b.beat).forEach(n => {
    if (snapped.length > 0) {
      const prev = snapped[snapped.length - 1];
      if (prev.beat === n.beat) {
        // keep the longer/higher confident note
        if ((n.conf||1) > (prev.conf||1)) {
          snapped[snapped.length - 1] = n;
        }
        return;
      }
      if (prev.beat + prev.dur > n.beat) {
        prev.dur = n.beat - prev.beat; // trim overlap
      }
    }
    snapped.push(n);
  });
  
  mrSequence = snapped;
  mrDrawRoll();
  mrUpdateUI();
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

// ── Playhead hit test (within 10px of the line) ──
function mrHitPlayhead(x) {
  if (mrPlayhead < 0) return false;
  return Math.abs(x - mrPlayhead * MR_BEAT_W) <= 10;
}

// ── Copy / paste ──
function mrCopySelected() {
  if (mrSelected.size === 0) return;
  mrClipboard = [...mrSelected].map(i => ({ ...mrSequence[i] }));
}

function mrPasteClipboard() {
  if (mrClipboard.length === 0) return;
  const minBeat = Math.min(...mrClipboard.map(n => n.beat));
  // Paste after the last note in the sequence
  const pasteOffset = mrSequence.length > 0
    ? Math.max(...mrSequence.map(n => n.beat + n.dur))
    : 0;
  const newNotes = mrClipboard.map(n => ({
    ...n,
    beat: mrSnapBeat(n.beat - minBeat + pasteOffset),
  }));
  const insertIdx = mrSequence.length;
  mrSequence.push(...newNotes);
  mrSelected = new Set(newNotes.map((_, i) => insertIdx + i));
  mrUpdateUI();
  mrDrawRoll();
}

// ── Mouse/touch interaction on the review roll ──
function mrOnMouseDown(e) {
  const { x, y } = mrCanvasXY(e);

  // 1 — playhead scrub
  if (mrHitPlayhead(x)) {
    mrScrubbing = true;
    mrCanvas.style.cursor = 'col-resize';
    return;
  }

  // 2 — note hit
  const hit = mrHitNote(x, y);
  if (hit) {
    // If clicking a selected note, move the whole selection
    if (mrSelected.has(hit.idx) && hit.mode === 'move' && mrSelected.size > 1) {
      mrDragging = { noteIdx: hit.idx, mode: 'moveSelection', startX: x, startY: y,
        origBeats: [...mrSelected].map(i => ({ i, beat: mrSequence[i].beat })),
        origMidis: [...mrSelected].map(i => ({ i, midi: mrSequence[i].midi })) };
    } else {
      if (!e.shiftKey) mrSelected.clear();
      mrSelected.add(hit.idx);
      const n = mrSequence[hit.idx];
      mrDragging = { noteIdx: hit.idx, mode: hit.mode, startX: x, startY: y,
        origBeat: n.beat, origDur: n.dur ?? 0.5, origMidi: n.midi };
    }
    mrCanvas.style.cursor = hit.mode === 'resize' ? 'ew-resize' : 'grabbing';
    mrDrawRoll();
    return;
  }

  // 3 — empty space: start box selection
  if (!e.shiftKey) mrSelected.clear();
  mrBoxSel = { startX: x, startY: y, endX: x, endY: y };
  mrDrawRoll();
}

function mrOnMouseMove(e) {
  const { x, y } = mrCanvasXY(e);

  if (mrScrubbing) {
    mrPlayhead = Math.max(0, Math.min(mrTotalBeats(), x / MR_BEAT_W));
    mrDrawRoll();
    return;
  }

  if (mrBoxSel) {
    mrBoxSel.endX = x;
    mrBoxSel.endY = y;
    // Update selection set
    const bx1 = Math.min(mrBoxSel.startX, x);
    const bx2 = Math.max(mrBoxSel.startX, x);
    const by1 = Math.min(mrBoxSel.startY, y);
    const by2 = Math.max(mrBoxSel.startY, y);
    const rows = mrGetRows();
    mrSequence.forEach((note, i) => {
      const nx = note.beat * MR_BEAT_W + 2;
      const nw = Math.max(MR_BEAT_W * 0.3, note.dur * MR_BEAT_W - 4);
      const r  = rows.indexOf(note.midi);
      const ny = r * MR_ROW_H + 3;
      const nh = MR_ROW_H - 6;
      const overlaps = nx < bx2 && nx + nw > bx1 && ny < by2 && ny + nh > by1;
      if (overlaps) mrSelected.add(i); else if (!e.shiftKey) mrSelected.delete(i);
    });
    mrDrawRoll();
    return;
  }

  if (mrDragging) {
    const dx = x - mrDragging.startX;
    const dy = y - mrDragging.startY;
    if (mrDragging.mode === 'moveSelection') {
      const beatDelta  = mrSnapBeat(dx / MR_BEAT_W);
      const pitchDelta = -Math.round(dy / MR_ROW_H); // up = higher midi
      mrDragging.origBeats.forEach(({ i, beat }) => {
        mrSequence[i].beat = Math.max(0, Math.min(mrTotalBeats() - (mrSequence[i].dur ?? 0.25), beat + beatDelta));
      });
      mrDragging.origMidis.forEach(({ i, midi }) => {
        const newMidi = Math.max(21, Math.min(108, midi + pitchDelta));
        mrSequence[i].midi = newMidi;
        mrSequence[i].pc   = newMidi % 12;
        mrSequence[i].freq = 440 * Math.pow(2, (newMidi - 69) / 12);
      });
    } else if (mrDragging.mode === 'move') {
      const n = mrSequence[mrDragging.noteIdx];
      n.beat = Math.max(0, Math.min(mrTotalBeats() - (n.dur ?? 0.25),
        mrSnapBeat(mrDragging.origBeat + dx / MR_BEAT_W)));
      // Vertical: snap to semitone rows
      const pitchDelta = -Math.round(dy / MR_ROW_H);
      const newMidi = Math.max(21, Math.min(108, mrDragging.origMidi + pitchDelta));
      n.midi = newMidi;
      n.pc   = newMidi % 12;
      n.freq = 440 * Math.pow(2, (newMidi - 69) / 12);
    } else {
      const n = mrSequence[mrDragging.noteIdx];
      n.dur = Math.max(0.25, mrSnapBeat(mrDragging.origDur + dx / MR_BEAT_W));
    }
    mrDrawRoll();
    return;
  }

  // Cursor hints
  if (mrHitPlayhead(x)) { mrCanvas.style.cursor = 'col-resize'; return; }
  const hit = mrHitNote(x, y);
  mrCanvas.style.cursor = !hit ? 'crosshair' : (hit.mode === 'resize' ? 'ew-resize' : 'grab');
}

function mrOnMouseUp(e) {
  if (mrScrubbing) {
    mrScrubbing = false;
    mrCanvas.style.cursor = 'default';
    // If playback is running, restart from the scrubbed position
    const beat = mrPlayhead;
    if (beat >= 0) mrSeekPlayback(beat);
    return;
  }

  if (mrBoxSel) {
    mrBoxSel = null;
    mrDrawRoll();
    return;
  }

  if (!mrDragging) return;

  // No delete on click — click selects, Backspace/Delete removes
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
