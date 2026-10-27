// Tests for caption splitting and the spoken and written forms of names.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunk, written, spoken, wordTimes, cueWord } from "../engine/captions.mjs";

const w = (text) => text.split(" ").map((word, i) => ({ word, start: i }));
const words = (groups) => groups.map((g) => g.map((x) => x.word).join(" "));

describe("captions", () => {
  it("breaks at sentence ends and at commas after three words", () => {
    assert.deepEqual(words(chunk(w("Every claim is labelled: told, shown or measured. It helps."), 7)), ["Every claim is labelled:", "told, shown or measured.", "It helps."]);
    assert.deepEqual(words(chunk(w("We build it, test it, and ship it."), 7)), ["We build it,", "test it, and ship it."]);
  });

  it("splits a long phrase into even parts, never a stranded word", () => {
    const parts = chunk(w("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen"), 7);
    assert.deepEqual(parts.map((p) => p.length), [5, 5, 5]);
  });

  it("shows written forms and speaks spoken forms", () => {
    assert.equal(written("Book at example dot com.", { "example dot com": "example.com" }), "Book at example.com.");
    assert.equal(spoken("Nginx and PostgreSQL.", { Nginx: "engine X", PostgreSQL: "postgres Q L" }), "engine X and postgres Q L.");
    assert.equal(spoken("nginx", { Nginx: "engine X" }), "engine X");
  });

  it("keeps the script's spelling when Whisper merges words", () => {
    const clip = { text: "Kubectl helps leaders.", words: [{ word: "CubeCuttle", start: 0, end: 0.5 }, { word: "helps", start: 0.6, end: 0.8 }, { word: "leaders", start: 0.9, end: 1.2 }] };
    const timed = wordTimes(clip, 1);
    assert.deepEqual(timed.map((x) => x.word), ["Kubectl", "helps", "leaders."]);
    assert.deepEqual(timed.map((x) => x.start), [0, 0.6, 0.9]);
    assert.equal(cueWord("Leaders."), "leaders");
  });
});
