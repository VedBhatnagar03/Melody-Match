/* ───────────────────────────────────────────────
   RESULTS BUILDER
   Depends on: constants.js, music.js, audio.js,
               playback.js, note-builder.js
─────────────────────────────────────────────── */

function buildResults() {
  if (detectedPitches.length < 4) {
    alert('Not enough notes detected — try humming for a bit longer!');
    showScreen('idle');
    return;
  }

  const pcs = detectedPitches.map(p => p.pc);
  const ranked = rankScales(pcs);
  const top5 = ranked; // show all 15 scales
  const best = top5[0];
  const maxScore = best.score || 1;

  // Title
  document.getElementById('bestMatchName').textContent = `${pcToName(best.root)} ${best.scale.name}`;
  const uniquePcs = [...new Set(pcs)];
  document.getElementById('resultsSub').textContent =
    `${detectedPitches.length} notes detected · ${uniquePcs.length} unique pitch classes`;

  // Detected bar
  const detectedBar = document.getElementById('detectedBar');
  detectedBar.innerHTML =
    `<span class="detected-label">detected</span>` +
    uniquePcs.map(pc => `<span class="det-note">${pcToName(pc)}</span>`).join('') +
    `<button class="play-melody-btn" id="playMelodyBtn" style="margin-left:auto">▶ melody</button>`;

  detectedBar.querySelector('#playMelodyBtn').addEventListener('click', async () => {
    const btn = document.getElementById('playMelodyBtn');
    if (btn.dataset.playing === '1') {
      btn.dataset.playing = '0';
      btn.textContent = '▶ melody';
      playGeneration++;
      return;
    }
    stopPlayback();
    await Tone.start();
    const { sampler: s } = await loadMelodySampler(melodyInstrument);
    btn.dataset.playing = '1';
    btn.textContent = '■ stop';

    const noteDurSec = 0.4;
    const now = Tone.now() + 0.05;
    const gen = playGeneration;
    detectedPitches.forEach((p, i) => {
      const delay = i * noteDurSec * 1000;
      setTimeout(() => {
        if (playGeneration !== gen) return;
        s.triggerAttackRelease(Tone.Frequency(p.midi, 'midi').toNote(), noteDurSec * 0.85, Tone.now() + 0.01);
      }, delay);
    });

    setTimeout(() => {
      if (playGeneration === gen) {
        btn.dataset.playing = '0';
        btn.textContent = '▶ melody';
      }
    }, detectedPitches.length * noteDurSec * 1000 + 500);
  });

  // Cards
  const container = document.getElementById('scaleCards');
  container.innerHTML = '';

  top5.forEach((result, idx) => {
    const { scale, root, score } = result;
    const pct = Math.round((score / maxScore) * 100);
    const isTop = idx === 0;

    const barResult = buildBarChords(detectedPitches, scale.profile, root, pitchSource === 'builder' ? nbBpm : null, scale.key);
    const bars              = barResult ? barResult.bars             : null;
    const bpm               = barResult ? barResult.bpm              : 100;
    const firstNoteSecOffset = barResult ? (barResult.firstNoteSecOffset || 0) : 0;

    const chordLabel = (root, quality) =>
      pcToName(root) + (CHORD_SUFFIXES[quality] ?? '');

    const makeChipsHTML = (barArr, chipClass) => barArr.map((bar, i) => {
      const sep = i > 0 ? `<span class="chord-sep">›</span>` : '';
      const name = chordLabel(bar.root, bar.quality);
      return `${sep}<span class="${chipClass}" style="color:${scale.color};border-color:${scale.color}44;background:${scale.color}10">${name}</span>`;
    }).join('');

    const chordsHTML = makeChipsHTML(bars || [], 'chord-chip');
    const bpmLabel = barResult ? `${bpm} bpm · ${bars.length} bars` : '';
    const numBarsForAlts = bars ? bars.length : 4;

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

      <div class="card-actions" style="display:flex; align-items:center;">
        <button class="play-btn" data-idx="${idx}" style="background:${scale.color}">▶  play</button>
        <button class="edit-btn" data-idx="${idx}" style="margin-left: 10px; font-family:'Space Mono', monospace; font-size:11px; padding: 5px 14px; border-radius:4px; background:transparent; border:1px solid ${scale.color}55; color:var(--text2); cursor:pointer;">✎ edit &amp; export</button>
        <span class="roman-label" style="margin-left:auto; font-family:'Space Mono', monospace; font-size:11px; color:var(--text3);">${bpmLabel}</span>
      </div>

      ${altProgsHTML}
    `;

    card.querySelector('.play-btn').addEventListener('click', async e => {
      const btn = e.currentTarget;
      await playSuggestion(result, detectedPitches, bars, bpm, firstNoteSecOffset, btn, idx);
    });

    card.querySelectorAll('.alt-play-btn').forEach(btn => {
      const altIdx = parseInt(btn.dataset.alt);
      const altBars = altProgs[altIdx].altBars;
      const altPlayIdx = idx * 100 + altIdx + 10;
      btn.addEventListener('click', async () => {
        if (playingIdx === altPlayIdx) { stopPlayback(); return; }
        card.querySelectorAll('.alt-play-btn').forEach(b => { b.classList.remove('playing'); b.textContent = '▶'; });
        await playSuggestion(result, detectedPitches, altBars, bpm, firstNoteSecOffset, btn, altPlayIdx);
      });
    });

    const editBtn = card.querySelector('.edit-btn');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        stopPlayback();
        if (typeof openEditor === 'function') {
          openEditor(bars, detectedPitches, bpm, result);
        }
      });
    }

    container.appendChild(card);
  });
}
