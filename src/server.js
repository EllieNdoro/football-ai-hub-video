// Football AI Hub - Video Service
// Endpoints: GET /health, POST /render, POST /thumbnail
// Now uses Pexels Videos (real b-roll clips) instead of static photos.

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
const FALLBACK_VIDEO_QUERIES = ['football match', 'soccer stadium', 'sports celebration', 'football fans crowd', 'soccer training'];

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
  const stop = new Set(['with','from','into','this','that','than','over','show','shows','their','each','side','left','right','design','style','color','colour','bold','dark','light','background','image','photo','shot','view','scene','wide','close','animated','animation','overlay','text','floating','geometric']);
  const words = prompt.toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stop.has(w))
    .slice(0, 3);
  return words.length ? words.join(' ') + ' football' : null;
}

// Pexels Videos search — returns {url, duration} or null
async function pexelsVideoSearch(query, orientation) {
  if (!PEXELS_KEY) return null;
  const o = orientation || 'portrait';
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=15&orientation=${o}`;
  try {
    const r = await axios.get(url, { headers: { Authorization: PEXELS_KEY }, timeout: 20000 });
    const videos = r.data.videos || [];
    if (videos.length === 0) return null;
    // Random pick from top 10
    const pick = videos[Math.floor(Math.random() * Math.min(videos.length, 10))];
    // Find best MP4 file matching orientation
    const wantPortrait = o === 'portrait';
    const files = (pick.video_files || []).filter(f => (f.file_type || '').includes('mp4'));
    if (!files.length) return null;
    const matching = files.filter(f => wantPortrait ? f.height > f.width : f.width > f.height);
    const pool = matching.length ? matching : files;
    // Prefer ~720p HD (smaller download, still good quality on Shorts)
    const sorted = pool.slice().sort((a, b) => {
      const aDist = Math.abs((wantPortrait ? a.height : a.width) - 720);
      const bDist = Math.abs((wantPortrait ? b.height : b.width) - 720);
      return aDist - bDist;
    });
    return { url: sorted[0].link, duration: pick.duration || 10 };
  } catch (e) {
    console.warn('[pexels-video] search failed for', query, ':', e.message);
    return null;
  }
}

async function videoUrlForPrompt(prompt, orientation, broll_queries) {
  // Try keyword-derived prompt, then broll_queries, then fallback queries
  const queries = [extractKeywords(prompt)]
    .concat(broll_queries || [])
    .concat(FALLBACK_VIDEO_QUERIES)
    .filter(Boolean);
  for (const q of queries) {
    const v = await pexelsVideoSearch(q, orientation);
    if (v) return v;
  }
  return null;
}

// Photos search — kept for thumbnail base image
async function pexelsPhotoSearch(query, orientation) {
  if (!PEXELS_KEY) return null;
  const o = orientation || 'portrait';
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=10&orientation=${o}`;
  try {
    const r = await axios.get(url, { headers: { Authorization: PEXELS_KEY }, timeout: 15000 });
    const photos = r.data.photos || [];
    if (!photos.length) return null;
    const p = photos[Math.floor(Math.random() * photos.length)];
    return p.src.large2x || p.src.large || p.src.original;
  } catch (_) { return null; }
}

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

    // 2) TTS
    const voice = req.body.voice_persona || script.voice_persona || 'british_pundit';
    const narrationPath = path.join(workDir, 'narration.mp3');
    await synthesize(narrationText, voice, narrationPath);

    // 3) Visuals: caller-supplied URLs, else Pexels Video search per visual_prompt
    const isShort = composition !== 'LongForm';
    const orientation = isShort ? 'portrait' : 'landscape';
    let visualUrls;
    if (Array.isArray(req.body.visuals) && req.body.visuals.length) {
      visualUrls = req.body.visuals;
    } else {
      const prompts = script.visual_prompts || [];
      visualUrls = [];
      for (const vp of prompts) {
        const v = await videoUrlForPrompt(vp.prompt, orientation, script.broll_queries);
        if (v) visualUrls.push({ t: vp.t, url: v.url, sourceDuration: v.duration });
      }
      if (visualUrls.length === 0) {
        for (let i = 0; i < Math.max(prompts.length, 3); i++) {
          const fb = FALLBACK_VIDEO_QUERIES[i % FALLBACK_VIDEO_QUERIES.length];
          const v = await pexelsVideoSearch(fb, orientation);
          if (v) visualUrls.push({ t: i * 5, url: v.url, sourceDuration: v.duration });
        }
      }
    }
    if (visualUrls.length === 0) throw new Error('No video clips available from Pexels');

    visualUrls.sort((a, b) => (a.t || 0) - (b.t || 0));

    const localPaths = await downloadMany(visualUrls.map(v => v.url), workDir, 'vis');
    if (localPaths.length === 0) throw new Error('Failed to download any video clips');
    const visuals = localPaths.map((local, i) => ({
      local,
      t: visualUrls[i] ? visualUrls[i].t : i * 5,
      sourceDuration: visualUrls[i] ? visualUrls[i].sourceDuration : null,
    }));

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
app.listen(PORT, () => console.log(`[video-service] listening on :${PORT}`));
