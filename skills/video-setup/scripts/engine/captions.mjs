// Word timings and caption splitting, shared by every video type.

// Map each scripted word onto Whisper's timings by character position, so the captions keep
// the script's own spelling ("Kubectl", "seventeen", "organisation"). Times are divided by tempo.
export function wordTimes(clip, tempo) {
  const heard = clip.words;
  const heardLen = heard.reduce((n, w) => n + w.word.length + 1, 0);
  const marks = [];
  let pos = 0;
  for (const w of heard) {
    marks.push({ at: pos / heardLen, start: w.start, end: w.end });
    pos += w.word.length + 1;
  }
  const words = clip.text.split(/\s+/);
  // Whisper heard every word separately: pair them up directly.
  if (heard.length === words.length) return words.map((word, i) => ({ word, start: heard[i].start / tempo }));
  const textLen = words.reduce((n, w) => n + w.length + 1, 0);
  let p = 0;
  return words.map((word) => {
    const frac = p / textLen;
    p += word.length + 1;
    // The nearest heard word, so a word Whisper merges ("Kubectl" heard as "CubeCuttle")
    // does not pull the next word back onto its own start.
    const m = marks.reduce((best, mk) => (Math.abs(mk.at - frac) < Math.abs(best.at - frac) ? mk : best));
    return { word, start: m.start / tempo };
  });
}

// Break at sentence and clause ends, then split any long phrase into even parts of at most
// maxWords, so no caption is left as a one-word fragment.
export function chunk(words, maxWords) {
  const phrases = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (/[.:?]$/.test(w.word) || (/,$/.test(w.word) && cur.length >= 3)) {
      phrases.push(cur);
      cur = [];
    }
  }
  if (cur.length) phrases.push(cur);
  return phrases.flatMap((p) => {
    const parts = Math.ceil(p.length / maxWords);
    const size = Math.ceil(p.length / parts);
    return Array.from({ length: parts }, (_, i) => p.slice(i * size, (i + 1) * size));
  });
}

// Captions show the written form of what is spoken: "example dot com" becomes "example.com".
export const written = (text, forms) => Object.entries(forms).reduce((s, [spoken, shown]) => s.replaceAll(spoken, shown), text);

// The text the voice reads: names are spelt the way they are said. Matching ignores case.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const spoken = (text, forms) => Object.entries(forms).reduce((s, [name, said]) => s.replace(new RegExp(escape(name), "gi"), said), text);

// A cue word as film pages look it up: lower case, letters, digits and hyphens.
export const cueWord = (word) => word.toLowerCase().replace(/[^a-z0-9-]/g, "");
