// TTS with Edge TTS primary + Google Translate TTS fallback.
// Edge TTS (msedge-tts) uses WebSockets which can fail in some cloud envs.
// gTTS uses HTTP and works everywhere, but max ~200 chars/req so we chunk.
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const VOICE_MAP = {
  hype_male:        'en-US-GuyNeural',
  calm_analyst:     'en-US-DavisNeural',
  female_energetic: 'en-US-AvaNeural',
  british_pundit:   'en-GB-RyanNeural',
  spanish_latin:    'es-MX-JorgeNeural',
};
const RATE_MAP = {
  hype_male: '+8%', calm_analyst: '0%', female_energetic: '+10%',
  british_pundit: '+4%', spanish_latin: '+6%',
};
const PITCH_MAP = {
  hype_male: '+5Hz', calm_analyst: '0Hz', female_energetic: '+10Hz',
  british_pundit: '0Hz', spanish_latin: '+0Hz',
};
const GTTS_LANG = {
  hype_male: 'en', calm_analyst: 'en', female_energetic: 'en',
  british_pundit: 'en-gb', spanish_latin: 'es',
};

async function edgeTtsSynthesize(text, voicePersona, outPath) {
  const voice = VOICE_MAP[voicePersona] || VOICE_MAP.hype_male;
  const rate  = RATE_MAP[voicePersona]  || '+5%';
  const pitch = PITCH_MAP[voicePersona] || '0Hz';
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioFilePath } = await tts.toFile(outPath.replace(/\.mp3$/, ''), text, { rate, pitch, volume: '+0%' });
  const finalPath = audioFilePath || (outPath.replace(/\.mp3$/, '') + '.mp3');
  if (finalPath !== outPath && fs.existsSync(finalPath)) fs.renameSync(finalPath, outPath);
  return outPath;
}

function chunkText(text, maxLen) {
  // Split on sentence/punctuation boundaries; greedy pack into chunks <= maxLen
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]?/g) || [text];
  const chunks = [];
  let buf = '';
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    if (buf.length + 1 + t.length <= maxLen) {
      buf = buf ? buf + ' ' + t : t;
    } else {
      if (buf) chunks.push(buf);
      // If a single sentence is still > maxLen, hard-split by word
      if (t.length > maxLen) {
        const words = t.split(' ');
        let wb = '';
        for (const w of words) {
          if (wb.length + 1 + w.length <= maxLen) wb = wb ? wb + ' ' + w : w;
          else { if (wb) chunks.push(wb); wb = w; }
        }
        if (wb) chunks.push(wb);
        buf = '';
      } else {
        buf = t;
      }
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function gttsSynthesize(text, voicePersona, outPath) {
  const lang = GTTS_LANG[voicePersona] || 'en';
  const chunks = chunkText(text, 180);
  const tmpFiles = [];
  for (let i = 0; i < chunks.length; i++) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodeURIComponent(chunks[i])}`;
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
    });
    const tmp = outPath.replace(/\.mp3$/, `_chunk_${i}.mp3`);
    fs.writeFileSync(tmp, Buffer.from(resp.data));
    tmpFiles.push(tmp);
  }
  if (tmpFiles.length === 1) {
    fs.renameSync(tmpFiles[0], outPath);
  } else {
    // concat with ffmpeg
    const listFile = outPath.replace(/\.mp3$/, '_concat.txt');
    fs.writeFileSync(listFile, tmpFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    const r = spawnSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath], { stdio: 'pipe' });
    if (r.status !== 0) throw new Error('ffmpeg concat failed: ' + (r.stderr ? r.stderr.toString().slice(-400) : 'unknown'));
    fs.unlinkSync(listFile);
    tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
  }
  return outPath;
}

async function synthesize(text, voicePersona, outPath) {
  // Try Edge TTS first, fall back to Google Translate TTS over HTTP
  try {
    await edgeTtsSynthesize(text, voicePersona, outPath);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) return outPath;
    throw new Error('edge tts produced empty file');
  } catch (e) {
    console.warn('[tts] edge tts failed, falling back to gtts:', e.message || e.toString());
  }
  try {
    await gttsSynthesize(text, voicePersona, outPath);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) return outPath;
    throw new Error('gtts produced empty file');
  } catch (e) {
    console.error('[tts] gtts ALSO failed:', e.message || e.toString());
    // Last resort: 1s silence so pipeline can complete and we get diagnostic output
    const r = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=24000', '-t', '5', '-c:a', 'libmp3lame', '-b:a', '48k', outPath], { stdio: 'pipe' });
    if (r.status !== 0) throw new Error('TTS fallback chain exhausted; ffmpeg silence also failed');
    return outPath;
  }
}

module.exports = { synthesize, VOICE_MAP };
