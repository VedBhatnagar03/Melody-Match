/* ───────────────────────────────────────────────
   RESULTS BUILDER
   Depends on: constants.js, music.js, audio.js,
               playback.js, note-builder.js
─────────────────────────────────────────────── */

// ── Snap pitches to nearest in-scale note ──
function snapPitchesToScale(pitches, root, profile) {
  return pitches.map(p => {
    const pc = p.midi % 12;
    if (profile[pc] === 1) return { ...p }; // already in scale
    for (let delta = 1; delta <= 6; delta++) {
      const pcUp   = (pc + delta) % 12;
      const pcDown = ((pc - delta) % 12 + 12) % 12;
      if (profile[pcUp]   === 1) return { ...p, midi: p.midi + delta, pc: pcUp };
      if (profile[pcDown] === 1) return { ...p, midi: p.midi - delta, pc: pcDown };
    }
    return { ...p };
  });
}

// ── Play a pitch array as a simple melody (sequential notes) ──
async function playMelodyNotes(pitches, btnEl, bpm) {
  const isPlaying = btnEl.dataset.playing === '1';

  stopPlayback(); // increments playGeneration
  if (isPlaying) return; // was playing → just stop

  const myGen = playGeneration; // capture AFTER stopPlayback

  await Tone.start();
  const { sampler } = await loadMelodySampler(melodyInstrument);
  if (playGeneration !== myGen) return;

  btnEl.dataset.playing = '1';
  btnEl.textContent = '❚❚ pause melody';

  const secPerBeat = 60 / (bpm || 100);

  if (pitches[0] && pitches[0].beat !== undefined) {
    // Beat-positioned notes (builder / mic-review path)
    pitches.forEach(p => {
      const delaySec = (p.beat || 0) * secPerBeat;
      const dur = (p.dur || 0.5) * secPerBeat * 0.88;
      setTimeout(() => {
        if (playGeneration !== myGen) return;
        sampler.triggerAttackRelease(Tone.Frequency(p.midi, 'midi').toNote(), dur, Tone.now() + 0.01);
      }, delaySec * 1000);
    });
    const totalSec = Math.max(...pitches.map(p => ((p.beat || 0) + (p.dur || 0.5)) * secPerBeat));
    setTimeout(() => {
      if (playGeneration === myGen) { btnEl.dataset.playing = '0'; btnEl.textContent = '▶ melody'; }
    }, totalSec * 1000 + 300);
  } else {
    // Sequential fallback (legacy detectedPitches with only time/dur)
    const noteDurSec = 0.4;
    pitches.forEach((p, i) => {
      setTimeout(() => {
        if (playGeneration !== myGen) return;
        sampler.triggerAttackRelease(Tone.Frequency(p.midi, 'midi').toNote(), noteDurSec * 0.85, Tone.now() + 0.01);
      }, i * noteDurSec * 1000);
    });
    setTimeout(() => {
      if (playGeneration === myGen) { btnEl.dataset.playing = '0'; btnEl.textContent = '▶ melody'; }
    }, pitches.length * noteDurSec * 1000 + 300);
  }
}

function buildResults() {
  if (detectedPitches.length < 4) {
    alert('Not enough notes detected — try humming for a bit longer!');
    showScreen('idle');
    return;
  }

  const pcs = detectedPitches.map(p => p.pc);
  const ranked = rankScales(pcs);
  const top5 = ranked;
  const best = top5[0];
  const maxScore = best.score || 1;

  // Title
  document.getElementById('bestMatchName').textContent = `${pcToName(best.root)} ${best.scale.name}`;
  const uniquePcs = [...new Set(pcs)];
  document.getElementById('resultsSub').textContent =
    `${detectedPitches.length} notes detected · ${uniquePcs.length} unique pitch classes`;

  // Detected bar — play original melody button
  const detectedBar = document.getElementById('detectedBar');
  detectedBar.innerHTML =
    `<span class="detected-label">detected</span>` +
    uniquePcs.map(pc => `<span class="det-note">${pcToName(pc)}</span>`).join('') +
    `<button class="play-melody-btn" id="playMelodyBtn" style="margin-left:auto">▶ melody</button>`;

  detectedBar.querySelector('#playMelodyBtn').addEventListener('click', async function() {
    await playMelodyNotes(detectedPitches, this, _lastResults.bpm || 100);
  });

  // Cards
  const container = document.getElementById('scaleCards');
  container.innerHTML = '';

  top5.forEach((result, idx) => {
    const { scale, root, score } = result;
    const pct = Math.round((score / maxScore) * 100);
    const isTop = idx === 0;

    const barResult = buildBarChords(detectedPitches, scale.profile, root, pitchSource === 'builder' ? nbBpm : null, scale.key);
    const bars               = barResult ? barResult.bars              : null;
    const bpm                = barResult ? barResult.bpm               : 100;
    const firstNoteSecOffset = barResult ? (barResult.firstNoteSecOffset || 0) : 0;

    const chordLabel = (r, quality) => pcToName(r) + (CHORD_SUFFIXES[quality] ?? '');

    const makeChipsHTML = (barArr, chipClass) => barArr.map((bar, i) => {
      const sep = i > 0 ? `<span class="chord-sep">›</span>` : '';
      const name = chordLabel(bar.root, bar.quality);
      return `${sep}<span class="${chipClass}" style="color:${scale.color};border-color:${scale.color}44;background:${scale.color}10">${name}</span>`;
    }).join('');

    const chordsHTML = makeChipsHTML(bars || [], 'chord-chip');
    const bpmLabel = (barResult && bars) ? `${bpm} bpm · ${bars.length} bars` : '';
    const numBarsForAlts = (bars && bars.length > 0) ? bars.length : 4;

    const altProgs = (SCALE_PROGRESSIONS[scale.key] || []).slice(0, 4).map((degOffsets, altIdx) => {
      const altBars = buildProgBars(degOffsets, scale.profile, root, numBarsForAlts, scale.key);
      const chipsHTML = makeChipsHTML(altBars, 'alt-chip');
      return { altBars, chipsHTML, altIdx };
    });

    const altProgsHTML = altProgs.length ? `
      <div class="alt-progs">
        ${altProgs.map(({ altBars, chipsHTML, altIdx }) => `
          <div class="alt-prog-row">
            <span class="alt-prog-label">alt ${altIdx + 1}</span>
            ${chipsHTML}
            <button class="alt-play-btn" data-alt="${altIdx}">▶</button>
          </div>
        `).join('')}
      </div>` : '';

    const card = document.createElement('div');
    card.className = `scale-card ${isTop ? 'top-match' : ''}`;
    card.style.setProperty('--card-color', scale.color);
    card.innerHTML = `
      <div class="card-header">
        <div>
          <div class="card-rank-row">
            <span class="rank-badge ${isTop ? 'best' : ''}">${isTop ? '✦ best match' : '#' + (idx+1)}</span>
            <span class="vibe-tag">${scale.vibe}</span>
          </div>
          <div class="card-scale-name">
            <span class="card-root">${pcToName(root)} </span>${scale.name}
          </div>
        </div>
        <div class="match-meter">
          <div class="match-pct" style="color:${scale.color}">${pct}%</div>
          <div class="match-bar-track">
            <div class="match-bar-fill" style="width:${pct}%;background:${scale.color}"></div>
          </div>
        </div>
      </div>

      <div class="chords-row">
        <span class="chord-section-label">detected</span>
        ${chordsHTML}
      </div>

      <p class="card-desc">${scale.desc}</p>

      <div class="card-actions" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <div class="play-split" style="--card-color:${scale.color}">
          <button class="play-btn play-split-main" data-idx="${idx}" style="background:${scale.color}">▶  play</button>
          <button class="play-split-arrow" style="background:${scale.color}" title="More playback options">▾</button>
          <div class="play-split-menu">
            <button class="psm-item psm-chords">▶  chords only</button>
            <button class="psm-item psm-raw">🎤  chords + raw audio</button>
            <button class="psm-item psm-raw-notes">🎤+♪  chords + raw + melody</button>
          </div>
        </div>
        <button class="card-play-melody-btn" data-playing="0" style="font-family:'Space Mono',monospace;font-size:11px;padding:5px 12px;border-radius:4px;background:transparent;border:1px solid ${scale.color}55;color:${scale.color};cursor:pointer;">▶ melody</button>
        <button class="card-snap-btn" style="font-family:'Space Mono',monospace;font-size:11px;padding:5px 12px;border-radius:4px;background:transparent;border:1px solid ${scale.color}55;color:var(--text2);cursor:pointer;" title="Snap detected melody to ${pcToName(root)} ${scale.name} scale — click again to revert">⟼ snap melody</button>
        <button class="edit-btn" data-idx="${idx}" style="font-family:'Space Mono',monospace;font-size:11px;padding:5px 14px;border-radius:4px;background:transparent;border:1px solid ${scale.color}55;color:var(--text2);cursor:pointer;">✎ edit &amp; export</button>
        <span class="roman-label" style="margin-left:auto;font-family:'Space Mono',monospace;font-size:11px;color:var(--text3);">${bpmLabel}</span>
      </div>

      ${altProgsHTML}
    `;

    // Per-card snap state
    const snapState = {
      snapped: false,
      original: detectedPitches.map(p => ({ ...p })),
      snappedNotes: snapPitchesToScale(detectedPitches, root, scale.profile),
    };

    // Current notes accessor — returns snapped or original depending on state
    const currentNotes = () => snapState.snapped ? snapState.snappedNotes : snapState.original;

    // ── Split play button ──
    const splitMain  = card.querySelector('.play-split-main');
    const splitArrow = card.querySelector('.play-split-arrow');
    const splitMenu  = card.querySelector('.play-split-menu');

    // Dropdown open/close
    splitArrow.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = splitMenu.classList.contains('open');
      document.querySelectorAll('.play-split-menu.open').forEach(m => m.classList.remove('open'));
      if (!isOpen) splitMenu.classList.add('open');
    });
    document.addEventListener('click', () => splitMenu.classList.remove('open'));

    // All three modes funnel through playSuggestion — chords always play underneath
    const doPlay = (mode) => {
      splitMenu.classList.remove('open');
      playSuggestion(result, currentNotes(), bars, bpm, firstNoteSecOffset, splitMain, idx, mode);
    };

    splitMain.addEventListener('click', () => doPlay('chords'));
    card.querySelector('.psm-chords').addEventListener('click',    () => doPlay('chords'));
    card.querySelector('.psm-raw').addEventListener('click',       () => doPlay('raw'));
    card.querySelector('.psm-raw-notes').addEventListener('click', () => doPlay('raw+notes'));

    // ── Melody-only button (separate, no chords) ──
    const melodyBtn = card.querySelector('.card-play-melody-btn');
    melodyBtn.addEventListener('click', async () => {
      await playMelodyNotes(currentNotes(), melodyBtn, bpm);
    });

    // ── Snap melody toggle ──
    const snapBtn = card.querySelector('.card-snap-btn');
    snapBtn.addEventListener('click', () => {
      snapState.snapped = !snapState.snapped;
      snapBtn.textContent = snapState.snapped ? '↩ revert melody' : '⟼ snap melody';
      snapBtn.style.color = snapState.snapped ? scale.color : 'var(--text2)';
      snapBtn.title = snapState.snapped
        ? `Revert melody back to original detected notes`
        : `Snap detected melody to ${pcToName(root)} ${scale.name} scale — click again to revert`;
      if (playingIdx === idx) stopPlayback();
    });

    // ── Edit & export (opens editor screen, unchanged) ──
    const editBtn = card.querySelector('.edit-btn');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        stopPlayback();
        if (typeof openEditor === 'function') {
          openEditor(bars, currentNotes(), bpm, result);
        }
      });
    }

    // ── Alt progressions ──
    card.querySelectorAll('.alt-play-btn').forEach(btn => {
      const altIdx = parseInt(btn.dataset.alt);
      const altBars = altProgs[altIdx].altBars;
      const altPlayIdx = idx * 100 + altIdx + 10;
      btn.addEventListener('click', async () => {
        if (playingIdx === altPlayIdx) { stopPlayback(); return; }
        card.querySelectorAll('.alt-play-btn').forEach(b => { b.classList.remove('playing'); b.textContent = '▶'; });
        await playSuggestion(result, currentNotes(), altBars, bpm, firstNoteSecOffset, btn, altPlayIdx);
      });
    });

    container.appendChild(card);
  });
}
