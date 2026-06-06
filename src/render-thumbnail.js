// Thumbnail rendering: try Pollinations AI, fall back to programmatic gradient on error.
const { createCanvas, loadImage, registerFont } = require('canvas');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

async function renderThumbnail({ workDir, prompt, overlayText, composition }) {
  const isShort = composition !== 'LongForm';
  const W = isShort ? 1080 : 1280;
  const H = isShort ? 1920 : 720;
  const outPath = path.join(workDir, 'thumb.jpg');

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Try Pollinations first
  let baseImg = null;
  try {
    const enhanced = `${prompt}, cinematic, dramatic lighting, sports photography, 4k, high contrast`;
    const seed = Math.floor(Math.random() * 100000);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(enhanced)}?width=${W}&height=${H}&nologo=true&seed=${seed}&referrer=football-ai-hub`;
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    baseImg = await loadImage(Buffer.from(resp.data));
  } catch (e) {
    console.warn('[thumbnail] Pollinations failed:', e.message, '- using fallback');
    baseImg = null;
  }

  if (baseImg) {
    ctx.drawImage(baseImg, 0, 0, W, H);
  } else {
    // Fallback: rich gradient background based on prompt hash
    const hash = [...prompt].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
    const hue1 = Math.abs(hash) % 360;
    const hue2 = (hue1 + 60) % 360;
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, `hsl(${hue1}, 80%, 25%)`);
    bg.addColorStop(0.5, `hsl(${(hue1 + 30) % 360}, 75%, 15%)`);
    bg.addColorStop(1, `hsl(${hue2}, 85%, 10%)`);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    // Add geometric flourish
    ctx.fillStyle = `hsla(${hue2}, 90%, 50%, 0.15)`;
    for (let i = 0; i < 6; i++) {
      const r = (Math.abs(hash + i * 1000) % (W / 3)) + 100;
      ctx.beginPath();
      ctx.arc((hash * (i + 1)) % W, (hash * (i + 2)) % H, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Dark gradient overlay (bottom half) for text readability
  const grad = ctx.createLinearGradient(0, H * 0.45, 0, H);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.78)');
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
