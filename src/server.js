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
const { v4: uuid } = require('uuid');

const { uploadFile } = require('./r2');
const { synthesize } = require('./tts');
const { downloadMany } = require('./download');
const { buildSrt } = require('./srt');
const { renderVideo } = require('./render-video');
const { renderThumbnail } = require('./render-thumbnail');

const app = express();
app.use(express.json({ limit: '25mb' }));

// Optional shared-secret auth
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = process.env.SERVICE_API_KEY;
  if (!key) return next();
  if (req.headers['x-api-key'] === key) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.post('/render', async (req, res) => {
  const t0 = Date.now();
  const { idea_id, composition = 'Short', script } = req.body || {};
  if (!idea_id || !script) return res.status(400).json({ error: 'idea_id and script are required' });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `render-${idea_id}-`));
  try {
    const narrationText = [
      script.hook,
      ...(script.body || []).map(b => b.text),
      script.cta,
    ].filter(Boolean).join(' ');
    if (!narrationText.trim()) throw new Error('Empty narration text');

    const voice = req.body.voice_persona || script.voice_persona || 'hype_male';
    const narrationPath = path.join(workDir, 'narration.mp3');
    await synthesize(narrationText, voice, narrationPath);

    const visualUrls = Array.isArray(req.body.visuals) && req.body.visuals.length
      ? req.body.visuals
      : (script.visual_prompts || []).map(vp => ({
          t: vp.t,
          url: `https://image.pollinations.ai/prompt/${encodeURIComponent(vp.prompt + ', cinematic, dramatic lighting, 4k')}?width=1080&height=1920&nologo=true&seed=${(Date.now() % 100000) + Math.floor(vp.t * 1000)}`,
        }));
    if (visualUrls.length === 0) throw new Error('No visuals available to render');

    visualUrls.sort((a, b) => (a.t || 0) - (b.t || 0));

    const localPaths = await downloadMany(visualUrls.map(v => v.url), workDir, 'vis');
    if (localPaths.length === 0) throw new Error('Failed to download any visuals');
    const visuals = localPaths.map((local, i) => ({ local, t: visualUrls[i] ? visualUrls[i].t : i * 5 }));

    const totalDuration = script.total_duration_seconds || (composition === 'LongForm' ? 600 : 45);
    const srt = buildSrt(script.captions || [], totalDuration);
    const srtPath = path.join(workDir, 'captions.srt');
    fs.writeFileSync(srtPath, srt || '1\n00:00:00,000 --> 00:00:01,000\n \n');

    const videoPath = await renderVideo({
      workDir, visuals, narrationPath, srtPath, composition, durationSec: totalDuration,
    });

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
    const thumbPath = await renderThumbnail({ workDir, prompt, overlayText: overlay_text || '', composition });
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
app.listen(PORT, () => { console.log(`[video-service] listening on :${PORT}`); });
