/* ───────────────────────────────────────────────
   CONSTANTS  —  shared data, no logic
─────────────────────────────────────────────── */

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const freqToMidi = f => Math.round(12 * Math.log2(f / 440) + 69);
const midiToPc   = m => ((m % 12) + 12) % 12;
const pcToName   = pc => NOTE_NAMES[((pc % 12) + 12) % 12];
const midiToNote = m => NOTE_NAMES[midiToPc(m)] + (Math.floor(m / 12) - 1);

/* ───────────────────────────────────────────────
   CHORD TYPES  (semitone offsets from root)
─────────────────────────────────────────────── */
const CHORD_TYPES = {
  // Triads
  maj:   [0,4,7],
  min:   [0,3,7],
  dim:   [0,3,6],
  aug:   [0,4,8],
  sus2:  [0,2,7],
  sus4:  [0,5,7],
  // Sevenths
  dom7:  [0,4,7,10],
  min7:  [0,3,7,10],
  maj7:  [0,4,7,11],
  minmaj7: [0,3,7,11],
  dim7:  [0,3,6,9],
  hdim7: [0,3,6,10],  // half-diminished (min7b5)
  aug7:  [0,4,8,10],
  // Sixths
  maj6:  [0,4,7,9],
  min6:  [0,3,7,9],
  // Ninths
  dom9:  [0,4,7,10,14],
  maj9:  [0,4,7,11,14],
  min9:  [0,3,7,10,14],
  // Add chords
  add9:  [0,4,7,14],
  madd9: [0,3,7,14],
  // Power
  pow:   [0,7],
};

// Human-readable suffix for each chord type
const CHORD_SUFFIXES = {
  maj: '', min: 'm', dim: '°', aug: '+',
  sus2: 'sus2', sus4: 'sus4',
  dom7: '7', min7: 'm7', maj7: 'maj7', minmaj7: 'mMaj7',
  dim7: '°7', hdim7: 'ø7', aug7: '+7',
  maj6: '6', min6: 'm6',
  dom9: '9', maj9: 'maj9', min9: 'm9',
  add9: 'add9', madd9: 'madd9',
  pow: '5',
};

// Which chord extensions each scale uses for its characteristic sound
const SCALE_CHORD_FLAVOURS = {
  major: {
    0: 'maj',
    2: 'min7',
    4: 'min7',
    5: 'maj7',
    7: 'dom7',
    9: 'min7',
    11:'hdim7',
  },
  natural_minor: {
    0: 'min',
    2: 'hdim7',
    3: 'maj',
    5: 'min7',
    7: 'min7',
    8: 'maj7',
    10:'dom7',
  },
  dorian: {
    0: 'min7',
    2: 'min7',
    3: 'maj7',
    5: 'dom7',
    7: 'min7',
    9: 'hdim7',
    10:'maj7',
  },
  phrygian: {
    0: 'min',
    1: 'maj',
    3: 'maj',
    5: 'min7',
    7: 'dim',
    8: 'maj',
    10:'min7',
  },
  lydian: {
    0: 'maj7',
    2: 'dom7',
    4: 'min7',
    6: 'hdim7',
    7: 'maj7',
    9: 'min7',
    11:'min7',
  },
  mixolydian: {
    0: 'dom7',
    2: 'min7',
    4: 'min7',
    5: 'maj',
    7: 'min7',
    9: 'hdim7',
    10:'maj',
  },
  harmonic_minor: {
    0: 'min',
    2: 'hdim7',
    3: 'aug',
    5: 'min7',
    7: 'dom7',
    8: 'maj7',
    11:'dim7',
  },
  blues: {
    0: 'dom7',
    3: 'dom7',
    5: 'dom7',
    6: 'dom7',
    7: 'dom7',
    10:'dom7',
  },
  pentatonic_minor: {
    0: 'min7',
    3: 'maj',
    5: 'sus4',
    7: 'min7',
    10:'maj',
  },
  pentatonic_major: {
    0: 'add9',
    2: 'sus2',
    4: 'sus4',
    7: 'add9',
    9: 'min7',
  },
  whole_tone: {
    0: 'aug7',
    2: 'aug7',
    4: 'aug7',
    6: 'aug7',
    8: 'aug7',
    10:'aug7',
  },
  diminished: {
    0: 'dim7',
    2: 'dim7',
    3: 'dim7',
    5: 'dim7',
    6: 'dim7',
    8: 'dim7',
    9: 'dim7',
    11:'dim7',
  },
  phrygian_dominant: {
    0: 'dom7',
    1: 'maj',
    4: 'dim',
    5: 'min7',
    7: 'min7',
    8: 'maj',
    10:'dim',
  },
  hungarian_minor: {
    0: 'min',
    2: 'hdim7',
    3: 'aug',
    6: 'dom7',
    7: 'dom7',
    8: 'maj',
    11:'dim7',
  },
  japanese: {
    0: 'min',
    1: 'maj',
    5: 'sus4',
    7: 'min',
    8: 'maj',
  },
};

/* ───────────────────────────────────────────────
   SCALE DATABASE
─────────────────────────────────────────────── */
const SCALES = [
  {
    key: 'major',
    name: 'Major',
    profile: [1,0,1,0,1,1,0,1,0,1,0,1],
    vibe: 'Happy / Uplifting',
    desc: 'Bright, resolved, the backbone of pop and folk. Feels settled and optimistic.',
    color: '#f59e0b',
    reverb: null,
    prog: { labels:['I','IV','V','I'], intervals:[0,5,7,0], qualities:['maj','maj','maj','maj'] }
  },
  {
    key: 'natural_minor',
    name: 'Natural Minor',
    profile: [1,0,1,1,0,1,0,1,1,0,1,0],
    vibe: 'Sad / Melancholic',
    desc: 'Dark and emotional — the go-to for ballads, indie, and singer-songwriter music.',
    color: '#3b82f6',
    reverb: { decay: 2.5, wet: 0.35 },
    prog: { labels:['i','♭VI','♭III','♭VII'], intervals:[0,8,3,10], qualities:['min','maj','maj','maj'] }
  },
  {
    key: 'dorian',
    name: 'Dorian',
    profile: [1,0,1,1,0,1,0,1,0,1,1,0],
    vibe: 'Funky / Cool Minor',
    desc: 'Minor but hopeful — used by Santana, Daft Punk, and modal jazz. The "cool" minor.',
    color: '#14b8a6',
    reverb: null,
    prog: { labels:['i','IV','i','V'], intervals:[0,5,0,7], qualities:['min','maj','min','maj'] }
  },
  {
    key: 'phrygian',
    name: 'Phrygian',
    profile: [1,1,0,1,0,1,0,1,1,0,1,0],
    vibe: 'Tense / Exotic',
    desc: 'Spanish and flamenco flavour — dark, tense, and intense. Great for drama.',
    color: '#ef4444',
    reverb: { decay: 1.5, wet: 0.2 },
    prog: { labels:['i','♭II','i','♭II'], intervals:[0,1,0,1], qualities:['min','maj','min','maj'] }
  },
  {
    key: 'lydian',
    name: 'Lydian',
    profile: [1,0,1,0,1,0,1,1,0,1,0,1],
    vibe: 'Dreamy / Cinematic',
    desc: 'Bright and floating but unresolved — John Williams, film scores, otherworldly.',
    color: '#a78bfa',
    reverb: { decay: 4.0, wet: 0.5 },
    prog: { labels:['I','II','I','V'], intervals:[0,2,0,7], qualities:['maj','maj','maj','maj'] }
  },
  {
    key: 'mixolydian',
    name: 'Mixolydian',
    profile: [1,0,1,0,1,1,0,1,0,1,1,0],
    vibe: 'Anthemic / Rootsy',
    desc: 'Major with a flatted 7th — Beatles, Grateful Dead, classic rock. Feels epic.',
    color: '#22c55e',
    reverb: null,
    prog: { labels:['I','♭VII','IV','I'], intervals:[0,10,5,0], qualities:['maj','maj','maj','maj'] }
  },
  {
    key: 'harmonic_minor',
    name: 'Harmonic Minor',
    profile: [1,0,1,1,0,1,0,1,1,0,0,1],
    vibe: 'Dramatic / Classical',
    desc: 'Minor with a raised 7th — sweeping, cinematic, "villain" energy. Bach loved this.',
    color: '#f97316',
    reverb: { decay: 3.0, wet: 0.4 },
    prog: { labels:['i','iv','V','i'], intervals:[0,5,7,0], qualities:['min','min','maj','min'] }
  },
  {
    key: 'blues',
    name: 'Blues',
    profile: [1,0,0,1,0,1,1,1,0,0,1,0],
    vibe: 'Gritty / Soulful',
    desc: 'Raw, expressive swagger. BB King, Hendrix, SRV. That flat 5 is everything.',
    color: '#ec4899',
    reverb: null,
    prog: { labels:['I7','IV7','I7','V7'], intervals:[0,5,0,7], qualities:['dom7','dom7','dom7','dom7'] }
  },
  {
    key: 'pentatonic_minor',
    name: 'Pentatonic Minor',
    profile: [1,0,0,1,0,1,0,1,0,0,1,0],
    vibe: 'Raw / Universal',
    desc: 'Five notes, zero tension. The most played scale in rock and blues guitar solos.',
    color: '#94a3b8',
    reverb: null,
    prog: { labels:['i','♭III','♭VII','i'], intervals:[0,3,10,0], qualities:['min','maj','maj','min'] }
  },
  {
    key: 'pentatonic_major',
    name: 'Pentatonic Major',
    profile: [1,0,1,0,1,0,0,1,0,1,0,0],
    vibe: 'Open / Innocent',
    desc: 'Pure and universally pleasing. Folk, country, children\'s music. Never sounds wrong.',
    color: '#84cc16',
    reverb: null,
    prog: { labels:['I','V','vi','I'], intervals:[0,7,9,0], qualities:['maj','maj','min','maj'] }
  },
  {
    key: 'whole_tone',
    name: 'Whole Tone',
    profile: [1,0,1,0,1,0,1,0,1,0,1,0],
    vibe: 'Dreamy / Impressionist',
    desc: 'All whole steps, zero resolution. Debussy, lo-fi, ambient — floaty and surreal.',
    color: '#8b5cf6',
    reverb: { decay: 5.0, wet: 0.6 },
    prog: { labels:['Iaug','IIaug','IIIaug','IIaug'], intervals:[0,2,4,2], qualities:['aug','aug','aug','aug'] }
  },
  {
    key: 'diminished',
    name: 'Diminished',
    profile: [1,1,0,1,1,0,1,1,0,1,1,0],
    vibe: 'Unsettling / Tense',
    desc: 'Alternating half/whole steps — horror, jazz tension, Stravinsky. Deeply unresolved.',
    color: '#dc2626',
    reverb: { decay: 2.0, wet: 0.3 },
    prog: { labels:['i°','♭III','i°','V'], intervals:[0,3,0,7], qualities:['dim','maj','dim','maj'] }
  },
  {
    key: 'phrygian_dominant',
    name: 'Phrygian Dominant',
    profile: [1,1,0,0,1,1,0,1,1,0,1,0],
    vibe: 'Exotic / Intense',
    desc: 'Spanish/Middle Eastern fire — flamenco, Bollywood, metal. Instantly dramatic.',
    color: '#fb923c',
    reverb: { decay: 1.5, wet: 0.2 },
    prog: { labels:['I','♭II','i','♭II'], intervals:[0,1,0,1], qualities:['maj','maj','min','maj'] }
  },
  {
    key: 'hungarian_minor',
    name: 'Hungarian Minor',
    profile: [1,0,1,1,0,0,1,1,1,0,0,1],
    vibe: 'Dark / Romantic',
    desc: 'Gypsy jazz feel with dramatic leaps — Eastern European folk, romantic-era classical.',
    color: '#d946ef',
    reverb: { decay: 3.0, wet: 0.4 },
    prog: { labels:['i','♯IV','V','i'], intervals:[0,6,7,0], qualities:['min','maj','maj','min'] }
  },
  {
    key: 'japanese',
    name: 'Japanese (In)',
    profile: [1,1,0,0,1,0,0,1,1,0,0,0],
    vibe: 'Meditative / Sparse',
    desc: 'Traditional Japanese pentatonic — ancient, minimal, and deeply peaceful.',
    color: '#06b6d4',
    reverb: { decay: 6.0, wet: 0.55 },
    prog: { labels:['i','♭II','i','v'], intervals:[0,1,0,7], qualities:['min','maj','min','min'] }
  }
];

/* ───────────────────────────────────────────────
   INSTRUMENT SAMPLES CDN
─────────────────────────────────────────────── */
const BASE = 'https://nbrosowsky.github.io/tonejs-instruments/samples/';

const INSTRUMENTS = {
  piano: {
    url: BASE + 'piano/',
    notes: { 'A1':'A1.mp3','A2':'A2.mp3','A3':'A3.mp3','A4':'A4.mp3','A5':'A5.mp3','A6':'A6.mp3','C2':'C2.mp3','C3':'C3.mp3','C4':'C4.mp3','C5':'C5.mp3','C6':'C6.mp3','C7':'C7.mp3','D#2':'Ds2.mp3','D#3':'Ds3.mp3','D#4':'Ds4.mp3','D#5':'Ds5.mp3','D#6':'Ds6.mp3','F#2':'Fs2.mp3','F#3':'Fs3.mp3','F#4':'Fs4.mp3','F#5':'Fs5.mp3','F#6':'Fs6.mp3' },
    volume: -8, release: 4.0,
  },
  guitar: {
    url: BASE + 'guitar-acoustic/',
    notes: { 'A2':'A2.mp3','A3':'A3.mp3','A4':'A4.mp3','B2':'B2.mp3','B3':'B3.mp3','B4':'B4.mp3','D3':'D3.mp3','D4':'D4.mp3','D5':'D5.mp3','E2':'E2.mp3','E3':'E3.mp3','E4':'E4.mp3','G2':'G2.mp3','G3':'G3.mp3','G4':'G4.mp3' },
    volume: -6, release: 3.0,
  },
  strings: {
    url: BASE + 'violin/',
    notes: { 'A3':'A3.mp3','A4':'A4.mp3','A5':'A5.mp3','C4':'C4.mp3','C5':'C5.mp3','E4':'E4.mp3','E5':'E5.mp3','G3':'G3.mp3','G4':'G4.mp3','G5':'G5.mp3' },
    volume: -10, release: 4.0,
  },
  bass: {
    url: BASE + 'bass-electric/',
    notes: { 'A1':'A1.mp3','A2':'A2.mp3','A3':'A3.mp3','B1':'B1.mp3','B2':'B2.mp3','B3':'B3.mp3','C2':'C2.mp3','C3':'C3.mp3','C4':'C4.mp3','D2':'D2.mp3','D3':'D3.mp3','E1':'E1.mp3','E2':'E2.mp3','E3':'E3.mp3','G1':'G1.mp3','G2':'G2.mp3','G3':'G3.mp3' },
    volume: -8, release: 3.0,
  },
  flute: {
    url: BASE + 'flute/',
    notes: { 'A4':'A4.mp3','A5':'A5.mp3','C4':'C4.mp3','C5':'C5.mp3','C6':'C6.mp3','E4':'E4.mp3','E5':'E5.mp3','G4':'G4.mp3','G5':'G5.mp3' },
    volume: -10, release: 2.5,
  },
  drums: {
    isDrum: true, 
  }
};
