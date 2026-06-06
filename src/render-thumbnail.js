// Thumbnail rendering: Pexels stock + bold overlay text.
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const PEXELS_KEY = process.env.PEXELS_API_KEY;

async function pexelsSearch(query, w, h) {
  if (!PEXELS_KEY) return null;
  const orientation = h > w ? 'portrait' : (w > h ? 'landscape' : 'square');
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=10&orientation=${orientation}`;
  try {
    const r = await axios.get(url, { headers: { Authorization: PEXELS_KEY }, timeout: 15000 });
    const photos = r.data.photos || [];
    if (photos.length === 0) return null;
    const pick = photos[Math.floor(Math.random() * photos.length)];
    return pick.src.large2x || pick.src.large || pick.src.original;
  } catch (e) {
    console.warn('[pexels] search failed:', e.message);
    return null;
  }
}

async function renderThumbnail({ workDir, prompt, overlayText, composition }) {
  const isShort = composition !== 'LongForm';
  const W = isShort ? 1080 : 1280;
  const H = isShort ? 1920 : 720;
  const outPath = path.join(workDir, 'thumb.jpg');

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Try Pexels with prompt-derived query, fall back to generic football queries
  let baseImg = null;
  const queries = [extractKeywords(prompt), 'football stadium', 'soccer match', 'sports arena'];
  for (const q of queries) {
    if (!q) continue;
    try {
      const url = await pexelsSearch(q, W, H);
      if (!url) continue;
      const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
      baseImg = await loadImage(Buffer.from(resp.data));
      break;
    } catch (e) {
      console.warn('[thumbnail] fetch failed for query', q, ':', e.message);
    }
  }

  if (baseImg) {
    // Cover-fit the image
    const sourceAR = baseImg.width / baseImg.height;
    const targetAR = W / H;
    let sx, sy, sw, sh;
    if (sourceAR > targetAR) {
      sh = baseImg.height;
      sw = Math.round(sh * targetAR);
      sx = Math.round((baseImg.width - sw) / 2);
      sy = 0;
    } else {
      sw = baseImg.width;
      sh = Math.round(sw / targetAR);
      sx = 0;
      sy = Math.round((baseImg.height - sh) / 2);
    }
    ctx.drawImage(baseImg, sx, sy, sw, sh, 0, 0, W, H);
  } else {
    // Procedural gradient fallback
    const hash = [...prompt].reduce((h, ch) => ((h << 5) - h + ch.charCodeAt(0)) | 0, 0);
    const hue1 = Math.abs(hash) % 360;
    const hue2 = (hue1 + 60) % 360;
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, `hsl(${hue1}, 80%, 25%)`);
    bg.addColorStop(0.5, `hsl(${(hue1 + 30) % 360}, 75%, 15%)`);
    bg.addColorStop(1, `hsl(${hue2}, 85%, 10%)`);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
  }

  // Dark gradient overlay for text readability
  const grad = ctx.createLinearGradient(0, H * 0.35, 0, H);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.85)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const text = (overlayText || '').toUpperCase();
  if (text) drawWrappedBold(ctx, text, W, H);

  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = 'bold 36px DejaVu Sans';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText('FOOTBALL AI HUB', W - 32, 32);

  fs.writeFileSync(outPath, canvas.toBuffer('image/jpeg', { quality: 0.9 }));
  return outPath;
}

function extractKeywords(prompt) {
  if (!prompt) return null;
  // Extract searchable nouns/phrases from descriptive prompt
  const cleaned = prompt.toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !['with', 'from', 'into', 'this', 'that', 'than', 'over', 'show', 'shows', 'their', 'each', 'side', 'left', 'right', 'design', 'style', 'color', 'colour', 'bold', 'dark', 'light', 'background'].includes(w))
    .slice(0, 3);
  return cleaned.length ? cleaned.join(' ') + ' football' : 'football stadium';
}

function drawWrappedBold(ctx, text, W, H) {
  let fontSize = Math.floor(W / 8);
  let lines;
  const maxLines = 3;
  const maxWidth = W * 0.9;

  while (fontSize > 28) {
    ctx.font = `900 ${fontSize}px DejaVu Sans`;
    lines = wrap(ctx, text, maxWidth);
    if (lines.length <= maxLines) break;
    fontSize -= 8;
  }
  ctx.font = `900 ${fontSize}px DejaVu Sans`;

  const lineHeight = Math.floor(fontSize * 1.05);
  const totalH = lines.length * lineHeight;
  let y = H - totalH - Math.floor(H * 0.08);

  for (const line of lines) {
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.lineWidth = Math.max(8, Math.floor(fontSize / 8));
    ctx.lineJoin = 'round';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.strokeText(line, W / 2, y);
    ctx.fillStyle = '#FFF200';
    ctx.fillText(line, W / 2, y);
    y += lineHeight;
  }
}

function wrap(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const tryLine = cur ? cur + ' ' + w : w;
    if (ctx.measureText(tryLine).width <= maxWidth) {
      cur = tryLine;
    } else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

module.exports = { renderThumbnail };
