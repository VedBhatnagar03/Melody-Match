/* ───────────────────────────────────────────────
   TONE.JS PLAYBACK
   Depends on: constants.js, audio.js (detectedPitches, pitchSource)
─────────────────────────────────────────────── */

let activeSynths = [];
let playingIdx = -1;
let playGeneration = 0;
let melodyInstrument = 'piano';
let chordInstrument = 'piano';
let melodyEnabled = true;
let globalReverbAmount = 0.18;
const samplerCache = {};
const melodySamplerCache = {};

function loadSampler(instKey) {
  if (samplerCache[instKey]) return samplerCache[instKey];
  const cfg = INSTRUMENTS[instKey];
  const promise = new Promise(resolve => {
    const gain = new Tone.Gain(1).toDestination();
    
    if (cfg && cfg.isDrum) {
      const kick = new Tone.MembraneSynth().connect(gain);
      const hat = new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 0.1, release: 0.01 } }).connect(gain);
      gain.gain.value = 0.5;
      resolve({ isDrum: true, drumSynth: { kick, hat }, gain });
      return;
    }
    
    const s = new Tone.Sampler(cfg.notes, {
      baseUrl: cfg.url,
      release: cfg.release,
      onload: () => resolve({ sampler: s, gain }),
      onerror: () => {
        console.warn('Playback failed to load', instKey, 'CDN. Using generic poly synth fallback.');
        const fallback = new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'triangle' } }).connect(gain);
        resolve({ sampler: fallback, gain });
      }
    }).connect(gain);
    if (s.volume) s.volume.value = cfg.volume;
  });
  samplerCache[instKey] = promise;
  return promise;
}

function loadMelodySampler(instKey) {
  if (melodySamplerCache[instKey]) return melodySamplerCache[instKey];
  const cfg = INSTRUMENTS[instKey];
  const promise = new Promise(resolve => {
    const gain = new Tone.Gain(1).toDestination();
    
    if (cfg && cfg.isDrum) {
      const kick = new Tone.MembraneSynth().connect(gain);
      const hat = new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 0.1, release: 0.01 } }).connect(gain);
      gain.gain.value = 0.6;
      resolve({ isDrum: true, drumSynth: { kick, hat }, gain });
      return;
    }

    const s = new Tone.Sampler(cfg.notes, {
      baseUrl: cfg.url,
      release: cfg.release,
      onload: () => resolve({ sampler: s, gain }),
      onerror: () => {
        console.warn('Playback failed to load', instKey, 'CDN. Using generic synth fallback.');
        const fallback = new Tone.PolySynth(Tone.Synth).connect(gain);
        resolve({ sampler: fallback, gain });
      }
    }).connect(gain);
    if (s.volume) s.volume.value = cfg.volume + 2;
  });
  melodySamplerCache[instKey] = promise;
  return promise;
}

function stopPlayback() {
  playGeneration++;
  Tone.Transport.stop();
  Tone.Transport.cancel();
  activeSynths.forEach(s => { try { s.releaseAll ? s.releaseAll() : null; } catch(e){} });
  activeSynths = [];
  playingIdx = -1;
  document.querySelectorAll('.play-btn').forEach(b => {
    b.classList.remove('playing');
    b.classList.remove('paused');
    b.textContent = '▶  play';
    b.disabled = false;
  });
  document.querySelectorAll('.alt-play-btn').forEach(b => {
    b.classList.remove('playing');
    b.classList.remove('paused');
    b.textContent = '▶';
  });
}

function togglePlayPause(btnEl, isAlt = false) {
  if (Tone.Transport.state === 'started') {
    Tone.Transport.pause();
    btnEl.classList.add('paused');
    btnEl.textContent = isAlt ? '❚❚' : '❚❚ pause';
  } else if (Tone.Transport.state === 'paused') {
    Tone.Transport.start();
    btnEl.classList.remove('paused');
    btnEl.textContent = isAlt ? '■' : '■  stop';
  }
}

async function playSuggestion(result, detectedPitches, bars, bpm, firstNoteSecOffset, btnEl, idx) {
  const isAlt = btnEl.classList.contains('alt-play-btn');
  
  if (playingIdx === idx) { 
    if (Tone.Transport.state === 'started' || Tone.Transport.state === 'paused') {
      togglePlayPause(btnEl, isAlt);
      return;
    }
  }

  stopPlayback();

  await Tone.start();
  playingIdx = idx;
  btnEl.classList.add('playing');
  btnEl.textContent = isAlt ? '...' : '⟳  loading...';
  btnEl.disabled = true;

  let chordHandle, melodyHandle;
  try {
    chordHandle  = await loadSampler(chordInstrument);
    melodyHandle = await loadMelodySampler(melodyInstrument);
  } catch(e) {
    btnEl.classList.remove('playing');
    btnEl.textContent = isAlt ? '▶' : '▶  play';
    btnEl.disabled = false;
    playingIdx = -1;
    return;
  }

  if (playingIdx !== idx) return;

  btnEl.textContent = isAlt ? '■' : '■  stop';
  btnEl.disabled = false;

  const chordGain     = chordHandle.gain;
  const melGain       = melodyHandle.gain;
  const isChordDrum   = chordHandle.isDrum;
  const isMelDrum     = melodyHandle.isDrum;

  const reverbCfg = result.scale && result.scale.reverb;
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
  reverb.toDestination();

  activeSynths = [
    { releaseAll: () => { try { if (!isChordDrum) chordHandle.sampler.releaseAll(); } catch(e){} } },
    { releaseAll: () => { try { if (!isMelDrum) melodyHandle.sampler.releaseAll();   } catch(e){} } },
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

  Tone.Transport.bpm.value = Math.max(40, Math.min(240, bpm));
  const secPerBeat = 60 / Tone.Transport.bpm.value;
  const barLen = secPerBeat * 4;
  const pseudoRand = (seed) => ((Math.sin(seed * 9301 + 49297) * 0.5 + 0.5));

  // CHORDS
  bars.forEach((bar, i) => {
    const tStart = i * 4; // in beats
    const holdDur = 4 * 0.93; // inside Transport, duration is usually handled slightly differently, we can use "2m" or just seconds. We will use absolute seconds for triggerAttackRelease but relative Time for scheduling.

    if (isChordDrum) {
      // Create a drum pattern for this bar
      for(let b=0; b<4; b++){
        Tone.Transport.schedule((time) => {
          chordHandle.drumSynth.kick.triggerAttackRelease("C1", "8n", time);
        }, `+${tStart + b}:0:0`);
        
        Tone.Transport.schedule((time) => {
          chordHandle.drumSynth.hat.triggerAttackRelease("32n", time, 0.4);
        }, `+${tStart + b}:2:0`); // offbeat
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
        midNotes.forEach((note, j) => {
          const strum = j * (0.018 + pseudoRand(i * 10 + j) * 0.012);
          chordSampler.triggerAttackRelease(note, barLen * 0.93, time + strum);
        });
        upperNotes.forEach((note, j) => {
          const strum = 0.04 + j * (0.015 + pseudoRand(i * 20 + j) * 0.01);
          chordSampler.triggerAttackRelease(note, barLen * 0.55, time + strum);
        });
      }, `+${tStart}:0:0`);
    }
  });

  // MELODY
  if (melodyEnabled && detectedPitches.length > 0) {
    if (pitchSource === 'builder') {
      detectedPitches.forEach(p => {
        const beatOffset = p.beat;
        const dur = Math.min((p.dur ?? 1) * secPerBeat * 0.9, barLen);
        Tone.Transport.schedule((time) => {
          if(isMelDrum){
            melodyHandle.drumSynth.hat.triggerAttackRelease("16n", time);
          } else {
            melodyHandle.sampler.triggerAttackRelease(Tone.Frequency(p.midi, 'midi').toNote(), dur, time);
          }
        }, `+${Math.floor(beatOffset)}:${(beatOffset%1)*4}:0`); // convert beat to bars:quarters:sixteenths loosely based on decimal
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
        Tone.Transport.schedule((time) => {
          if(isMelDrum){
            melodyHandle.drumSynth.hat.triggerAttackRelease("16n", time);
          } else {
            melodyHandle.sampler.triggerAttackRelease(Tone.Frequency(p.midi, 'midi').toNote(), Math.max(0.05, dur), time);
          }
        }, `+${relSec}`);
      });
    }
  }

  const totalLen = bars.length * barLen;
  Tone.Transport.schedule((time) => {
    Tone.Draw.schedule(() => {
      stopPlayback();
    }, time);
  }, `+${totalLen + 0.5}`);

  Tone.Transport.start();
}
