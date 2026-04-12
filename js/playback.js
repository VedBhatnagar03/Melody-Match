/* ───────────────────────────────────────────────
   TONE.JS PLAYBACK
   Depends on: constants.js, audio.js (detectedPitches, pitchSource)
─────────────────────────────────────────────── */

let activeSynths = [];
let playingIdx = -1;
let playGeneration = 0;
let selectedInstrument = 'piano';
let melodyEnabled = true;
const samplerCache = {};
const melodySamplerCache = {};

function loadSampler(instKey) {
  if (samplerCache[instKey]) return samplerCache[instKey];
  const cfg = INSTRUMENTS[instKey];
  const promise = new Promise(resolve => {
    const gain = new Tone.Gain(1).toDestination();
    const s = new Tone.Sampler(cfg.notes, {
      baseUrl: cfg.url,
      release: cfg.release,
      onload: () => resolve({ sampler: s, gain }),
    }).connect(gain);
    s.volume.value = cfg.volume;
  });
  samplerCache[instKey] = promise;
  return promise;
}

function loadMelodySampler(instKey) {
  if (melodySamplerCache[instKey]) return melodySamplerCache[instKey];
  const cfg = INSTRUMENTS[instKey];
  const promise = new Promise(resolve => {
    const gain = new Tone.Gain(1).toDestination();
    const s = new Tone.Sampler(cfg.notes, {
      baseUrl: cfg.url,
      release: cfg.release,
      onload: () => resolve({ sampler: s, gain }),
    }).connect(gain);
    s.volume.value = cfg.volume + 2;
  });
  melodySamplerCache[instKey] = promise;
  return promise;
}

function stopPlayback() {
  playGeneration++;
  activeSynths.forEach(s => { try { s.releaseAll ? s.releaseAll() : null; } catch(e){} });
  activeSynths = [];
  playingIdx = -1;
  document.querySelectorAll('.play-btn').forEach(b => {
    b.classList.remove('playing');
    b.textContent = '▶  play';
    b.disabled = false;
  });
  document.querySelectorAll('.alt-play-btn').forEach(b => {
    b.classList.remove('playing');
    b.textContent = '▶';
  });
}

async function playSuggestion(result, detectedPitches, bars, bpm, firstNoteSecOffset, btnEl, idx) {
  if (playingIdx === idx) { stopPlayback(); return; }
  stopPlayback();

  await Tone.start();
  playingIdx = idx;
  btnEl.classList.add('playing');
  btnEl.textContent = '⟳  loading...';
  btnEl.disabled = true;

  let chordHandle, melodyHandle;
  try {
    chordHandle  = await loadSampler(selectedInstrument);
    melodyHandle = await loadMelodySampler(selectedInstrument);
  } catch(e) {
    btnEl.classList.remove('playing');
    btnEl.textContent = '▶  play';
    btnEl.disabled = false;
    playingIdx = -1;
    return;
  }

  if (playingIdx !== idx) return;

  btnEl.textContent = '■  stop';
  btnEl.disabled = false;

  const chordSampler  = chordHandle.sampler;
  const melSampler    = melodyHandle.sampler;
  const chordGain     = chordHandle.gain;
  const melGain       = melodyHandle.gain;

  const reverbCfg = result.scale && result.scale.reverb;
  const effectiveReverb = reverbCfg || { decay: 1.2, wet: 0.18 };

  const reverb  = new Tone.Reverb({ decay: effectiveReverb.decay, wet: effectiveReverb.wet, preDelay: 0.02 });
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
  reverb.toDestination();

  activeSynths = [
    { releaseAll: () => { try { chordSampler.releaseAll(); } catch(e){} } },
    { releaseAll: () => { try { melSampler.releaseAll();   } catch(e){} } },
    { releaseAll: () => {
        try { chordGain.disconnect(); melGain.disconnect(); } catch(e){}
        try { chordEQ.dispose(); melEQ.dispose(); reverb.dispose(); } catch(e){}
        try {
          chordGain.gain.value = 1.0;
          melGain.gain.value   = 1.0;
          chordGain.toDestination();
          melGain.toDestination();
        } catch(e){}
    }},
  ];

  const secPerBeat = 60 / Math.max(40, Math.min(240, bpm));
  const barLen     = secPerBeat * 4;
  const totalLen   = bars.length * barLen;
  const now        = Tone.now() + 0.05;
  const gen        = playGeneration;

  const trigger = (sampler, note, dur, time) => {
    const delay = Math.max(0, (time - Tone.now()) * 1000);
    setTimeout(() => {
      if (playGeneration !== gen) return;
      sampler.triggerAttackRelease(note, dur, Tone.now() + 0.01);
    }, delay);
  };

  const pseudoRand = (seed) => ((Math.sin(seed * 9301 + 49297) * 0.5 + 0.5));

  bars.forEach((bar, i) => {
    const t = now + i * barLen;

    const bassNote = Tone.Frequency(bar.root + 36, 'midi').toNote();

    const midNotes = bar.intervals.map(o => {
      const midi = bar.root + 48 + (o >= 12 ? o - 12 : o);
      return Tone.Frequency(midi, 'midi').toNote();
    });

    const coreIntervals = bar.intervals.slice(0, 3);
    const upperNotes = [
      ...coreIntervals.slice(1).map(o => Tone.Frequency(bar.root + 60 + o, 'midi').toNote()),
      Tone.Frequency(bar.root + 72, 'midi').toNote(),
    ];

    const holdDur = barLen * 0.93;

    trigger(chordSampler, bassNote, holdDur, t);

    midNotes.forEach((note, j) => {
      const strum = j * (0.018 + pseudoRand(i * 10 + j) * 0.012);
      trigger(chordSampler, note, holdDur, t + strum);
    });

    upperNotes.forEach((note, j) => {
      const strum = 0.04 + j * (0.015 + pseudoRand(i * 20 + j) * 0.01);
      trigger(chordSampler, note, holdDur * 0.55, t + strum);
    });
  });

  // --- Melody ---
  if (melodyEnabled && detectedPitches.length > 0) {
    if (pitchSource === 'builder') {
      detectedPitches.forEach(p => {
        const relSec = p.beat * secPerBeat;
        const dur    = Math.min((p.dur ?? 1) * secPerBeat * 0.9, barLen);
        trigger(melSampler, Tone.Frequency(p.midi, 'midi').toNote(), dur, now + relSec);
      });
    } else {
      const t0ms     = detectedPitches[0].time;
      const lastNote = detectedPitches[detectedPitches.length - 1];
      const spanMs   = Math.max(1, (lastNote.time + (lastNote.dur ?? 1) * 1000 * secPerBeat) - t0ms);
      const totalSec = bars.length * barLen;
      const scale    = totalSec / (spanMs / 1000);

      detectedPitches.forEach(p => {
        const relSec = ((p.time - t0ms) / 1000) * scale;
        const rawDurSec = (p.dur ?? 0.5) * secPerBeat;
        const dur = Math.min(rawDurSec * scale * 0.88, barLen * 0.95);
        trigger(melSampler, Tone.Frequency(p.midi, 'midi').toNote(), Math.max(0.05, dur), now + relSec);
      });
    }
  }

  setTimeout(() => {
    if (playingIdx === idx) stopPlayback();
  }, (totalLen + 2.5) * 1000);
}
