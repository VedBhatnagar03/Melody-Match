/* ───────────────────────────────────────────────
   MUSIC THEORY  —  scale matching, chord scoring,
   progression building, BPM estimation
   Depends on: constants.js
─────────────────────────────────────────────── */

/* ───────────────────────────────────────────────
   PROGRESSION PREFERENCES
─────────────────────────────────────────────── */
const SCALE_PROGRESSIONS = {
  major: [
    [0, 7, 9, 5],
    [0, 5, 7, 0],
    [0, 9, 5, 7],
    [0, 5, 9, 7],
    [0, 7, 5],
  ],
  natural_minor: [
    [0, 8, 3, 10],
    [0, 10, 8, 7],
    [0, 5, 7, 0],
    [0, 8, 10, 3],
    [0, 3, 10, 8],
  ],
  dorian: [
    [0, 5, 0, 7],
    [0, 5, 2, 7],
    [0, 2, 5, 7],
    [0, 10, 5, 7],
  ],
  phrygian: [
    [0, 1, 0, 1],
    [0, 1, 10, 0],
    [0, 8, 1, 0],
  ],
  lydian: [
    [0, 2, 0, 7],
    [0, 2, 7, 0],
    [0, 7, 2, 5],
    [0, 9, 2, 7],
  ],
  mixolydian: [
    [0, 10, 5, 0],
    [0, 5, 10, 0],
    [0, 10, 0, 5],
  ],
  harmonic_minor: [
    [0, 5, 7, 0],
    [0, 8, 7, 0],
    [0, 3, 7, 0],
    [0, 5, 8, 7],
  ],
  blues: [
    [0, 5, 0, 7],
    [0, 5, 7, 5],
    [0, 0, 5, 5],
  ],
  pentatonic_minor: [
    [0, 3, 10, 0],
    [0, 7, 3, 10],
    [0, 10, 3, 7],
  ],
  pentatonic_major: [
    [0, 7, 9, 0],
    [0, 5, 7, 0],
    [0, 9, 5, 7],
  ],
  whole_tone: [
    [0, 2, 4, 2],
    [0, 4, 2, 0],
  ],
  diminished: [
    [0, 3, 0, 7],
    [0, 6, 3, 9],
    [0, 3, 6, 9],
  ],
  phrygian_dominant: [
    [0, 1, 0, 1],
    [0, 1, 5, 0],
    [0, 8, 1, 0],
  ],
  hungarian_minor: [
    [0, 6, 7, 0],
    [0, 5, 7, 0],
    [0, 8, 6, 7],
  ],
  japanese: [
    [0, 1, 0, 7],
    [0, 7, 1, 0],
    [0, 1, 7, 0],
  ],
};

// Given the sequence of chord roots chosen so far, return a bonus for the next chord
// if it continues a known progression pattern for this scale.
function progressionBonus(scaleKey, chosenRoots, candidateRoot, scaleRoot) {
  const progs = SCALE_PROGRESSIONS[scaleKey];
  if (!progs) return 0;

  let bonus = 0;
  const toRelative = r => ((r - scaleRoot + 12) % 12);
  const chosen = chosenRoots.map(toRelative);
  const candidate = toRelative(candidateRoot);

  for (const prog of progs) {
    if (chosenRoots.length === 0) {
      if (candidate === prog[0]) bonus = Math.max(bonus, 1);
      continue;
    }
    for (let matchLen = Math.min(chosen.length, prog.length - 1); matchLen >= 1; matchLen--) {
      const tail = chosen.slice(-matchLen);
      const progSlice = prog.slice(0, matchLen);
      const next = prog[matchLen];
      if (tail.every((v, i) => v === progSlice[i]) && candidate === next) {
        const progPriority = 1 - (progs.indexOf(prog) / progs.length) * 0.3;
        bonus = Math.max(bonus, Math.round(matchLen * 4 * progPriority));
        break;
      }
    }
  }
  return bonus;
}

// Build diatonic chords for a scale, with extended voicings per scale flavour.
function getDiatonicChords(scaleProfile, scaleRoot, scaleKey) {
  const scalePcs = [];
  for (let i = 0; i < 12; i++) {
    if (scaleProfile[i]) scalePcs.push((scaleRoot + i) % 12);
  }
  const flavours = SCALE_CHORD_FLAVOURS[scaleKey] || {};

  return scalePcs.map(r => {
    const above = scalePcs.map(p => ((p - r + 12) % 12)).filter(d => d > 0).sort((a,b) => a-b);
    const third = above.find(d => d >= 3 && d <= 4) ?? 4;
    const fifth = above.find(d => d >= 6 && d <= 8) ?? 7;
    const baseQuality = third === 3 ? (fifth === 6 ? 'dim' : 'min') : (fifth === 8 ? 'aug' : 'maj');

    const degree = (r - scaleRoot + 12) % 12;
    const flavourKey = flavours[degree];
    const chordType = (flavourKey && CHORD_TYPES[flavourKey]) ? flavourKey : baseQuality;
    const intervals = CHORD_TYPES[chordType] || [0, third, fifth];

    return { root: r, intervals, quality: chordType };
  });
}

// Score how well a chord fits notes in a bar.
function scoreChord(chordRoot, chordIntervals, notePcs, firstNotePc) {
  const chordPcs = new Set(chordIntervals.map(i => (chordRoot + i) % 12));

  const uniquePcs = [...new Set(notePcs)];
  let matches = 0;
  for (const pc of uniquePcs) {
    if (chordPcs.has(pc)) matches++;
  }
  const coverageScore = (matches / Math.max(uniquePcs.length, 1)) * 6;
  const firstNoteBonus = (firstNotePc !== undefined && chordPcs.has(firstNotePc)) ? 3 : 0;
  const rootBonus = uniquePcs.includes(chordRoot) ? 1 : 0;

  return coverageScore + firstNoteBonus + rootBonus;
}

// Estimate BPM from inter-onset intervals
function estimateBpm(pitches) {
  if (pitches.length < 3) return 100;
  const intervals = [];
  for (let i = 1; i < pitches.length; i++) {
    const d = pitches[i].time - pitches[i-1].time;
    if (d > 80 && d < 2000) intervals.push(d);
  }
  if (intervals.length < 2) return 100;
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  return Math.max(60, Math.min(160, Math.round(60000 / median)));
}

function buildBarChords(pitches, scaleProfile, scaleRoot, fixedBpm, scaleKey) {
  if (pitches.length < 2) return null;

  const bpm = fixedBpm != null ? fixedBpm : estimateBpm(pitches);
  const msPerBeat = 60000 / bpm;
  const msPerBar  = msPerBeat * 4;

  const diatonic = getDiatonicChords(scaleProfile, scaleRoot, scaleKey);

  const t0 = pitches[0].time;
  const totalMs = pitches[pitches.length - 1].time - t0 + msPerBar;
  const numBars = (fixedBpm != null)
    ? nbBars
    : Math.max(2, Math.min(8, Math.round(totalMs / msPerBar)));

  const firstNoteBeatOffset = (fixedBpm != null && pitches[0].beat != null)
    ? (pitches[0].beat % 4)
    : 0;
  const firstNoteSecOffset = firstNoteBeatOffset * (msPerBeat / 1000);

  const bar0Start = t0 - firstNoteSecOffset * 1000;
  const REPEAT_PENALTY = 3;

  const barChords = [];
  const chosenRoots = [];

  for (let b = 0; b < numBars; b++) {
    const barStart = bar0Start + b * msPerBar;
    const barEnd   = barStart + msPerBar;
    const barNotes = pitches.filter(n => n.time >= barStart && n.time < barEnd);
    const notePcs  = barNotes.map(n => n.pc);
    const firstPc  = barNotes.length > 0 ? barNotes[0].pc : undefined;

    if (notePcs.length === 0) {
      const prevRoot = chosenRoots.length > 0 ? chosenRoots[chosenRoots.length - 1] : -1;
      let best = diatonic[0], bestScore = -Infinity;
      for (const chord of diatonic) {
        let sc = progressionBonus(scaleKey, chosenRoots, chord.root, scaleRoot);
        if (chord.root === prevRoot) sc -= REPEAT_PENALTY;
        if (sc > bestScore) { bestScore = sc; best = chord; }
      }
      barChords.push({ ...best });
      chosenRoots.push(best.root);
      continue;
    }

    const prevRoot = chosenRoots.length > 0 ? chosenRoots[chosenRoots.length - 1] : -1;
    let best = diatonic[0], bestScore = -Infinity;
    for (const chord of diatonic) {
      let sc = scoreChord(chord.root, chord.intervals, notePcs, firstPc);
      if (chord.root === prevRoot) sc -= REPEAT_PENALTY;
      sc += progressionBonus(scaleKey, chosenRoots, chord.root, scaleRoot);
      if (sc > bestScore) { bestScore = sc; best = chord; }
    }
    barChords.push({ ...best });
    chosenRoots.push(best.root);
  }

  return { bars: barChords, bpm, firstNoteSecOffset };
}

// Convert a raw degree-offset progression into bar objects for a given scale/root.
function buildProgBars(degreeOffsets, scaleProfile, scaleRoot, numBars, scaleKey) {
  const diatonic = getDiatonicChords(scaleProfile, scaleRoot, scaleKey);
  const progChords = degreeOffsets.map(deg => {
    const targetRoot = (scaleRoot + deg) % 12;
    return diatonic.find(c => c.root === targetRoot) || diatonic[0];
  });
  return Array.from({ length: numBars }, (_, i) => ({ ...progChords[i % progChords.length] }));
}

/* ───────────────────────────────────────────────
   SCALE MATCHING
─────────────────────────────────────────────── */
function rankScales(pitchClasses) {
  const counts = new Array(12).fill(0);
  pitchClasses.forEach(pc => counts[((pc % 12) + 12) % 12]++);
  const total = pitchClasses.length || 1;

  return SCALES.map(scale => {
    let bestScore = 0, bestRoot = 0;
    for (let root = 0; root < 12; root++) {
      let score = 0;
      for (let pc = 0; pc < 12; pc++) {
        score += counts[pc] * scale.profile[((pc - root + 12) % 12)];
      }
      if (score > bestScore) { bestScore = score; bestRoot = root; }
    }
    return { scale, root: bestRoot, score: bestScore };
  }).sort((a, b) => b.score - a.score);
}
