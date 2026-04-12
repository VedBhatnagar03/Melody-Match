/* ───────────────────────────────────────────────
   EDITOR & EXPORT
   Depends on: app.js, playback.js, Tone.js
─────────────────────────────────────────────── */

let edBars = [];
let edPitches = [];
let edBpm = 100;
let edScaleResult = null;
let edPlaying = false;
let edRecorder = null;
let edCanvas, edCtx;

// Grid configuration
const ED_PITCH_ROW_H = 20;
const ED_CHORD_ROW_H = 40;
const ED_BEAT_W = 48;
const ED_RESIZE_HANDLE = 8;

let edDragging = null; // { type: 'melody'|'chord', idx, mode, startX, startY, origBeat, origDur, origMidi }
let edRows = [];

function getEdTotalBeats() {
  const maxChordBeat = edBars.length > 0 ? Math.max(...edBars.map(b => b.beatOffset || 0)) + 4 : 0;
  const maxMelBeat = edPitches.length > 0 ? Math.max(...edPitches.map(p => (p.beat || 0) + (p.dur || 1))) : 0;
  return Math.ceil(Math.max(16, maxChordBeat + 4, maxMelBeat + 4) / 4) * 4;
}

function updateEdUI() {
  document.getElementById('edBpmLabel').textContent = edBpm;
}

// Ensure chords have explicit beat offsets
function initEdState(bars, pitches, bpm, scaleResult) {
  edBars = bars.map((b, i) => ({ ...b, beatOffset: i * 4 }));
  
  if (pitchSource !== 'builder') {
    // Convert relative seconds to beats
    if (pitches.length > 0) {
      const t0ms = pitches[0].time;
      const secPerBeat = 60 / bpm;
      edPitches = pitches.map(p => {
        const relSec = (p.time - t0ms) / 1000;
        return {
          ...p,
          beat: Math.round((relSec / secPerBeat) * 2) / 2, // snap to 8th note
          dur: p.dur ?? 1
        };
      });
    } else {
      edPitches = [];
    }
  } else {
    edPitches = pitches.map(p => ({ ...p }));
  }
  
  edBpm = bpm || 100;
  edScaleResult = scaleResult;
  updateEdUI();
  
  edRows = [...new Set(edPitches.map(p => p.midi))].sort((a,b) => b - a);
  if (edRows.length < 12) {
    // pad out to a nice octave range dynamically around the median
    let min = Math.min(...edPitches.map(p=>p.midi));
    let max = Math.max(...edPitches.map(p=>p.midi));
    if(!isFinite(min)) min = 60;
    if(!isFinite(max)) max = 72;
    edRows = [];
    for(let m = max + 4; m >= min - 4; m--) edRows.push(m);
  }

  requestAnimationFrame(edDrawRoll);
}

function openEditor(bars, pitches, bpm, scaleResult) {
  stopEdPlayback();
  initEdState(bars, pitches, bpm, scaleResult);
  showScreen('editor');
  if(!edCanvas) initEdCanvas();
}

function initEdCanvas() {
  edCanvas = document.getElementById('edRollCanvas');
  edCtx = edCanvas.getContext('2d');
  edCanvas.addEventListener('mousedown', edOnMouseDown);
  edCanvas.addEventListener('mousemove', edOnMouseMove);
  edCanvas.addEventListener('mouseup', edOnMouseUp);
  edCanvas.addEventListener('mouseleave', edOnMouseUp);
  
  // Also start polling Transport for playhead drawing
  function drawLoop() {
    if (Tone.Transport.state === 'started') edDrawRoll();
    requestAnimationFrame(drawLoop);
  }
  drawLoop();
}

// ── HIT TEST ──
function edHitTest(cx, cy) {
  const beats = getEdTotalBeats();
  const melHeight = edRows.length * ED_PITCH_ROW_H;
  
  // Check Chords zone (at the bottom)
  if (cy >= melHeight && cy <= melHeight + ED_CHORD_ROW_H) {
    for (let i = edBars.length - 1; i >= 0; i--) {
      const b = edBars[i];
      const nx = b.beatOffset * ED_BEAT_W;
      const nw = 4 * ED_BEAT_W - 4; // 1 bar width - margin
      if (cx >= nx && cx <= nx + nw) {
        return { type: 'chord', idx: i, mode: 'move' };
      }
    }
    return null;
  }
  
  // Check Melody zone
  const r = Math.floor(cy / ED_PITCH_ROW_H);
  if (r >= 0 && r < edRows.length) {
    const midi = edRows[r];
    for(let i = edPitches.length - 1; i >= 0; i--) {
      const p = edPitches[i];
      if (p.midi !== midi) continue;
      const nx = p.beat * ED_BEAT_W;
      const nw = Math.max(ED_BEAT_W * 0.4, p.dur * ED_BEAT_W - 2);
      if (cx >= nx && cx <= nx + nw) {
        const mode = cx >= nx + nw - ED_RESIZE_HANDLE ? 'resize' : 'move';
        return { type: 'melody', idx: i, mode };
      }
    }
  }
  
  return null;
}

function edSnapBeat(beat) {
  return Math.max(0, Math.round(beat * 2) / 2); // snap to 8ths
}

function edCanvasXY(e) {
  const rect = edCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function edOnMouseDown(e) {
  const { x, y } = edCanvasXY(e);
  const hit = edHitTest(x, y);
  if (!hit) return;
  
  if (hit.type === 'chord') {
    const b = edBars[hit.idx];
    edDragging = { type: 'chord', idx: hit.idx, mode: hit.mode, startX: x, startY: y, origBeat: b.beatOffset };
    edCanvas.style.cursor = 'grabbing';
  } else {
    const p = edPitches[hit.idx];
    edDragging = { type: 'melody', idx: hit.idx, mode: hit.mode, startX: x, startY: y, origBeat: p.beat, origDur: p.dur, origMidi: p.midi };
    edCanvas.style.cursor = hit.mode === 'resize' ? 'ew-resize' : 'grabbing';
  }
  edDrawRoll();
}

function edOnMouseMove(e) {
  if (!edDragging) {
    const { x, y } = edCanvasXY(e);
    const hit = edHitTest(x, y);
    edCanvas.style.cursor = !hit ? 'crosshair' : (hit.mode === 'resize' ? 'ew-resize' : 'grab');
    return;
  }
  
  const { x, y } = edCanvasXY(e);
  const dx = x - edDragging.startX;
  const dy = y - edDragging.startY;
  const beatDelta = dx / ED_BEAT_W;
  
  if (edDragging.type === 'chord') {
    const b = edBars[edDragging.idx];
    b.beatOffset = Math.max(0, Math.round(edDragging.origBeat + beatDelta)); // chords snap to whole beats for ease
  } else {
    const p = edPitches[edDragging.idx];
    if (edDragging.mode === 'move') {
      p.beat = edSnapBeat(edDragging.origBeat + beatDelta);
      
      const rowDelta = Math.round(dy / ED_PITCH_ROW_H);
      let r = edRows.indexOf(edDragging.origMidi) + rowDelta;
      r = Math.max(0, Math.min(edRows.length - 1, r));
      p.midi = edRows[r];
      p.pc = p.midi % 12;
    } else {
      p.dur = Math.max(0.5, Math.round((edDragging.origDur + beatDelta) * 2) / 2);
    }
  }
  
  edDrawRoll();
}

function edOnMouseUp(e) {
  if (!edDragging) return;
  edDragging = null;
  edCanvas.style.cursor = 'crosshair';
  edDrawRoll();
}

// ── DRAWING ──
function edDrawRoll() {
  if(!edCanvas) return;
  const beats = getEdTotalBeats();
  const W = beats * ED_BEAT_W;
  const melHeight = edRows.length * ED_PITCH_ROW_H;
  const H = melHeight + ED_CHORD_ROW_H;
  
  edCanvas.width = W;
  edCanvas.height = H;
  
  edCtx.clearRect(0,0,W,H);
  
  // 1. Draw Grid
  edRows.forEach((midi, r) => {
    const isBlack = [1,3,6,8,10].includes(midi % 12);
    edCtx.fillStyle = isBlack ? '#0e1828' : '#111827';
    edCtx.fillRect(0, r * ED_PITCH_ROW_H, W, ED_PITCH_ROW_H);
    edCtx.strokeStyle = 'rgba(255,255,255,0.04)';
    edCtx.beginPath(); edCtx.moveTo(0, r*ED_PITCH_ROW_H); edCtx.lineTo(W, r*ED_PITCH_ROW_H); edCtx.stroke();
  });
  
  edCtx.fillStyle = '#1a2236'; // chord zone bg
  edCtx.fillRect(0, melHeight, W, ED_CHORD_ROW_H);
  
  for(let b=0; b<=beats; b++){
    const x = b * ED_BEAT_W;
    const isBar = b % 4 === 0;
    edCtx.strokeStyle = isBar ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)';
    edCtx.lineWidth = isBar ? 1.5 : 1;
    edCtx.beginPath(); edCtx.moveTo(x,0); edCtx.lineTo(x,H); edCtx.stroke();
  }
  
  // 2. Draw Chord Blocks
  edBars.forEach((b, i) => {
    const isActive = edDragging?.type === 'chord' && edDragging.idx === i;
    const x = b.beatOffset * ED_BEAT_W + 2;
    const y = melHeight + 4;
    const w = 4 * ED_BEAT_W - 4;
    const h = ED_CHORD_ROW_H - 8;
    
    edCtx.fillStyle = isActive ? '#a78bfa' : '#8b5cf6';
    edCtx.globalAlpha = 0.8;
    edCtx.beginPath(); edCtx.roundRect(x,y,w,h,4); edCtx.fill();
    edCtx.globalAlpha = 1.0;
    
    edCtx.fillStyle = '#fff';
    edCtx.font = 'bold 11px "Space Mono", monospace';
    edCtx.textAlign = 'center';
    edCtx.textBaseline = 'middle';
    const name = pcToName(b.root) + (CHORD_SUFFIXES[b.quality] ?? '');
    edCtx.fillText(name, x + w/2, y + h/2);
  });
  
  // 3. Draw Melody Notes
  edPitches.forEach((p, i) => {
    const r = edRows.indexOf(p.midi);
    if(r < 0) return;
    const isActive = edDragging?.type === 'melody' && edDragging.idx === i;
    const x = p.beat * ED_BEAT_W + 2;
    const y = r * ED_PITCH_ROW_H + 2;
    const dur = p.dur ?? 1;
    const w = Math.max(ED_BEAT_W * 0.4, dur * ED_BEAT_W - 4);
    const h = ED_PITCH_ROW_H - 4;
    
    edCtx.fillStyle = isActive ? '#40e0ff' : '#00d4ff';
    edCtx.shadowColor = '#00d4ff';
    edCtx.shadowBlur = isActive ? 10 : 3;
    edCtx.beginPath(); edCtx.roundRect(x,y,w,h,3); edCtx.fill();
    edCtx.shadowBlur = 0;
    
    // resize handle
    edCtx.fillStyle = 'rgba(0,0,0,0.3)';
    edCtx.beginPath(); edCtx.roundRect(x+w-ED_RESIZE_HANDLE, y, ED_RESIZE_HANDLE, h, [0,3,3,0]); edCtx.fill();
  });
  
  // 4. Draw Playhead if Transport is running
  if (Tone.Transport.state === 'started') {
    const beatsPos = Tone.Transport.ticks / Tone.Transport.PPQ;
    const x = beatsPos * ED_BEAT_W;
    edCtx.strokeStyle = '#ff4757';
    edCtx.lineWidth = 2;
    edCtx.beginPath(); edCtx.moveTo(x,0); edCtx.lineTo(x,H); edCtx.stroke();
  }
  
  // Pitch Labels Sidebar Update
  const sidebar = document.getElementById('edPitchLabels');
  if(sidebar) {
    sidebar.innerHTML = '';
    edRows.forEach(midi => {
      const lbl = document.createElement('div');
      lbl.className = 'nb-pitch-label';
      lbl.style.height = ED_PITCH_ROW_H + 'px';
      lbl.textContent = pcToName(midi%12) + (Math.floor(midi/12)-1);
      sidebar.appendChild(lbl);
    });
    const chordLbl = document.createElement('div');
    chordLbl.className = 'nb-pitch-label';
    chordLbl.style.height = ED_CHORD_ROW_H + 'px';
    chordLbl.style.borderTop = '1px solid rgba(255,255,255,0.1)';
    chordLbl.textContent = 'CHRD';
    sidebar.appendChild(chordLbl);
  }
}

// ── PLAYBACK ──
async function edTogglePlay(isExport = false) {
  const btn = document.getElementById('edPlayBtn');
  
  if (!isExport) {
    if (Tone.Transport.state === 'started') {
      Tone.Transport.pause();
      btn.textContent = '▶ play';
      btn.classList.remove('playing');
      return null;
    } else if (Tone.Transport.state === 'paused') {
      Tone.Transport.start();
      btn.textContent = '❚❚ pause';
      btn.classList.add('playing');
      return null;
    }
  }

  // Need to completely schedule and start from zero (or export)
  stopEdPlayback();
  await Tone.start();
  
  if (isExport) {
    if(!edRecorder) edRecorder = new Tone.Recorder();
  } else {
    btn.textContent = '❚❚ pause';
    btn.classList.add('playing');
  }

  let chordHandle, melodyHandle;
  try {
    chordHandle  = await loadSampler(chordInstrument);
    melodyHandle = await loadMelodySampler(melodyInstrument);
  } catch(e) {
    stopEdPlayback();
    return null;
  }

  const chordGain     = chordHandle.gain;
  const melGain       = melodyHandle.gain;
  
  const reverbCfg = edScaleResult.scale && edScaleResult.scale.reverb;
  const recommendedReverb = reverbCfg || { decay: 1.2, wet: 0.18 };
  const targetWet = recommendedReverb.wet * (globalReverbAmount / 0.18);

  const reverb  = new Tone.Reverb({ decay: recommendedReverb.decay, wet: Math.min(1.0, targetWet), preDelay: 0.02 });
  const chordEQ = new Tone.EQ3({ low: 2, mid: -1, high: -4 });
  const melEQ   = new Tone.EQ3({ low: -2, mid: 1, high: -2 });

  await reverb.generate();

  chordGain.disconnect();
  melGain.disconnect();
  chordGain.gain.value = 0.45;
  melGain.gain.value   = 1.1;
  chordGain.connect(chordEQ);
  chordEQ.connect(reverb);
  melGain.connect(melEQ);
  melEQ.connect(reverb);
  
  if (isExport) {
    reverb.connect(edRecorder);
    reverb.toDestination();
    edRecorder.start();
  } else {
    reverb.toDestination();
  }

  const cleanup = () => {
    try { chordGain.disconnect(); melGain.disconnect(); } catch(e){}
    try { chordEQ.dispose(); melEQ.dispose(); reverb.dispose(); } catch(e){}
    try {
      chordGain.gain.value = 1.0;
      melGain.gain.value   = 1.0;
      chordGain.toDestination();
      melGain.toDestination();
    } catch(e){}
  };

  Tone.Transport.bpm.value = Math.max(40, Math.min(240, edBpm));
  const secPerBeat = 60 / Tone.Transport.bpm.value;
  const barLen     = secPerBeat * 4;
  const pseudoRand = (seed) => ((Math.sin(seed * 9301 + 49297) * 0.5 + 0.5));

  // Schedule Chords
  edBars.forEach((bar, i) => {
    const tStart = bar.beatOffset; // beats
    if (chordHandle.isDrum) {
      for(let b=0; b<4; b++){
        Tone.Transport.schedule((time) => { chordHandle.drumSynth.kick.triggerAttackRelease("C1", "8n", time); }, `+0:0:${(tStart+b)*4}`);
        Tone.Transport.schedule((time) => { chordHandle.drumSynth.hat.triggerAttackRelease("32n", time, 0.4); }, `+0:0:${(tStart+b)*4 + 2}`);
      }
    } else {
      const chordSampler = chordHandle.sampler;
      const bassNote = Tone.Frequency(bar.root + 36, 'midi').toNote();
      const midNotes = bar.intervals.map(o => Tone.Frequency(bar.root + 48 + (o >= 12 ? o - 12 : o), 'midi').toNote());
      const coreIntervals = bar.intervals.slice(0, 3);
      const upperNotes = [
        ...coreIntervals.slice(1).map(o => Tone.Frequency(bar.root + 60 + o, 'midi').toNote()),
        Tone.Frequency(bar.root + 72, 'midi').toNote(),
      ];
      Tone.Transport.schedule((time) => {
        chordSampler.triggerAttackRelease(bassNote, barLen * 0.93, time);
        midNotes.forEach((note, j) => chordSampler.triggerAttackRelease(note, barLen * 0.93, time + j * (0.018 + pseudoRand(i*10+j)*0.012)));
        upperNotes.forEach((note, j) => chordSampler.triggerAttackRelease(note, barLen * 0.55, time + 0.04 + j * (0.015 + pseudoRand(i*20+j)*0.01)));
      }, `+0:0:${tStart * 4}`);
    }
  });

  // Schedule Melody
  edPitches.forEach(p => {
    const tStart = p.beat; // beats
    const durRaw = p.dur ?? 1;
    const durBeatFraction = durRaw * 4; // sixteenths
    Tone.Transport.schedule((time) => {
      if(melodyHandle.isDrum){
        melodyHandle.drumSynth.hat.triggerAttackRelease("16n", time);
      } else {
        const d = Math.min(durRaw * secPerBeat * 0.9, barLen);
        melodyHandle.sampler.triggerAttackRelease(Tone.Frequency(p.midi, 'midi').toNote(), d, time);
      }
    }, `+0:0:${tStart * 4}`);
  });

  const totalBeats = getEdTotalBeats();
  Tone.Transport.schedule((time) => {
    Tone.Draw.schedule(() => {
      stopEdPlayback();
      cleanup();
    }, time);
  }, `+0:0:${totalBeats * 4}`);

  Tone.Transport.start();

  if (isExport) {
    return new Promise(resolve => {
      setTimeout(async () => {
        const recording = await edRecorder.stop();
        cleanup();
        resolve(recording);
      }, ((totalBeats * secPerBeat) + 2) * 1000);
    });
  }
}

function stopEdPlayback() {
  Tone.Transport.stop();
  Tone.Transport.cancel();
  
  const btn = document.getElementById('edPlayBtn');
  if(btn) {
    btn.classList.remove('playing');
    btn.textContent = '▶ play';
  }
  requestAnimationFrame(edDrawRoll);
}

// ── DOM BINDINGS ──
document.addEventListener('DOMContentLoaded', () => {

  document.getElementById('editorBackBtn').addEventListener('click', () => {
    stopEdPlayback();
    showScreen('results');
  });

  document.getElementById('edPlayBtn').addEventListener('click', () => {
    edTogglePlay();
  });

  document.getElementById('edBpmDown').addEventListener('click', () => {
    edBpm = Math.max(40, edBpm - 5);
    updateEdUI();
  });

  document.getElementById('edBpmUp').addEventListener('click', () => {
    edBpm = Math.min(240, edBpm + 5);
    updateEdUI();
  });

  document.getElementById('editorExportBtn').addEventListener('click', async () => {
    const btn = document.getElementById('editorExportBtn');
    btn.textContent = '⤓ exporting...';
    btn.disabled = true;
    
    stopEdPlayback();
    
    const secPerBeat = 60/edBpm;
    const dur = (getEdTotalBeats() * secPerBeat).toFixed(1);
    document.getElementById('edPlayStatus').textContent = `Rendering audio (${dur}s)... please wait`;
    
    try {
      const blob = await edTogglePlay(true);
      if (blob) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.download = "MelodyMatch_Export.wav";
        anchor.href = url;
        anchor.click();
        URL.revokeObjectURL(url);
        document.getElementById('edPlayStatus').textContent = `Export complete!`;
      } else {
        document.getElementById('edPlayStatus').textContent = `Export failed.`;
      }
    } catch (e) {
      console.error(e);
      document.getElementById('edPlayStatus').textContent = `Export failed.`;
    }
    
    btn.textContent = '⤓ export audio';
    btn.disabled = false;
    setTimeout(() => { document.getElementById('edPlayStatus').textContent = ''; }, 4000);
  });

});
