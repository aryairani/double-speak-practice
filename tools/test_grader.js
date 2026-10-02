#!/usr/bin/env node
// Unit tests for grader.js. Run: node tools/test_grader.js
const assert = require('assert');
const G = require('../grader.js');
const stories = require('../data/stories.json');
const byId = Object.fromEntries(stories.map((s) => [s.id, s]));

// normalization
assert.deepStrictEqual(G.normalize('Forty-one years, 3,000 babies'), ['41', 'years', '3000', 'babies']);
assert.deepStrictEqual(G.normalize('two million miles'), ['2000000', 'miles']);
assert.deepStrictEqual(G.normalize('the sixth of seven'), ['the', '6th', 'of', '7']);
assert.deepStrictEqual(G.normalize("ship's cook in Tromsø"), ['ships', 'cook', 'in', 'tromso']);
assert.deepStrictEqual(G.normalize('one two three'), ['1', '2', '3']);
assert.deepStrictEqual(G.normalize('a hundred and twelve'), ['112']);
assert.deepStrictEqual(G.normalize('at 17 she'), ['at', '17', 'she']);

// token matching
assert(G.tokensMatch('typewriters', 'typewriter'));
assert(G.tokensMatch('marisol', 'marisol'));
assert(G.tokensMatch('typewritter', 'typewriter'));
assert(!G.tokensMatch('tiles', 'times'));
assert(!G.tokensMatch('ghana', 'hana'));
assert(!G.tokensMatch('17', '7'));

// phrase matching with gaps
assert.deepStrictEqual(G.findPhrase(G.normalize('she sells hand painted ceramic tiles'), G.normalize('painted tiles')), [3, 5]);
assert.strictEqual(G.findPhrase(G.normalize('grain and some other words then harbor'), G.normalize('grain harbor')), null);

// grading a good retelling
const m = byId.marisol, t = byId.tobias;
const good = 'Marisol was from Duluth Minnesota, the youngest of four kids. At seventeen she worked at the grain harbor and became a welder. She married Oskar who drove a tugboat. At 41 they moved to Lisbon and she sells tiles. She fixes old typewriters and has a parrot called Biscuit.';
const r = G.gradeEar(m, t, good);
assert.strictEqual(r.hits, r.total, JSON.stringify(r.facts.filter((f) => !f.hit)));
assert.strictEqual(r.crossups, 0);
assert.strictEqual(r.wrong, 0);
assert(r.score > 0.99);

// a retelling that mixes in the other story
const mixed = 'Marisol grew up in Duluth and studied astronomy in Edinburgh. She has a parrot named Biscuit and twelve marathons.';
const r2 = G.gradeEar(m, t, mixed);
assert.strictEqual(r2.hits, 3);
assert(r2.intrusions.length >= 2, JSON.stringify(r2.intrusions));
assert(r2.separation < 0.6);

// stray numbers: wrong age is penalized, own numbers are not
const r3 = G.gradeEar(m, t, 'Marisol moved to Lisbon when she was 52.');
assert.strictEqual(r3.wrong, 1);
assert.strictEqual(G.gradeEar(m, t, 'Marisol moved to Lisbon when she was 41.').wrong, 0);

// shared generic word is not an intrusion when the own story explains it
const b = byId.beatrice, n = byId.nadia;
const r4 = G.gradeEar(b, n, 'Beatrice has a one-eyed cat named Ferragosto');
assert.strictEqual(r4.intrusions.length, 0);

// empty retelling
const r5 = G.gradeEar(m, t, '');
assert.strictEqual(r5.score, 0);
assert.strictEqual(r5.hits, 0);

// session
const s = G.gradeSession(m, t, good, 'Tobias is from Bern and teaches physics in Portland', 1);
assert(Math.abs(s.combined.replayMultiplier - 0.85) < 1e-9);
assert(s.combined.score < s.combined.raw);

// every story: its own text scores full completeness, and no intrusions from any other story
for (const a of stories) {
  for (const o of stories) {
    if (a === o) continue;
    const g = G.gradeEar(a, o, a.text);
    assert.strictEqual(g.hits, g.total, `${a.id} self-retelling misses: ${g.facts.filter((f) => !f.hit).map((f) => f.label)}`);
    assert.strictEqual(g.intrusions.length, 0, `${a.id} vs ${o.id} intrusions: ${g.intrusions.map((i) => i.key)}`);
    assert.strictEqual(g.wrong, 0, `${a.id} stray numbers ${JSON.stringify(g.strayNumbers)}`);
  }
}
console.log('grader tests passed');
