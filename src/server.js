// Football AI Hub - Video Service
// Visuals: Pexels Videos, STORY-RELEVANT — uses script broll_queries + named entities first.

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

const { uploadFile } = require('./r2');
const { synthesize } = require('./tts');
const { downloadMany } = require('./download');
const { buildSrt } = require('./srt');
const { renderVideo } = require('./render-video');
const { renderThumbnail } = require('./render-thumbnail');

const app = express();
app.use(express.json({ limit: '25mb' }));
const PEXELS_KEY = process.env.PEXELS_API_KEY;
const FALLBACK_VIDEO_QUERIES = ['football match action', 'soccer stadium crowd', 'football players running', 'football celebration goal', 'soccer training'];

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = process.env.SERVICE_API_KEY;
  if (!key) return next();
  if (req.headers['x-api-key'] === key) return next();
  return res.status(401).json({ error: 'unauthorized' });
});
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

function extractEntities(text) {
  if (!text) return [];
  const re = /\b([A-Z\u00C0-\u017F][a-z\u00E0-\u017F]+(?:\s+[A-Z\u00C0-\u017F][a-z\u00E0-\u017F]+)+|[A-Z\u00C0-\u017F][a-z\u00E0-\u017F]{3,})\b/g;
  const blacklist = /^(The|And|But|For|Our|This|That|With|From|When|Where|What|Why|How|Animated|Player|Card|Split|Dark|Bold|Modern|Final|Match|World|Cup|Stadium|Football|Soccer|FIFA|Top|Best|Last|New|First|Goal|Team|Game|League|Round|Group|Champion|Star|Burgundy|Spanish|English|French|German|Dynamic|Camera|Photo|Image|Video|Background)$/i;
  const out = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const w = m[1].trim();
    if (blacklist.test(w)) continue;
    out.add(w);
  }
  return [...out];
}

function buildVideoQueries(prompt, broll_queries) {
  const queries = [];
  const entities = extractEntities(prompt);
  for (const e of entities) { queries.push(e + ' football'); queries.push(e); }
  if (Array.isArray(broll_queries)) {
    for (const q of broll_queries) if (q && q.length > 3) queries.push(q);
  }
  for (const f of FALLBACK_VIDEO_QUERIES) queries.push(f);
  const seen = new Set();
  return queries.filter(q => { const k = q.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function pexelsVideoSearch(query, orientation) {
  if (!PEXELS_KEY) return null;
  const o = orientation || 'portrait';
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=15&orientation=${o}`;
  try {
    const r = await axios.get(url, { headers: { Authorization: PEXELS_KEY }, timeout: 15000 });
    const videos = r.data.videos || [];
    if (!videos.length) return null;
    const pick = videos[Math.floor(Math.random() * Math.min(videos.length, 10))];
    const wantPortrait = o === 'portrait';
    const files = (pick.video_files || []).filter(f => (f.file_type || '').includes('mp4'));
    if (!files.length) return null;
    const matching = files.filter(f => wantPortrait ? f.height > f.width : f.width > f.height);
    const pool = matching.length ? matching : files;
    const sorted = pool.slice().sort((a, b) => {
      const aDist = Math.abs((wantPortrait ? a.height : a.width) - 720);
      const bDist = Math.abs((wantPortrait ? b.height : b.width) - 720);
      return aDist - bDist;
    });
    return { url: sorted[0].link, duration: pick.duration || 10, query };
  } catch (e) {
    console.warn('[pexels-video] search failed for', query, ':', e.message);
    return null;
  }
}

async function videoUrlForPrompt(prompt, orientation, broll_queries, usedUrls) {
  const queries = buildVideoQueries(prompt, broll_queries);
  for (const q of queries) {
    const v = await pexelsVideoSearch(q, orientation);
    if (v && !usedUrls.has(v.url)) {
      usedUrls.add(v.url);
      console.log('[visuals] prompt~', prompt.slice(0,40), 'matched query=', q);
      return v;
    }
  }
  return null;
}

app.post('/render', async (req, res) => {
  const t0 = Date.now();
  const { idea_id, composition = 'Short', script } = req.body || {};
  if (!idea_id || !script) return res.status(400).json({ error: 'idea_id and script are required' });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `render-${idea_id}-`));
  try {
    const narrationText = [script.hook, ...(script.body || []).map(b => b.text), script.cta].filter(Boolean).join(' ');
    if (!narrationText.trim()) throw new Error('Empty narration text');

    const voice = req.body.voice_persona || script.voice_persona || 'british_pundit';
    const narrationPath = path.join(workDir, 'narration.mp3');
    await synthesize(narrationText, voice, narrationPath);

    const isShort = composition !== 'LongForm';
    const orientation = isShort ? 'portrait' : 'landscape';
    let visualUrls;
    if (Array.isArray(req.body.visuals) && req.body.visuals.length) visualUrls = req.body.visuals;
    else {
      const prompts = script.visual_prompts || [];
      visualUrls = [];
      const usedUrls = new Set();
      for (const vp of prompts) {
        const v = await videoUrlForPrompt(vp.prompt, orientation, script.broll_queries, usedUrls);
        if (v) visualUrls.push({ t: vp.t, url: v.url, sourceDuration: v.duration });
      }
      if (visualUrls.length === 0) {
        for (let i = 0; i < Math.max(prompts.length, 3); i++) {
          const v = await pexelsVideoSearch(FALLBACK_VIDEO_QUERIES[i % FALLBACK_VIDEO_QUERIES.length], orientation);
          if (v) visualUrls.push({ t: i * 5, url: v.url, sourceDuration: v.duration });
        }
      }
    }
    if (visualUrls.length === 0) throw new Error('No video clips available from Pexels');

    visualUrls.sort((a, b) => (a.t || 0) - (b.t || 0));
    const localPaths = await downloadMany(visualUrls.map(v => v.url), workDir, 'vis');
    if (localPaths.length === 0) throw new Error('Failed to download any video clips');
    const visuals = localPaths.map((local, i) => ({ local, t: visualUrls[i] ? visualUrls[i].t : i * 5 }));

    const totalDuration = script.total_duration_seconds || (composition === 'LongForm' ? 600 : 45);
    const srt = buildSrt(script.captions || [], totalDuration);
    const srtPath = path.join(workDir, 'captions.srt');
    fs.writeFileSync(srtPath, srt || '1\n00:00:00,000 --> 00:00:01,000\n \n');

    const videoPath = await renderVideo({ workDir, visuals, narrationPath, srtPath, composition, durationSec: totalDuration });
    const dateKey = new Date().toISOString().slice(0, 10);
    const video_url = await uploadFile(videoPath, `videos/${dateKey}/${idea_id}.mp4`, 'video/mp4');
    const narration_url = await uploadFile(narrationPath, `audio/${dateKey}/${idea_id}.mp3`, 'audio/mpeg');
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
    const thumbPath = await renderThumbnail({ workDir, prompt, overlayText: overlay_text || '', composition });
    const dateKey = new Date().toISOString().slice(0, 10);
    const thumbnail_url = await uploadFile(thumbPath, `thumbs/${dateKey}/${idea_id}.jpg`, 'image/jpeg');
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
