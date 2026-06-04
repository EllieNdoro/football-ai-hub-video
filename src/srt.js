// Build an SRT subtitle string from word-level captions.
// captions = [{t: number(sec), text: string}, ...]
// Groups consecutive words into ~3-word cues for readability.

function fmt(sec) {
  if (sec < 0) sec = 0;
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function buildSrt(captions, totalDurationSeconds) {
  if (!Array.isArray(captions) || captions.length === 0) return '';
  const GROUP = 3;
  const groups = [];
  for (let i = 0; i < captions.length; i += GROUP) {
    const slice = captions.slice(i, i + GROUP);
    const start = slice[0].t;
    const last = slice[slice.length - 1];
    const next = captions[i + GROUP];
    const end = next ? next.t : Math.min(last.t + 1.5, totalDurationSeconds);
    const text = slice.map(c => c.text).join(' ');
    groups.push({ start, end, text });
  }
  return groups.map((g, idx) => `${idx + 1}\n${fmt(g.start)} --> ${fmt(g.end)}\n${g.text}\n`).join('\n');
}

module.exports = { buildSrt };
