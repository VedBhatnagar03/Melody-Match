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
// Drum toggles — each type independently on/off
const drumEnabled = { kick: false, snare: false, hat: false, clap: false };
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

let drumSynthCache = null;
function loadDrums() {
  if (drumSynthCache) return drumSynthCache;
  const gain = new Tone.Gain(0.7).toDestination();
  drumSynthCache = {
    gain,
    kick:  new Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 6, envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 } }).connect(gain),
    snare: new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.05 } }).connect(gain),
    hat:   new Tone.MetalSynth({ frequency: 400, envelope: { attack: 0.001, decay: 0.08, release: 0.01 }, harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5 }).connect(gain),
    clap:  new Tone.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.005, decay: 0.1, sustain: 0, release: 0.05 } }).connect(gain),
  };
  return drumSynthCache;
}

function stopPlayback() {
  playGeneration++;
  Tone.Transport.stop();
  Tone.Transport.cancel();
  if (drumSynthCache) {
    try { drumSynthCache.gain.disconnect(); } catch(e){}
    drumSynthCache = null;
  }
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

  let chordHandle, melodyHandle, rawPlayer;
  try {
    chordHandle  = await loadSampler(chordInstrument);
    melodyHandle = await loadMelodySampler(melodyInstrument);
    
    if (typeof rawAudioBlob !== 'undefined' && rawAudioBlob && pitchSource === 'mic') {
      const rawMicVol = document.getElementById('rawMicSlider') ? parseInt(document.getElementById('rawMicSlider').value) / 100 : 0.8;
      if (rawMicVol > 0) {
        await new Promise(resolve => {
          rawPlayer = new Tone.Player({
            url: URL.createObjectURL(rawAudioBlob),
            onload: resolve,
            onerror: resolve
          }).toDestination();
        });
        if (rawPlayer.loaded) {
          rawPlayer.volume.value = Tone.gainToDb(Math.max(0.01, rawMicVol * 0.7));
        } else {
          rawPlayer = null;
        }
      }
    }
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

  const chordGain = chordHandle.gain;
  const melGain   = melodyHandle.gain;

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
    { releaseAll: () => { try { chordHandle.sampler.releaseAll(); } catch(e){} } },
    { releaseAll: () => { try { melodyHandle.sampler.releaseAll(); } catch(e){} } },
    { releaseAll: () => {
        try { if (rawPlayer) rawPlayer.dispose(); } catch(e){}
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

  // CHORDS — all times in seconds from Transport start
  bars.forEach((bar, i) => {
    const tStartSec = i * barLen;
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
    }, `+${tStartSec}`);
  });

  // DRUMS — each type scheduled independently based on drumEnabled toggles
  const anyDrumOn = Object.values(drumEnabled).some(Boolean);
  if (anyDrumOn) {
    const drums = loadDrums();
    // Reconnect drum gain through reverb for this playback session
    drums.gain.disconnect();
    drums.gain.connect(reverb);
    activeSynths.push({ releaseAll: () => {
      try { drums.gain.disconnect(); drums.gain.toDestination(); } catch(e){}
    }});

    const totalBars = bars.length;
    for (let i = 0; i < totalBars; i++) {
      for (let b = 0; b < 4; b++) {
        const beatSec = i * barLen + b * secPerBeat;

        // Kick: downbeat (beat 1) + beat 3 of every bar
        if (drumEnabled.kick) {
          if (b === 0 || b === 2) {
            Tone.Transport.schedule((time) => {
              drums.kick.triggerAttackRelease('C1', '8n', time);
            }, `+${beatSec}`);
          }
        }

        // Snare: backbeats (beats 2 and 4)
        if (drumEnabled.snare) {
          if (b === 1 || b === 3) {
            Tone.Transport.schedule((time) => {
              drums.snare.triggerAttackRelease('8n', time);
            }, `+${beatSec}`);
          }
        }

        // Hi-hat: every 8th note (twice per beat)
        if (drumEnabled.hat) {
          Tone.Transport.schedule((time) => {
            drums.hat.triggerAttackRelease('32n', time);
          }, `+${beatSec}`);
          Tone.Transport.schedule((time) => {
            drums.hat.triggerAttackRelease('32n', time);
          }, `+${beatSec + secPerBeat * 0.5}`);
        }

        // Clap: same as snare (backbeats) but can layer or be used alone
        if (drumEnabled.clap) {
          if (b === 1 || b === 3) {
            Tone.Transport.schedule((time) => {
              drums.clap.triggerAttackRelease('16n', time);
            }, `+${beatSec}`);
          }
        }
      }
    }
  }

  // MELODY — all times in seconds from Transport start
  if (melodyEnabled && detectedPitches.length > 0) {
    if (pitchSource === 'builder') {
      // Notes have exact beat positions — convert beats → seconds.
      // Add firstNoteSecOffset so the melody aligns with the chord bar grid
      // (chords start at Transport 0 = bar 0 start, which is firstNoteSecOffset
      // seconds before the first note when the first note falls mid-bar).
      detectedPitches.forEach(p => {
        const noteSec = p.beat * secPerBeat + (firstNoteSecOffset || 0);
        const dur = Math.min((p.dur ?? 1) * secPerBeat * 0.9, bars.length * barLen);
        Tone.Transport.schedule((time) => {
          melodyHandle.sampler.triggerAttackRelease(Tone.Frequency(p.midi, 'midi').toNote(), dur, time);
        }, `+${Math.max(0, noteSec)}`);
      });
    } else {
      // Mic path — notes have real timestamps; scale them to fill the total bar length.
      const t0ms     = detectedPitches[0].time;
      const lastNote = detectedPitches[detectedPitches.length - 1];
      const spanMs   = Math.max(1, (lastNote.time + (lastNote.dur ?? 1) * secPerBeat * 1000) - t0ms);
      const totalSec = bars.length * barLen;
      const timeScale = totalSec / (spanMs / 1000);

      // Play raw mic audio scaled to match
      if (rawPlayer && rawPlayer.loaded) {
        rawPlayer.playbackRate = 1 / timeScale;
        rawPlayer.connect(reverb);
        Tone.Transport.schedule((time) => {
          rawPlayer.start(time, t0ms / 1000);
        }, `+0`);
      }

      detectedPitches.forEach(p => {
        const relSec = ((p.time - t0ms) / 1000) * timeScale;
        const dur    = Math.min((p.dur ?? 0.5) * secPerBeat * timeScale * 0.88, barLen * 0.95);
        Tone.Transport.schedule((time) => {
          melodyHandle.sampler.triggerAttackRelease(Tone.Frequency(p.midi, 'midi').toNote(), Math.max(0.05, dur), time);
        }, `+${Math.max(0, relSec)}`);
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
