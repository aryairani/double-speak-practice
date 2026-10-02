/*
 * Double Speak grader.
 * Deterministic, dictionary-free scoring of a retelling against a story's fact list.
 * Works in the browser (window.Grader) and in Node (module.exports) so the same code
 * can be unit-tested and used by the library validator.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Grader = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- text normalization ----------

  const UNITS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19,
  };
  const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  const SCALES = { hundred: 100, thousand: 1000, million: 1000000, billion: 1000000000 };
  const ORDINALS = {
    first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th', sixth: '6th', seventh: '7th',
    eighth: '8th', ninth: '9th', tenth: '10th', eleventh: '11th', twelfth: '12th', thirteenth: '13th',
    fourteenth: '14th', fifteenth: '15th', sixteenth: '16th', seventeenth: '17th', eighteenth: '18th',
    nineteenth: '19th', twentieth: '20th', thirtieth: '30th', fortieth: '40th', fiftieth: '50th',
  };
  const CHAR_MAP = { 'ø': 'o', 'æ': 'ae', 'ß': 'ss', 'ł': 'l', 'đ': 'd', 'œ': 'oe', 'þ': 'th' };

  function stripDiacritics(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[øæßłđœþ]/g, (c) => CHAR_MAP[c] || c);
  }

  function isDigits(t) { return /^\d+$/.test(t); }

  // Collapse spelled-out numbers ("forty one", "two million", "3 thousand") into digit tokens.
  function collapseNumbers(tokens) {
    const out = [];
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      const startsGroup = isDigits(t) || t in UNITS || t in TENS || t in SCALES ||
        (t === 'a' && i + 1 < tokens.length && tokens[i + 1] in SCALES);
      if (!startsGroup) { out.push(t); i++; continue; }
      let total = 0, current = 0, j = i, consumed = 0, sawScaleOrWord = false, lastWasDigits = false;
      while (j < tokens.length) {
        const w = tokens[j];
        if (w === 'a' && j === i) { current = 1; j++; consumed++; continue; }
        if (w === 'and' && consumed > 0 && j + 1 < tokens.length &&
            (tokens[j + 1] in UNITS || tokens[j + 1] in TENS) && sawScaleOrWord) { j++; consumed++; continue; }
        if (isDigits(w)) {
          if (lastWasDigits || (consumed > 0 && !sawScaleOrWord && current !== 0)) break; // "12 15" stays separate
          current += parseInt(w, 10); lastWasDigits = true; j++; consumed++; continue;
        }
        lastWasDigits = false;
        if (w in UNITS) {
          if (current % 100 !== 0 && current !== 0 && !(current >= 20 && current % 10 === 0)) break; // "one two" stays separate
          current += UNITS[w]; sawScaleOrWord = true; j++; consumed++; continue;
        }
        if (w in TENS) {
          if (current !== 0 && current % 100 !== 0) break;
          current += TENS[w]; sawScaleOrWord = true; j++; consumed++; continue;
        }
        if (w in SCALES) {
          if (current === 0) current = 1;
          if (SCALES[w] === 100) current *= 100; else { total += current * SCALES[w]; current = 0; }
          sawScaleOrWord = true; j++; consumed++; continue;
        }
        break;
      }
      if (consumed === 0) { out.push(t); i++; continue; }
      out.push(String(total + current));
      i = j;
    }
    return out;
  }

  function normalize(text) {
    let s = stripDiacritics(String(text || '').toLowerCase());
    s = s.replace(/(\d),(\d)/g, '$1$2');          // 3,000 -> 3000
    s = s.replace(/['’`]/g, '');                   // ship's -> ships
    s = s.replace(/[-_/–—]/g, ' ');                // hand-painted -> hand painted
    s = s.replace(/[^a-z0-9\s]/g, ' ');
    let tokens = s.split(/\s+/).filter(Boolean);
    tokens = tokens.map((t) => ORDINALS[t] || t);
    return collapseNumbers(tokens);
  }

  // ---------- fuzzy token matching ----------

  function editDistance(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 2) return 3;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }

  function singular(t) {
    if (t.length >= 5 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
    if (t.length >= 5 && t.endsWith('es') && /(s|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
    if (t.length >= 4 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
    return t;
  }

  // Exact match, plural-insensitive match, or (for longer words) a one-character typo
  // with the same first letter. Numbers must match exactly.
  function tokensMatch(a, b) {
    if (a === b) return true;
    if (isDigits(a) || isDigits(b)) return false;
    const sa = singular(a), sb = singular(b);
    if (sa === sb) return true;
    if (a[0] !== b[0]) return false;
    const len = Math.max(sa.length, sb.length);
    if (len < 6) return false;
    const allowed = len >= 10 ? 2 : 1;
    return editDistance(sa, sb) <= allowed;
  }

  // Find key phrase in tokens. Allows up to `gap` extra tokens between consecutive key tokens.
  // Returns [start, end] (inclusive) or null.
  function findPhrase(tokens, key, gap, from) {
    gap = gap == null ? 2 : gap;
    from = from || 0;
    if (!key.length) return null;
    for (let i = from; i < tokens.length; i++) {
      if (!tokensMatch(tokens[i], key[0])) continue;
      let pos = i, ok = true;
      for (let k = 1; k < key.length; k++) {
        let found = -1;
        for (let d = 1; d <= gap + 1 && pos + d < tokens.length; d++) {
          if (tokensMatch(tokens[pos + d], key[k])) { found = pos + d; break; }
        }
        if (found < 0) { ok = false; break; }
        pos = found;
      }
      if (ok) return [i, pos];
    }
    return null;
  }

  function findAllPhrase(tokens, key, gap) {
    const spans = [];
    let from = 0;
    for (;;) {
      const span = findPhrase(tokens, key, gap, from);
      if (!span) break;
      spans.push(span);
      from = span[0] + 1;
    }
    return spans;
  }

  function overlaps(a, b) { return a[0] <= b[1] && b[0] <= a[1]; }

  // All spans in `tokens` where any key of `fact` matches.
  function factSpans(tokens, fact) {
    const spans = [];
    for (const key of fact.keys) {
      const kt = normalize(key);
      for (const s of findAllPhrase(tokens, kt)) spans.push({ span: s, key });
    }
    return spans;
  }

  // ---------- grading ----------

  const WEIGHTS = { completeness: 0.5, accuracy: 0.3, separation: 0.2 };
  const INTRUSION_COST = 0.25;   // each mixed-up detail costs this much of the separation score
  const REPLAY_MULTIPLIER = 0.85; // per extra listen

  function gradeEar(story, otherStory, retelling) {
    const tokens = normalize(retelling);
    const facts = story.facts.map((f) => {
      const spans = factSpans(tokens, f);
      return { label: f.label, hit: spans.length > 0, spans, key: spans.length ? spans[0].key : null };
    });
    const hitSpans = facts.filter((f) => f.hit).flatMap((f) => f.spans.map((s) => s.span));

    // Intrusions: facts from the other story found at positions not already explained by this story.
    const intrusions = [];
    for (const f of otherStory.facts) {
      const spans = factSpans(tokens, f).filter((s) => !hitSpans.some((h) => overlaps(h, s.span)));
      if (spans.length) intrusions.push({ label: f.label, key: spans[0].key, spans });
    }
    const intrusionSpans = intrusions.flatMap((f) => f.spans.map((s) => s.span));

    // Numbers the player used that this story never states.
    const storyNums = new Set(normalize(story.text).filter(isDigits));
    const otherNums = new Set(normalize(otherStory.text).filter(isDigits));
    const strayNumbers = [];
    tokens.forEach((t, i) => {
      if (!isDigits(t) || parseInt(t, 10) < 2 || storyNums.has(t)) return;
      const inHit = hitSpans.some((h) => i >= h[0] && i <= h[1]);
      const inIntrusion = intrusionSpans.some((h) => i >= h[0] && i <= h[1]);
      if (inHit || inIntrusion) return;
      strayNumbers.push({ value: t, index: i, fromOther: otherNums.has(t) });
    });

    const hits = facts.filter((f) => f.hit).length;
    const total = facts.length;
    const crossups = intrusions.length + strayNumbers.filter((n) => n.fromOther).length;
    const wrong = strayNumbers.filter((n) => !n.fromOther).length;
    const errors = crossups + wrong;

    const completeness = total ? hits / total : 0;
    const accuracy = hits + errors > 0 ? hits / (hits + errors) : 0;
    // Separation is only meaningful once something was attributed to an ear: an empty or
    // entirely unrelated retelling earns nothing for "not mixing the stories up".
    const separation = hits + crossups > 0 ? Math.max(0, 1 - crossups * INTRUSION_COST) : 0;
    const score = WEIGHTS.completeness * completeness + WEIGHTS.accuracy * accuracy + WEIGHTS.separation * separation;

    return {
      tokens, facts, intrusions, strayNumbers,
      hits, total, crossups, wrong,
      completeness, accuracy, separation, score,
      wordCount: tokens.length,
    };
  }

  function gradeSession(leftStory, rightStory, leftText, rightText, extraListens) {
    const left = gradeEar(leftStory, rightStory, leftText);
    const right = gradeEar(rightStory, leftStory, rightText);
    const replayMultiplier = Math.pow(REPLAY_MULTIPLIER, Math.max(0, extraListens || 0));
    const raw = (left.score + right.score) / 2;
    const combined = {
      completeness: (left.completeness + right.completeness) / 2,
      accuracy: (left.accuracy + right.accuracy) / 2,
      separation: (left.separation + right.separation) / 2,
      raw,
      replayMultiplier,
      score: raw * replayMultiplier,
      balance: Math.abs(left.completeness - right.completeness),
    };
    return { left, right, combined };
  }

  function pct(x) { return Math.round(x * 100); }

  return {
    normalize, editDistance, tokensMatch, findPhrase, findAllPhrase, factSpans,
    gradeEar, gradeSession, pct,
    WEIGHTS, INTRUSION_COST, REPLAY_MULTIPLIER,
  };
});
