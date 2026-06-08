// TTS: Piper (local neural TTS, male British) primary + gTTS fallback + silence last resort.
const { spawn, spawnSync } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const PIPER_VOICE = process.env.PIPER_VOICE || '/opt/piper-voices/en_GB-alan-medium.onnx';
const GTTS_LANG = {
  hype_male: 'en-gb', calm_analyst: 'en-gb', female_energetic: 'en',
  british_pundit: 'en-gb', spanish_latin: 'es', peter_drury: 'en-gb',
};

function piperSynthesize(text, outPath) {
  // Piper writes WAV to stdout; we pipe through ffmpeg to MP3
  const wavPath = outPath.replace(/\.mp3$/, '.wav');
  // Pass text via stdin, write wav to file
  const r = spawnSync('piper', ['--model', PIPER_VOICE, '--output_file', wavPath], {
    input: text,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 90000,
  });
  if (r.status !== 0) {
    const err = r.stderr ? String(r.stderr).slice(-600) : 'no stderr';
    throw new Error('piper exit ' + r.status + ': ' + err);
  }
  if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < 1024) {
    throw new Error('piper produced empty wav');
  }
  // Convert WAV -> MP3
  const ff = spawnSync('ffmpeg', ['-y', '-i', wavPath, '-c:a', 'libmp3lame', '-b:a', '128k', '-ac', '1', outPath], { stdio: 'pipe' });
  if (ff.status !== 0) {
    throw new Error('ffmpeg wav->mp3 failed: ' + (ff.stderr ? String(ff.stderr).slice(-400) : ''));
  }
  try { fs.unlinkSync(wavPath); } catch (_) {}
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
    piperSynthesize(text, outPath);
    console.log('[tts] piper ok, voice=' + PIPER_VOICE);
    return outPath;
  } catch (e) {
    console.warn('[tts] piper failed:', e.message);
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

module.exports = { synthesize };
