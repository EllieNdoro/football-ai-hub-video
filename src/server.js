// Football AI Hub - Video Service
// Endpoints:
//   GET  /health
//   POST /render        -> renders a Short/LongForm MP4 + narration MP3
//   POST /thumbnail     -> renders a 1080x1920 thumbnail JPG
// Auth: optional X-API-Key (matches SERVICE_API_KEY env var)
// All assets are uploaded to Cloudflare R2 and public URLs are returned.

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { v4: uuid } = require('uuid');

const { uploadFile } = require('./r2');
const { synthesize } = require('./tts');
const { downloadMany } = require('./download');
const { buildSrt } = require('./srt');
const { renderVideo } = require('./render-video');
const { renderThumbnail } = require('./render-thumbnail');

const app = express();
app.use(express.json({ limit: '25mb' }));

const PEXELS_KEY = process.env.PEXELS_API_KEY;
const FALLBACK_QUERIES = ['football stadium', 'soccer match', 'sports celebration', 'football fans', 'soccer training'];

// Optional shared-secret auth
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = process.env.SERVICE_API_KEY;
  if (!key) return next();
  if (req.headers['x-api-key'] === key) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

function extractKeywords(prompt) {
  if (!prompt) return null;
  const stop = new Set(['with', 'from', 'into', 'this', 'that', 'than', 'over', 'show', 'shows', 'their', 'each', 'side', 'left', 'right', 'design', 'style', 'color', 'colour', 'bold', 'dark', 'light', 'background', 'image', 'photo', 'shot', 'view', 'scene', 'wide', 'close']);
  const words = prompt.toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stop.has(w))
    .slice(0, 3);
  return words.length ? words.join(' ') + ' football' : null;
}

async function pexelsSearch(query, orientation) {
  if (!PEXELS_KEY) return null;
  const o = orientation || 'portrait';
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=15&orientation=${o}`;
  try {
    const r = await axios.get(url, { headers: { Authorization: PEXELS_KEY }, timeout: 15000 });
    const photos = r.data.photos || [];
    if (photos.length === 0) return null;
    const pick = photos[Math.floor(Math.random() * photos.length)];
    return pick.src.large2x || pick.src.large || pick.src.original;
  } catch (e) {
    console.warn('[pexels] search failed for', query, ':', e.message);
    return null;
  }
}

async function visualUrlForPrompt(prompt, orientation) {
  // Try keyword-extracted prompt, then fallback queries
  const queries = [extractKeywords(prompt)].filter(Boolean).concat(FALLBACK_QUERIES);
  for (const q of queries) {
    const url = await pexelsSearch(q, orientation);
    if (url) return url;
  }
  return null;
}

/**
 * POST /render
 * Body: {
 *   idea_id, composition, script: {hook, body[], cta, captions[], visual_prompts[], voice_persona, total_duration_seconds, ...},
 *   visuals?: [{t, url}], voice_persona?: string,
 * }
 */
app.post('/render', async (req, res) => {
  const t0 = Date.now();
  const { idea_id, composition = 'Short', script } = req.body || {};
  if (!idea_id || !script) return res.status(400).json({ error: 'idea_id and script are required' });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `render-${idea_id}-`));
  try {
    // 1) Narration text
    const narrationText = [
      script.hook,
      ...(script.body || []).map(b => b.text),
      script.cta,
    ].filter(Boolean).join(' ');
    if (!narrationText.trim()) throw new Error('Empty narration text');

    // 2) TTS via Edge
    const voice = req.body.voice_persona || script.voice_persona || 'hype_male';
    const narrationPath = path.join(workDir, 'narration.mp3');
    await synthesize(narrationText, voice, narrationPath);

    // 3) Visuals: caller-supplied URLs, else Pexels search per visual_prompt
    const isShort = composition !== 'LongForm';
    const orientation = isShort ? 'portrait' : 'landscape';
    let visualUrls;
    if (Array.isArray(req.body.visuals) && req.body.visuals.length) {
      visualUrls = req.body.visuals;
    } else {
      const prompts = script.visual_prompts || [];
      visualUrls = [];
      for (const vp of prompts) {
        const url = await visualUrlForPrompt(vp.prompt, orientation);
        if (url) visualUrls.push({ t: vp.t, url });
      }
      // If we have prompts but Pexels returned nothing, last-ditch fallback
      if (visualUrls.length === 0) {
        for (let i = 0; i < Math.max(prompts.length, 3); i++) {
          const fb = FALLBACK_QUERIES[i % FALLBACK_QUERIES.length];
          const url = await pexelsSearch(fb, orientation);
          if (url) visualUrls.push({ t: i * 5, url });
        }
      }
    }
    if (visualUrls.length === 0) throw new Error('No visuals available to render (Pexels returned 0 results)');

    visualUrls.sort((a, b) => (a.t || 0) - (b.t || 0));

    const localPaths = await downloadMany(visualUrls.map(v => v.url), workDir, 'vis');
    if (localPaths.length === 0) throw new Error('Failed to download any visuals');
    const visuals = localPaths.map((local, i) => ({ local, t: visualUrls[i] ? visualUrls[i].t : i * 5 }));

    // 4) Captions -> SRT
    const totalDuration = script.total_duration_seconds || (composition === 'LongForm' ? 600 : 45);
    const srt = buildSrt(script.captions || [], totalDuration);
    const srtPath = path.join(workDir, 'captions.srt');
    fs.writeFileSync(srtPath, srt || '1\n00:00:00,000 --> 00:00:01,000\n \n');

    // 5) Render
    const videoPath = await renderVideo({
      workDir, visuals, narrationPath, srtPath, composition,
      durationSec: totalDuration,
    });

    // 6) Upload to R2
    const dateKey = new Date().toISOString().slice(0, 10);
    const videoKey = `videos/${dateKey}/${idea_id}.mp4`;
    const audioKey = `audio/${dateKey}/${idea_id}.mp3`;
    const video_url = await uploadFile(videoPath, videoKey, 'video/mp4');
    const narration_url = await uploadFile(narrationPath, audioKey, 'audio/mpeg');

    res.json({ video_url, narration_url, duration_seconds: totalDuration, ms: Date.now() - t0 });
  } catch (err) {
    console.error('[render] error', err);
    res.status(500).json({ error: err.message });
  } finally {
    setTimeout(() => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {} }, 5000);
  }
});

/**
 * POST /thumbnail
 * Body: { idea_id, prompt, overlay_text, composition? }
 */
app.post('/thumbnail', async (req, res) => {
  const t0 = Date.now();
  const { idea_id, prompt, overlay_text, composition = 'Short' } = req.body || {};
  if (!idea_id || !prompt) return res.status(400).json({ error: 'idea_id and prompt are required' });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `thumb-${idea_id}-`));
  try {
    const thumbPath = await renderThumbnail({
      workDir, prompt, overlayText: overlay_text || '', composition,
    });
    const dateKey = new Date().toISOString().slice(0, 10);
    const key = `thumbs/${dateKey}/${idea_id}.jpg`;
    const thumbnail_url = await uploadFile(thumbPath, key, 'image/jpeg');
    res.json({ thumbnail_url, ms: Date.now() - t0 });
  } catch (err) {
    console.error('[thumbnail] error', err);
    res.status(500).json({ error: err.message });
  } finally {
    setTimeout(() => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {} }, 5000);
  }
});

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`[video-service] listening on :${PORT}`);
});
