/* Double Speak — app logic. Depends on stories.js (window.STORIES, window.VOICES) and grader.js (window.Grader). */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const STORIES = window.STORIES || [];
  const VOICES = Object.keys(window.VOICES || { lessac: 1, ryan: 1 });
  const VOICE_LABELS = window.VOICES || {};
  const G = window.Grader;

  const LS = {
    settings: 'dsp.settings',
    history: 'dsp.history',
    bag: 'dsp.bag',
  };

  // ---------- persistence ----------
  function loadJSON(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode etc. */ }
  }

  const settings = Object.assign({ voices: 'different', speed: '1', replay: 'allowed', order: 'both' }, loadJSON(LS.settings, {}));

  // ---------- story selection (shuffle bag so pairs do not repeat until the library is exhausted) ----------
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function drawPair() {
    const ids = STORIES.map((s) => s.id);
    let bag = loadJSON(LS.bag, []).filter((id) => ids.includes(id));
    if (bag.length < 2) {
      const refill = shuffle(ids.slice());
      // avoid immediately repeating whatever was left in the bag
      bag = bag.concat(refill.filter((id) => !bag.includes(id)));
    }
    const a = bag.shift(), b = bag.shift();
    saveJSON(LS.bag, bag);
    const byId = Object.fromEntries(STORIES.map((s) => [s.id, s]));
    return [byId[a], byId[b]];
  }
  function pickVoices() {
    const v = shuffle(VOICES.slice());
    if (settings.voices === 'same' || v.length < 2) return [v[0], v[0]];
    return [v[0], v[1]];
  }

  // ---------- audio engine ----------
  const audio = {
    ctx: null,
    cache: new Map(),
    current: null,
    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) throw new Error('Web Audio is not supported in this browser.');
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    async load(url) {
      if (this.cache.has(url)) return this.cache.get(url);
      const ctx = this.ensure();
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not load ${url} (${res.status}). The audio files are missing; run tools/build_audio.py.`);
      const buf = await res.arrayBuffer();
      const decoded = await new Promise((resolve, reject) => ctx.decodeAudioData(buf, resolve, reject));
      this.cache.set(url, decoded);
      return decoded;
    },
    makeChain(buffer, pan, rate) {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      let panner;
      if (ctx.createStereoPanner) {
        panner = ctx.createStereoPanner();
        panner.pan.value = pan;
      } else { // Safari < 14.1: emulate with a merger
        panner = ctx.createChannelMerger(2);
        const gainL = ctx.createGain(), gainR = ctx.createGain();
        gainL.gain.value = pan < 0 ? 1 : 0;
        gainR.gain.value = pan > 0 ? 1 : 0;
        src.connect(gainL).connect(panner, 0, 0);
        src.connect(gainR).connect(panner, 0, 1);
        panner.connect(ctx.destination);
        return { src, panner };
      }
      src.connect(panner).connect(ctx.destination);
      return { src, panner };
    },
    /** Plays `left` in the left ear and `right` in the right ear simultaneously. */
    playPair(left, right, rate, onProgress, onEnd) {
      const ctx = this.ensure();
      this.stop();
      const L = this.makeChain(left, -1, rate);
      const R = this.makeChain(right, 1, rate);
      const startAt = ctx.currentTime + 0.08;
      L.src.start(startAt);
      R.src.start(startAt);
      const durL = left.duration / rate, durR = right.duration / rate;
      const total = Math.max(durL, durR);
      let raf = 0, done = false;
      const tick = () => {
        const t = ctx.currentTime - startAt;
        onProgress({ t: Math.max(0, t), left: Math.min(1, Math.max(0, t / durL)), right: Math.min(1, Math.max(0, t / durR)), durL, durR, total });
        if (t >= total + 0.05) { finish(); return; }
        raf = requestAnimationFrame(tick);
      };
      const finish = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        this.current = null;
        onEnd();
      };
      raf = requestAnimationFrame(tick);
      this.current = {
        stop: () => {
          if (done) return;
          done = true;
          cancelAnimationFrame(raf);
          try { L.src.stop(); R.src.stop(); } catch (e) { /* already stopped */ }
          this.current = null;
        },
      };
      return this.current;
    },
    stop() { if (this.current) this.current.stop(); },
    playOne(buffer, pan) {
      this.ensure();
      const c = this.makeChain(buffer, pan, 1);
      c.src.start();
      return new Promise((r) => { c.src.onended = r; });
    },
  };

  // ---------- state ----------
  const state = {
    round: null, // { left: story, right: story, voices: [l, r], listens: 0, buffers: {left, right} }
    phase: 'setup',
    retellStep: null,
  };

  const screens = {
    setup: $('#screen-setup'), listen: $('#screen-listen'), retell: $('#screen-retell'), results: $('#screen-results'),
  };
  function show(name) {
    Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== name; });
    state.phase = name;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- setup screen ----------
  function bindSettings() {
    const map = { voices: '#opt-voices', speed: '#opt-speed', replay: '#opt-replay', order: '#opt-order' };
    for (const [key, sel] of Object.entries(map)) {
      const el = $(sel);
      el.value = settings[key];
      if (el.value !== settings[key]) { settings[key] = el.value; }
      el.addEventListener('change', () => { settings[key] = el.value; saveJSON(LS.settings, settings); });
    }
  }

  async function headphoneCheck(side) {
    const status = $('#check-status');
    try {
      status.textContent = 'Loading…';
      const voice = VOICES[0];
      const buf = await audio.load(`audio/check-${side}-${voice}.mp3`);
      status.textContent = side === 'left' ? 'Playing in the LEFT ear only.' : 'Playing in the RIGHT ear only.';
      await audio.playOne(buf, side === 'left' ? -1 : 1);
      status.textContent = '';
    } catch (e) {
      status.textContent = e.message;
    }
  }

  function renderHistory() {
    const hist = loadJSON(LS.history, []);
    const card = $('#history-card');
    if (!hist.length) { card.hidden = true; return; }
    card.hidden = false;
    const scores = hist.map((h) => h.score);
    const best = Math.max(...scores);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const last5 = scores.slice(0, 5);
    const avg5 = last5.reduce((a, b) => a + b, 0) / last5.length;
    $('#history-stats').innerHTML =
      `<div>Rounds<b>${hist.length}</b></div><div>Best<b>${best}</b></div><div>Average<b>${Math.round(avg)}</b></div><div>Last 5<b>${Math.round(avg5)}</b></div>`;
    const tbody = $('#history-table tbody');
    tbody.innerHTML = hist.slice(0, 20).map((h) => {
      const d = new Date(h.at);
      const when = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      return `<tr><td>${when}</td><td>${esc(h.left)} / ${esc(h.right)}</td><td class="num"><b>${h.score}</b></td><td class="num">${h.c}%</td><td class="num">${h.a}%</td><td class="num">${h.s}%</td></tr>`;
    }).join('');
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function fmtTime(sec) { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }

  // ---------- round flow ----------
  async function startRound() {
    const err = $('#setup-error');
    err.hidden = true;
    if (STORIES.length < 2) { err.textContent = 'The story library is missing. Run tools/build_audio.py to generate stories.js.'; err.hidden = false; return; }
    const [left, right] = drawPair();
    const voices = pickVoices();
    state.round = { left, right, voices, listens: 0, buffers: null, startedAt: Date.now() };
    state.retellStep = null;

    $('#listen-title').textContent = 'Get ready';
    $('#listen-status').textContent = 'Loading audio…';
    $('#listen-error').hidden = true;
    $('#play-both').hidden = false; $('#play-both').disabled = true;
    $('#stop-play').hidden = true; $('#replay').hidden = true; $('#go-retell').hidden = true;
    $('#ear-left .voice').textContent = VOICE_LABELS[voices[0]] || voices[0];
    $('#ear-right .voice').textContent = VOICE_LABELS[voices[1]] || voices[1];
    setProgress({ left: 0, right: 0, t: 0, durL: 0, durR: 0 });
    show('listen');

    try {
      audio.ensure(); // inside the click handler so the context is allowed to start
      const [bl, br] = await Promise.all([
        audio.load(`audio/${left.id}-${voices[0]}.mp3`),
        audio.load(`audio/${right.id}-${voices[1]}.mp3`),
      ]);
      state.round.buffers = { left: bl, right: br };
      const rate = parseFloat(settings.speed);
      $('#ear-left .time').textContent = fmtTime(bl.duration / rate);
      $('#ear-right .time').textContent = fmtTime(br.duration / rate);
      $('#listen-status').textContent = `Ready. Both stories are about ${fmtTime(Math.max(bl.duration, br.duration) / rate)} long.`;
      $('#play-both').disabled = false;
      $('#play-both').focus();
    } catch (e) {
      $('#listen-error').textContent = e.message;
      $('#listen-error').hidden = false;
      $('#listen-status').textContent = '';
    }
  }

  function setProgress(p) {
    $('#ear-left .fill').style.width = `${p.left * 100}%`;
    $('#ear-right .fill').style.width = `${p.right * 100}%`;
    if (p.durL) $('#ear-left .time').textContent = `${fmtTime(Math.min(p.t, p.durL))} / ${fmtTime(p.durL)}`;
    if (p.durR) $('#ear-right .time').textContent = `${fmtTime(Math.min(p.t, p.durR))} / ${fmtTime(p.durR)}`;
    $('#ear-left').classList.toggle('playing', p.left > 0 && p.left < 1);
    $('#ear-right').classList.toggle('playing', p.right > 0 && p.right < 1);
  }

  function playBoth() {
    const r = state.round;
    if (!r || !r.buffers) return;
    const rate = parseFloat(settings.speed);
    r.listens += 1;
    $('#listen-title').textContent = r.listens === 1 ? 'Listening…' : `Listening again (${r.listens})…`;
    $('#play-both').hidden = true; $('#replay').hidden = true; $('#go-retell').hidden = true;
    $('#stop-play').hidden = false;
    $('#listen-status').textContent = '';
    audio.playPair(r.buffers.left, r.buffers.right, rate, setProgress, () => {
      setProgress({ left: 1, right: 1, t: 0, durL: 0, durR: 0 });
      $('#ear-left').classList.remove('playing'); $('#ear-right').classList.remove('playing');
      $('#listen-title').textContent = 'Done listening';
      $('#stop-play').hidden = true;
      $('#go-retell').hidden = false;
      if (settings.replay === 'allowed') {
        $('#replay').hidden = false;
        $('#listen-status').textContent = `Each extra listen multiplies your score by ${G.REPLAY_MULTIPLIER}.`;
      }
      $('#go-retell').focus();
    });
  }

  function stopPlayback() {
    audio.stop();
    $('#stop-play').hidden = true;
    $('#ear-left').classList.remove('playing'); $('#ear-right').classList.remove('playing');
    $('#listen-title').textContent = 'Stopped';
    $('#go-retell').hidden = false;
    if (settings.replay === 'allowed') $('#replay').hidden = false;
    $('#listen-status').textContent = 'You stopped early. You can still retell what you heard.';
  }

  function abandonRound() {
    audio.stop();
    state.round = null;
    show('setup');
  }

  // ---------- retell ----------
  function goRetell() {
    audio.stop();
    $('#retell-left').value = ''; $('#retell-right').value = '';
    $$('.interim').forEach((el) => { el.textContent = ''; });
    updateWordCounts();
    $('#retell-error').hidden = true;
    const order = settings.order;
    const grid = $('#retell-grid');
    const left = $('.retell[data-side="left"]'), right = $('.retell[data-side="right"]');
    if (order === 'both') {
      left.hidden = false; right.hidden = false; $('#retell-next').hidden = true; $('#grade').hidden = false;
      state.retellStep = null;
      grid.style.gridTemplateColumns = '';
    } else {
      state.retellStep = order;
      left.hidden = order !== 'left'; right.hidden = order !== 'right';
      $('#retell-next').hidden = false; $('#grade').hidden = true;
      grid.style.gridTemplateColumns = '1fr';
    }
    show('retell');
    const first = order === 'right' ? $('#retell-right') : $('#retell-left');
    setTimeout(() => first.focus(), 50);
  }

  function retellNext() {
    stopDictation();
    const other = state.retellStep === 'left' ? 'right' : 'left';
    $('.retell[data-side="left"]').hidden = other !== 'left';
    $('.retell[data-side="right"]').hidden = other !== 'right';
    $('#retell-next').hidden = true; $('#grade').hidden = false;
    state.retellStep = other;
    $(`#retell-${other}`).focus();
  }

  function updateWordCounts() {
    ['left', 'right'].forEach((side) => {
      const n = $(`#retell-${side}`).value.trim().split(/\s+/).filter(Boolean).length;
      $(`.wc[data-side="${side}"]`).textContent = `${n} word${n === 1 ? '' : 's'}`;
    });
  }

  // Dictation via the Web Speech API (Chrome, Edge, Safari). Optional.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, recSide = null;
  function toggleDictation(side) {
    if (rec && recSide === side) { stopDictation(); return; }
    stopDictation();
    const ta = $(`#retell-${side}`);
    const btn = $(`.dictate[data-side="${side}"]`);
    const interim = $(`.interim[data-side="${side}"]`);
    rec = new SR();
    recSide = side;
    rec.lang = navigator.language && navigator.language.startsWith('en') ? navigator.language : 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      let finalText = '', interimText = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += t + ' '; else interimText += t;
      }
      if (finalText) {
        ta.value = (ta.value.replace(/\s+$/, '') + ' ' + finalText.trim()).trim() + ' ';
        updateWordCounts();
      }
      interim.textContent = interimText;
    };
    rec.onerror = (ev) => {
      interim.textContent = ev.error === 'not-allowed' ? 'Microphone access was denied.' : `Dictation error: ${ev.error}`;
      stopDictation(true);
    };
    rec.onend = () => { if (rec) stopDictation(true); };
    btn.classList.add('recording');
    btn.textContent = '■ Stop dictating';
    interim.textContent = 'Listening…';
    try { rec.start(); } catch (e) { interim.textContent = e.message; stopDictation(true); }
  }
  function stopDictation(keepMessage) {
    if (!rec) return;
    const r = rec, side = recSide;
    rec = null; recSide = null;
    r.onend = null;
    try { r.stop(); } catch (e) { /* ignore */ }
    const btn = $(`.dictate[data-side="${side}"]`);
    btn.classList.remove('recording');
    btn.textContent = '🎙 Dictate';
    if (!keepMessage) $(`.interim[data-side="${side}"]`).textContent = '';
  }

  // ---------- results ----------
  function grade() {
    stopDictation();
    const r = state.round;
    if (!r) { show('setup'); return; }
    const leftText = $('#retell-left').value, rightText = $('#retell-right').value;
    if (!leftText.trim() && !rightText.trim()) {
      const err = $('#retell-error');
      err.textContent = 'Write at least something for one ear, or abandon the round.';
      err.hidden = false;
      return;
    }
    const extra = Math.max(0, r.listens - 1);
    const result = G.gradeSession(r.left, r.right, leftText, rightText, extra);
    r.result = result;
    renderResults(result, extra);
    const entry = {
      at: Date.now(), left: cap(r.left.id), right: cap(r.right.id),
      score: G.pct(result.combined.score),
      c: G.pct(result.combined.completeness), a: G.pct(result.combined.accuracy), s: G.pct(result.combined.separation),
      listens: r.listens, speed: settings.speed, voices: settings.voices,
    };
    const hist = loadJSON(LS.history, []);
    hist.unshift(entry);
    saveJSON(LS.history, hist.slice(0, 200));
    show('results');
  }

  function verdict(score) {
    if (score >= 90) return 'Split-brain. Outstanding.';
    if (score >= 75) return 'Both lives accounted for.';
    if (score >= 55) return 'Solid. One ear got more love than the other.';
    if (score >= 35) return 'Pieces of both. Keep practising.';
    return 'That was a lot of information at once.';
  }

  function renderResults(res, extra) {
    const c = res.combined;
    const score = G.pct(c.score);
    $('#score-number').textContent = score;
    $('#score-ring').style.setProperty('--p', score);
    $('#score-verdict').textContent = verdict(score);
    const set = (name, v) => { $(`#m-${name}`).style.width = `${G.pct(v)}%`; $(`#v-${name}`).textContent = `${G.pct(v)}%`; };
    set('completeness', c.completeness); set('accuracy', c.accuracy); set('separation', c.separation);
    const notes = [];
    if (extra > 0) notes.push(`${extra} extra listen${extra > 1 ? 's' : ''}: score ×${c.replayMultiplier.toFixed(2)} (raw ${G.pct(c.raw)}).`);
    if (c.balance >= 0.3) {
      const better = res.left.completeness > res.right.completeness ? 'left' : 'right';
      notes.push(`You recalled far more from the ${better} ear (${G.pct(res.left.completeness)}% vs ${G.pct(res.right.completeness)}%). Try deliberately splitting attention next time.`);
    }
    const crossups = res.left.crossups + res.right.crossups;
    if (crossups) notes.push(`${crossups} detail${crossups > 1 ? 's' : ''} landed in the wrong ear.`);
    $('#score-notes').textContent = notes.join(' ');

    const r = state.round;
    renderEar($('#result-left'), 'left', r.left, res.left, r.voices[0]);
    renderEar($('#result-right'), 'right', r.right, res.right, r.voices[1]);
  }

  function renderEar(el, side, story, g, voice) {
    el.dataset.side = side;
    const facts = g.facts.map((f) =>
      `<li class="${f.hit ? 'hit' : 'miss'}"><span class="mark">${f.hit ? '✓' : '✗'}</span><span>${esc(f.label)}${f.hit && f.key ? ` <span class="via">(matched “${esc(f.key)}”)</span>` : ''}</span></li>`
    ).join('');
    const intrusions = g.intrusions.map((i) =>
      `<li class="warn"><span class="mark">⇄</span><span>${esc(i.label)} <span class="via">— that is the other story (you wrote “${esc(i.key)}”)</span></span></li>`
    ).join('');
    const stray = g.strayNumbers.map((n) =>
      `<li class="warn"><span class="mark">#</span><span>“${esc(n.value)}” ${n.fromOther ? 'is a number from the other story' : 'does not appear in this story'}</span></li>`
    ).join('');
    const problems = intrusions + stray;
    el.innerHTML = `
      <h3>${side === 'left' ? '◀ Left ear' : 'Right ear ▶'}: ${esc(story.title)}</h3>
      <div class="ear-score">${G.pct(g.score)} <small>· ${g.hits}/${g.total} details · completeness ${G.pct(g.completeness)}% · accuracy ${G.pct(g.accuracy)}% · separation ${G.pct(g.separation)}%</small></div>
      <h4>Details</h4>
      <ul class="facts">${facts}</ul>
      ${problems ? `<h4>Problems</h4><ul class="facts">${problems}</ul>` : ''}
      <h4>Your retelling, as the grader read it</h4>
      <p class="legend"><mark>matched</mark> <mark class="intrusion">other story</mark> <mark class="stray">unverified number</mark></p>
      <div class="retelling-view">${renderTokens(g)}</div>
      <details open>
        <summary>Show the full story (${esc(VOICE_LABELS[voice] || voice)})</summary>
        <p>${esc(story.text)}</p>
      </details>`;
  }

  function renderTokens(g) {
    if (!g.tokens.length) return '<em class="muted">(nothing written)</em>';
    const cls = new Array(g.tokens.length).fill('');
    const paint = (spans, name) => spans.forEach(([a, b]) => { for (let i = a; i <= b; i++) if (!cls[i]) cls[i] = name; });
    paint(g.intrusions.flatMap((i) => i.spans.map((s) => s.span)), 'intrusion');
    paint(g.facts.filter((f) => f.hit).flatMap((f) => f.spans.map((s) => s.span)), 'hit');
    g.strayNumbers.forEach((n) => { if (!cls[n.index]) cls[n.index] = 'stray'; });
    const runs = [];
    g.tokens.forEach((t, i) => {
      const last = runs[runs.length - 1];
      if (last && last.cls === cls[i]) last.tokens.push(t); else runs.push({ cls: cls[i], tokens: [t] });
    });
    return runs.map((r) => {
      const text = esc(r.tokens.join(' '));
      return r.cls ? `<mark class="${r.cls === 'hit' ? '' : r.cls}">${text}</mark>` : text;
    }).join(' ');
  }

  // ---------- wiring ----------
  function init() {
    bindSettings();
    renderHistory();
    $('#check-left').addEventListener('click', () => headphoneCheck('left'));
    $('#check-right').addEventListener('click', () => headphoneCheck('right'));
    $('#start-round').addEventListener('click', startRound);
    $('#play-both').addEventListener('click', playBoth);
    $('#replay').addEventListener('click', playBoth);
    $('#stop-play').addEventListener('click', stopPlayback);
    $('#go-retell').addEventListener('click', goRetell);
    $('#abandon').addEventListener('click', abandonRound);
    $('#retell-next').addEventListener('click', retellNext);
    $('#grade').addEventListener('click', grade);
    $('#new-round').addEventListener('click', startRound);
    $('#back-home').addEventListener('click', () => { renderHistory(); show('setup'); });
    $('#clear-history').addEventListener('click', () => {
      if (confirm('Clear your round history?')) { saveJSON(LS.history, []); renderHistory(); }
    });
    ['left', 'right'].forEach((side) => $(`#retell-${side}`).addEventListener('input', updateWordCounts));
    if (SR) {
      $$('.dictate').forEach((b) => { b.hidden = false; b.addEventListener('click', () => toggleDictation(b.dataset.side)); });
    }
    $('#show-scoring').addEventListener('click', (e) => { e.preventDefault(); $('#scoring-dialog').showModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === ' ' && state.phase === 'listen' && !$('#play-both').hidden && !$('#play-both').disabled && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault(); playBoth();
      }
    });
    if (!STORIES.length) {
      const err = $('#setup-error');
      err.textContent = 'stories.js is missing or empty. Run: python3 tools/build_audio.py --voices-dir <voices>';
      err.hidden = false;
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
