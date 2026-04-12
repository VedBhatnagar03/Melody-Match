# MelodyMatch — Bug & Feature Backlog

> Last updated: 2026-04-12  
> Working file: `index (9).html` + `js/` folder  
> Live repo: https://github.com/VedBhatnagar03/Melody-Match

---

## How to use this file

Tell Claude: *"Read BACKLOG.md and fix item #N"* or *"Read BACKLOG.md and implement items #N, #M"*.  
Each item has a unique number that won't change. Completed items are marked ✅.

---

## 🐛 Section 1 — Bugs & Broken Things

### Critical (crash or silently wrong output)

**#1 ✅ — `runDemo()` missing `time` field on pitches**  
`detectedPitches` created in `app.js runDemo()` has no `time` field.  
`mrPitchesToSequence()` uses `p.time` for IOI-based BPM detection — every interval is `NaN`, BPM defaults to 100, all notes land at beat 0.  
**Fix:** Add `time: i * 500` (evenly spaced 500ms) as a placeholder, or route demo through `mrInitFromDetected()` properly.

**#2 ✅ — `music.js` references `nbBars` global inside `buildBarChords()`**  
When `fixedBpm != null`, bar count is read from `nbBars` directly instead of a parameter.  
Chord bar count is always coupled to notebuilder state even when playing results from a recording.  
**Fix:** Pass `bars` as an explicit parameter to `buildBarChords()`.

**#3 ✅ — `results.js` — `bars.length` called when `bars` can be null**  
`buildBarChords()` can return `null`. `bars` is checked on assignment but then used as `bars.length` two lines later without a null guard — hard crash.  
**Fix:** Add `if (!bars) return;` guard before `bars.length` usage.

**#4 ✅ — `editor.js` — Transport scheduling uses wrong Tone.js notation**  
Chord events scheduled with `` `+0:0:${tStart * 4}` ``. Tone.js interprets `bars:beats:sixteenths` with 480 PPQ internally — everything in the editor fires at completely wrong times.  
**Fix:** Convert to plain seconds: `` `+${tStart * secPerBeat}` `` (same fix applied to `playback.js` previously).

**#5 ✅ — `editor.js` — dead `isDrum` / `drumSynth` code**  
Editor playback checks `chordHandle.isDrum` and `chordHandle.drumSynth.kick` — these properties never exist on sampler objects. The drum path in the editor is entirely non-functional dead code.  
**Fix:** Remove the `isDrum` branch; wire up `drumEnabled` from `playback.js` instead.

**#6 ✅ — `nbPlaySequence()` — multiple `setTimeout` calls stack on rapid clicks**  
Notes scheduled with raw `setTimeout`. Clicking Play rapidly queues multiple overlapping sets because only the `nbSeqPlaying` flag gates new starts — existing timeouts are never cancelled.  
**Fix:** Store timeout IDs in an array and `clearTimeout` all of them on stop/restart.

**#7 ✅ — Take deletion leaves `mrActiveTake === 'merged'` with only one take remaining**  
After deleting a take, if one remains and `mrActiveTake` is still `'merged'`, the merge UI indicator stays shown. Confusing and logically wrong.  
**Fix:** After deletion, if `mrTakes.length <= 1` force `mrActiveTake = 0`.

**#8 ✅ — Edit melody → notebuilder: unit confusion on `p.time`**  
Investigated — conversion `beat: p.beat ?? ((p.time || 0) / 1000 / spb)` is already correct. `p.time` is ms, `/1000` → sec, `/spb` → beats. Not a bug in current code.

---

### Medium (broken behaviour, not hard crash)

**#9 — Scrub seek fires burst of stale notes at seek point**  
`mrStartPlaybackFrom()` computes `t = now + (n.beat - startBeat) * secPerBeat`. If `n.beat < startBeat` and the note hasn't quite ended, `t` is negative — `delay` clamps to 0 but the note fires immediately as a burst.  
**Fix:** Skip any note where `n.beat + (n.dur ?? 0.5) <= startBeat` (already partially done — verify the `<=` boundary is tight enough).

**#10 — `ctx.roundRect()` has no polyfill**  
Used on all canvases. Firefox < 112 and Safari < 15.4 don't support it — piano roll is blank with a silent JS error.  
**Fix:** Add a small polyfill at the top of `note-builder.js` and `mic-review.js`:
```js
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function(x,y,w,h,r){
    this.beginPath();
    this.moveTo(x+r,y); this.lineTo(x+w-r,y); this.arcTo(x+w,y,x+w,y+r,r);
    this.lineTo(x+w,y+h-r); this.arcTo(x+w,y+h,x+w-r,y+h,r);
    this.lineTo(x+r,y+h); this.arcTo(x,y+h,x,y+h-r,r);
    this.lineTo(x,y+r); this.arcTo(x,y,x+r,y,r);
    this.closePath();
  };
}
```

**#11 — Box-select in notebuilder doesn't respect Shift on mousemove**  
`nbBoxSel` calls `nbSelected.clear()` at the start of a box drag. `shiftKey` is read in `mousedown` but not carried into the `mousemove` handler that updates selection. Shift-boxing always replaces selection.  
**Fix:** Store `nbBoxShift = e.shiftKey` on mousedown; use it in mousemove.

**#12 — `nbPlaySequence()` playhead animation continues on inactive screen**  
The animation check is `elapsed < totalSec + 0.5` — if the user navigates away, `nbDrawRoll()` still gets called every frame until the timer expires.  
**Fix:** Add `if (!document.getElementById('screen-notebuilder').classList.contains('active')) { /* stop */ return; }` in the rAF callback.

**#13 — Raw mic play button never resets on audio decode error**  
`mrRawAudioElement.onerror` is never handled. On decode failure the button stays as "❚❚ stop raw" permanently.  
**Fix:** Add `mrRawAudioElement.onerror = () => { mrRawAudioElement = null; btn.textContent = '🎤 play raw mic'; };`

**#14 — Reverb slider initial value doesn't match `globalReverbAmount` initial state**  
Slider starts at value `18` in HTML but `globalReverbAmount` is initialised in `playback.js` at a different default. First playback uses the code default, not the visible slider position.  
**Fix:** On init, read the slider value and set `globalReverbAmount = parseInt(reverbSlider.value) / 100`.

---

### Minor / Polish

**#15 — Saved melody format has no version field**  
If the data structure changes, old localStorage saves load wrong or partially with no warning.  
**Fix:** Add `version: 1` to each saved entry; check on load and migrate or warn.

**#16 — `window._lastBpm`, `window._lastBars`, `window._lastScaleName` global pollution**  
Will conflict with any future library. Should be a module-level object.  
**Fix:** Replace with `const _lastResults = {}` and use `_lastResults.bpm`, etc.

**#17 — `#bestMatchName` accessed in `savedSaveFromResults()` without null check**  
If the element doesn't exist, `textContent` returns empty string and the default name is blank.  
**Fix:** `const el = document.getElementById('bestMatchName'); const defaultName = el?.textContent || 'My Melody';`

**#18 — BPM/bar labels not updated in all Edit Melody paths**  
The HTML labels are updated when coming from the notebuilder path. If a saved mic-review melody is loaded via Edit Melody, displayed labels may lag.  
**Fix:** Always set both `nbBpmLabel` and `nbBarsLabel` in the `editMelodyBtn` handler after setting `nbBpm`/`nbBars`.

---

## ✨ Section 2 — UX & Feature Ideas (User Perspective)

**#19 — No way back to results from notebuilder**  
Going Edit Melody → notebuilder → back loses everything (back goes to idle). Need a "Back to results" button that preserves the current analysis state.

**#20 — No undo/redo**  
Every delete or move is permanent. A Ctrl+Z stack (10 levels) would make editing much less stressful on both the notebuilder and mic-review rolls.

**#21 — No loop button on results playback**  
Users want to hear the progression loop continuously while experimenting with instruments/reverb. Add a loop toggle next to the play button on the results page.

**#22 — Chord cards don't animate in sync with playback**  
When playing a suggestion, no visual feedback shows which bar/chord is currently playing. Highlight the active chord card in real time to make it easier to follow along.

**#23 — No playback preview on saved melodies list**  
The saved list shows name/bpm/notes but you can't hear it without fully loading it. Add a small ▶ play button on each saved entry that plays the melody inline.

**#24 — No way to rename a saved melody after saving**  
Once saved, the name is fixed unless you delete and re-save. Add an inline rename (click the name to edit it) on the saved list.

**#25 — Results page has no explanation of scoring**  
Users don't know what "best match" means. Add a small "why?" tooltip or expandable row per result showing the match score and which detected notes fit/don't fit the scale.

**#26 — Notes that don't fit the matched scale are not highlighted**  
After recording → results, detected melody notes that fall outside the best-matched scale are never indicated. Show out-of-scale notes in amber/red on the results melody display.

**#27 — Mobile: piano keyboard is unusable**  
At 36px per key × 4 octaves = ~1100px wide. Keys too small to tap accurately on mobile. Need a mobile-optimised single-octave view with swipe-to-change-octave or a simplified note selector.

**#28 — No loop region for audition in the piano rolls**  
Let the user set a loop region by shift-dragging on the timeline ruler (DAW-style loop region). Playback loops only those bars. Essential when fixing one phrase repeatedly.

**#29 — Zoom via scroll wheel / pinch**  
Add Ctrl+scroll to zoom the horizontal (beat width) axis on both rolls, independent of the resize handle. Pinch gesture on mobile. Standard DAW behaviour users expect.

**#30 — Automatic duplicate/overlap detection**  
After quantisation, two notes can land on the same beat in the same row. They stack visually and play doubled. Auto-detect and highlight these with a "fix overlaps" button.

---

## 🎤 Section 3 — Melody Editing After Recording

*Pitch detection from humming is never perfect. These are ideas for making post-recording editing easier, ranked roughly by impact.*

### Detection improvements (upstream — `audio.js`)

**#31 — Adaptive silence threshold**  
RMS gate is fixed at `0.01`. In noisy rooms this cuts valid quiet notes; in quiet rooms it's too permissive. Compute a noise floor from the first 200ms of silence at recording start, then gate at `noiseFloor * 3`.  
**File:** `js/audio.js` — `detectPitch()` and the analysis pass.

**#32 — Octave error detection and auto-correction**  
The biggest single failure mode: YIN detects the wrong octave (hummed C4 → C3 or C5). Octave errors are invisible to YIN because 2:1 frequency ratios look valid. Add a post-processing pass: for each note, check if flipping it ±12 semitones would bring it closer to the median MIDI of the whole melody. If yes, flag it (or auto-correct with user confirmation).  
**File:** `js/audio.js` — add after the segmentation pass.

**#33 — Highlight octave outliers visually on the roll**  
Even without auto-correction: if a note is more than 12 semitones from the median pitch of the melody, draw it in orange/amber instead of cyan. User can then decide whether it's intentional.  
**File:** `js/mic-review.js` — `mrDrawRoll()`, add outlier check before note colour selection.

**#34 — Record count-in clicks before recording starts**  
Play a 4-beat click at the current BPM before the mic opens. Users who start on the beat produce much better IOI-based BPM detection (the first few onsets are most important for the median).  
**File:** `js/audio.js` `startAudio()` + `app.js` — add pre-roll using `Tone.js`.

**#35 — Configurable quantisation strength (auto-tune slider)**  
The auto-tune button hard-snaps to 8th notes. Add a strength slider (0–100%) that blends between raw timing and snapped timing: `beat = raw * (1 - strength) + snapped * strength`.  
**File:** `js/mic-review.js` `mrAutoTuneSequence()` + HTML slider.

**#36 — Tap tempo button**  
IOI median BPM detection is fragile for melodies with many rests or irregular phrasing. A "tap tempo" button where the user taps 4+ times sets `mrBpm` directly and re-quantises beats against the new grid.  
**File:** `js/app.js` + mic-review HTML.

### Editing improvements (mic-review roll)

**#37 — Overlay raw audio waveform behind piano roll notes**  ⭐ Highest impact
Decode `rawAudioBlob` into a waveform and render it as a semi-transparent grey background behind the note blocks on `mrRollCanvas`. Users can see exactly where they sang what and manually align notes to the visible attack transients. Would make fixing timing errors dramatically easier.  
**File:** `js/mic-review.js` `mrDrawRoll()` — decode waveform once on load, cache as `Float32Array`, draw scaled to canvas.

**#38 — "Snap to scale" button on mic-review**  
Once results have been run once, offer a button on the mic-review screen: "Snap to scale". Rounds each note's MIDI to the nearest note *within the detected scale* rather than the nearest chromatic semitone. Fixes most pitch errors for users who sang slightly flat/sharp within a key.  
**File:** `js/mic-review.js` + `js/app.js` wiring. Requires `_lastScaleName` / scale profile to be available.

**#39 — "Low confidence" filter toggle**  
Notes already have a `conf` field that affects alpha. Add a toggle button "show uncertain" that when OFF hides all notes with `conf < 0.6`, letting users focus on fixing the uncertain ones first. Add a badge count: "4 uncertain notes".  
**File:** `js/mic-review.js` `mrDrawRoll()` + state variable `mrShowLowConf`.

**#40 — Right-click / long-press context menu on notes**  
Right-clicking a note opens a small popover with: note name display, ±1 semitone nudge buttons, ±1 octave jump buttons, "play this note" button, delete option. For precise fixing without needing accurate drag.  
**File:** `js/mic-review.js` — add `contextmenu` event listener on canvas; calculate hit note and show a positioned `<div>` menu.

**#41 — Per-note confidence badge**  
Draw a small dot or number on each note block showing its `conf` value (e.g. "0.6"). Only shown when zoomed in enough (row height > 20px). Helps users know which notes to trust.  
**File:** `js/mic-review.js` `mrDrawRoll()`.

**#42 — Quantisation grid selector**  
The snap currently forces 16th-note grid. Add a grid selector in the BPM row: free / 32nd / 16th / 8th / quarter. Users humming slow ballads don't need 16th precision.  
**File:** `js/mic-review.js` `mrSnapBeat()` + HTML selector.

**#43 — "Suggest corrections" summary panel**  
A collapsible panel above the roll showing: total notes, mean confidence, number of low-conf notes, number of octave outliers, detected BPM confidence score. Gives users a quick sanity check before editing.  
**File:** `js/mic-review.js` + HTML panel element.

**#44 — Playback with scale-reference ghost notes**  
An option to play the melody but with a softer synth note showing what the nearest in-scale note would sound like, slightly overlapping each played note. Helps non-musicians hear whether the detected pitch is right.  
**File:** `js/app.js` `mrStartPlaybackFrom()` — optional ghost layer using `_lastScale` profile.

---

## ✅ Completed

*(Nothing completed from this backlog yet — items above are all pending)*

---

## Notes for Claude

- The active HTML file is `index.html`
- Active JS is in `js/` subfolder (not the root-level `.js` files which are older copies)
- Active CSS is `css/styles.css`
- Never commit/push without user saying "ok push" or "commit and push"
- Don't use `window.prompt()` — use the `#saveModal` pattern already in the codebase
- Tone.js scheduling: always use plain seconds (`` `+${seconds}` ``), never `bars:beats:sixteenths` format
