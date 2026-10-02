#!/usr/bin/env node
// Validates data/stories.json: every fact key must match its own story's text,
// and reports keys that also match another story's text (ambiguous for cross-contamination scoring).
const fs = require('fs');
const path = require('path');
const G = require('../grader.js');

const file = path.join(__dirname, '..', 'data', 'stories.json');
const stories = JSON.parse(fs.readFileSync(file, 'utf8'));
let errors = 0, warnings = 0;

const ids = new Set();
for (const s of stories) {
  if (ids.has(s.id)) { console.error(`ERROR duplicate id ${s.id}`); errors++; }
  ids.add(s.id);
  const tokens = G.normalize(s.text);
  for (const f of s.facts) {
    const own = f.keys.filter((k) => G.findPhrase(tokens, G.normalize(k)));
    if (!own.length) { console.error(`ERROR [${s.id}] no key of "${f.label}" matches its own text: ${JSON.stringify(f.keys)}`); errors++; }
  }
}

// Cross-story collisions. A key colliding with another story's text would score a correct retelling
// as a cross-up when that pair is drawn. Names/places must never collide; generic words are tolerated
// because the grader only counts an intrusion when the span is not already explained by the own story.
for (const a of stories) {
  for (const b of stories) {
    if (a === b) continue;
    const bt = G.normalize(b.text);
    for (const f of a.facts) {
      for (const k of f.keys) {
        const kt = G.normalize(k);
        if (G.findPhrase(bt, kt)) {
          // Tolerated only when the other story keys the same word itself (both have a cat, say):
          // the grader then explains the span with the own-story hit and counts no intrusion.
          const shared = b.facts.some((g) => g.keys.some((k2) => {
            const t2 = G.normalize(k2);
            return t2.length === kt.length && t2.every((x, i) => G.tokensMatch(x, kt[i]));
          }));
          if (shared) { console.warn(`WARN  key "${k}" of [${a.id}] is also a key of [${b.id}] (tolerated)`); warnings++; }
          else { console.error(`ERROR key "${k}" of [${a.id}] "${f.label}" matches text of [${b.id}] but is not one of its keys`); errors++; }
        }
      }
    }
  }
}
console.log(`${stories.length} stories, ${stories.reduce((n, s) => n + s.facts.length, 0)} facts, ${errors} errors, ${warnings} collision warnings`);
process.exit(errors ? 1 : 0);
