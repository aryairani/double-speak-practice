# Double Speak

A browser game for dichotic listening practice. Two short, unrelated life stories are read to you **at the same time**, one in each ear. When they finish you retell both stories (typed or dictated) and get graded on:

- **Completeness**: how many of each story's details you recalled.
- **Accuracy**: how few wrong details you added.
- **Separation**: how little you mixed the two stories up (each detail that lands in the wrong ear costs 25%).

Everything runs in the browser. No account, no server, nothing uploaded.

## Play

Serve the folder over HTTP (browsers block audio decoding from `file://`):

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Put on headphones, use the headphone check to confirm left and right, pick your settings and start a round.

The `main` branch deploys automatically to GitHub Pages via `.github/workflows/pages.yml`
(enable Pages with source "GitHub Actions" in the repository settings).

### Settings

| Setting | Options |
|---|---|
| Voices | different voice per ear (easier) or the same voice in both (harder) |
| Speed | 0.85× to 1.3× |
| Replays | listen once only, or allow replays at ×0.85 score per extra listen |
| Retell order | both ears side by side, or one ear at a time |

Dictation uses the Web Speech API and appears only in browsers that support it (Chrome, Edge, Safari).

## How grading works

Each story in `data/stories.json` has 9–11 facts, each with a list of key phrases. The grader (`grader.js`) normalizes your retelling (lowercase, strip punctuation and accents, spell-out numbers become digits, plurals ignored, small typos in longer words tolerated) and looks for each key phrase, allowing a couple of words between the phrase's tokens.

For each ear:

```
completeness = facts matched / facts total
accuracy     = facts matched / (facts matched + other-story facts found + numbers in neither story)
separation   = 1 − 0.25 × other-story details found      (0 if nothing was attributable at all)
ear score    = 0.5·completeness + 0.3·accuracy + 0.2·separation
```

Round score = average of both ears × 0.85 per extra listen. A detail from the *other* story only counts as a mix-up when the same words are not already explained by a fact of the ear's own story (so two stories that both have a cat do not penalize "cat").

Results show every fact as hit or missed, every mix-up, and your retelling with matches highlighted, so you can see exactly what the grader did.

## Project layout

```
index.html, style.css, app.js   the app (no build step)
grader.js                       scoring; shared with Node for tests and validation
stories.js                      generated from data/stories.json by tools/build_audio.py
data/stories.json               the story library: text, title and graded facts
audio/<story>-<voice>.mp3       synthesized narration, one file per story per voice
tools/build_audio.py            synthesizes audio with Piper and writes stories.js
tools/validate.js               checks that facts match their story and do not collide across stories
tools/test_grader.js            unit tests for the grader
```

## Adding or editing stories

1. Edit `data/stories.json`. Keep stories around 90–100 words, with 9–11 facts. Give each fact several key spellings. Avoid reusing names, places and distinctive numbers from other stories; `node tools/validate.js` fails if a key phrase appears in another story's text without that story also keying it.
2. Run `node tools/validate.js` and `node tools/test_grader.js`.
3. Regenerate audio and `stories.js`:

```sh
pip install piper-tts
# voices: the sherpa-onnx "tts-models" release repackages the Piper voices with their .onnx.json
mkdir -p voices && cd voices
for v in vits-piper-en_US-lessac-medium vits-piper-en_US-ryan-medium; do
  curl -L -o $v.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/$v.tar.bz2 && tar xjf $v.tar.bz2
done
cd ..
python3 tools/build_audio.py --voices-dir voices        # add --force to re-synthesize changed stories
```

## Credits

Narration is synthesized with [Piper](https://github.com/rhasspy/piper) using the `en_US-lessac-medium` and `en_US-ryan-medium` voices. All people and stories are fictional.
