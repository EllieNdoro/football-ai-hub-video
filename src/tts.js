// TTS: Python edge-tts subprocess (primary) + gTTS HTTP (fallback) + silence (last resort).
// Python edge-tts uses the official Microsoft endpoint reliably from cloud containers.
const { spawnSync, spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Peter Drury-style: calm, confident British male
const VOICE_MAP = {
  hype_male:        'en-GB-RyanNeural',     // was en-US-Guy; flipped to British calm for Peter Drury feel
  calm_analyst:     'en-GB-RyanNeural',
  female_energetic: 'en-US-AvaNeural',
  british_pundit:   'en-GB-RyanNeural',
  spanish_latin:    'es-MX-JorgeNeural',
  peter_drury:      'en-GB-RyanNeural',
};
const RATE_MAP = {
  hype_male:        '-2%',   // calmer pace
  calm_analyst:     '-2%',
  female_energetic: '+10%',
  british_pundit:   '-2%',
  spanish_latin:    '+6%',
  peter_drury:      '-4%',
};
const PITCH_MAP = {
  hype_male:        '-2Hz',
  calm_analyst:     '0Hz',
  female_energetic: '+10Hz',
  british_pundit:   '-2Hz',
  spanish_latin:    '0Hz',
  peter_drury:      '-3Hz',
};
const GTTS_LANG = {
  hype_male: 'en-gb', calm_analyst: 'en-gb', female_energetic: 'en',
  british_pundit: 'en-gb', spanish_latin: 'es', peter_drury: 'en-gb',
};

function edgeTtsPython(text, voicePersona, outPath) {
  const voice = VOICE_MAP[voicePersona] || VOICE_MAP.british_pundit;
  const rate  = RATE_MAP[voicePersona]  || '-2%';
  const pitch = PITCH_MAP[voicePersona] || '-2Hz';

  // python -m edge_tts --text "..." --voice ... --rate ... --pitch ... --write-media OUT
  const r = spawnSync('python3', [
    '-m', 'edge_tts',
    '--text', text,
    '--voice', voice,
    '--rate', rate,
    '--pitch', pitch,
    '--write-media', outPath,
  ], { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 });
  if (r.status !== 0) {
    const err = r.stderr ? r.stderr.toString().slice(-600) : 'no stderr';
    throw new Error('python edge-tts exit ' + r.status + ': ' + err);
  }
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1024) {
    throw new Error('python edge-tts produced empty file');
  }
  return outPath;
}

function chunkText(text, maxLen) {
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]?/g) || [text];
  const chunks = [];
  let buf = '';
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    if (buf.length + 1 + t.length <= maxLen) buf = buf ? buf + ' ' + t : t;
    else {
      if (buf) chunks.push(buf);
      if (t.length > maxLen) {
        const words = t.split(' ');
        let wb = '';
        for (const w of words) {
          if (wb.length + 1 + w.length <= maxLen) wb = wb ? wb + ' ' + w : w;
          else { if (wb) chunks.push(wb); wb = w; }
        }
        if (wb) chunks.push(wb);
        buf = '';
      } else buf = t;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function gttsSynthesize(text, voicePersona, outPath) {
  const lang = GTTS_LANG[voicePersona] || 'en-gb';
  const chunks = chunkText(text, 180);
  const tmpFiles = [];
  for (let i = 0; i < chunks.length; i++) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodeURIComponent(chunks[i])}`;
    const resp = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
    });
    const tmp = outPath.replace(/\.mp3$/, `_chunk_${i}.mp3`);
    fs.writeFileSync(tmp, Buffer.from(resp.data));
    tmpFiles.push(tmp);
  }
  if (tmpFiles.length === 1) {
    fs.renameSync(tmpFiles[0], outPath);
  } else {
    const listFile = outPath.replace(/\.mp3$/, '_concat.txt');
    fs.writeFileSync(listFile, tmpFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    const r = spawnSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath], { stdio: 'pipe' });
    if (r.status !== 0) throw new Error('ffmpeg concat failed: ' + (r.stderr ? r.stderr.toString().slice(-400) : ''));
    fs.unlinkSync(listFile);
    tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
  }
  return outPath;
}

async function synthesize(text, voicePersona, outPath) {
  try {
    edgeTtsPython(text, voicePersona, outPath);
    console.log('[tts] python edge-tts ok, voice=' + (VOICE_MAP[voicePersona] || 'default'));
    return outPath;
  } catch (e) {
    console.warn('[tts] python edge-tts failed:', e.message);
  }
  try {
    await gttsSynthesize(text, voicePersona, outPath);
    console.log('[tts] gtts fallback ok');
    return outPath;
  } catch (e) {
    console.error('[tts] gtts ALSO failed:', e.message);
    const r = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=24000', '-t', '5', '-c:a', 'libmp3lame', '-b:a', '48k', outPath], { stdio: 'pipe' });
    if (r.status !== 0) throw new Error('TTS chain exhausted');
    return outPath;
  }
}

module.exports = { synthesize, VOICE_MAP };
