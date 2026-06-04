const axios = require('axios');
const fs = require('fs');
const path = require('path');

async function downloadToFile(url, destPath) {
  const writer = fs.createWriteStream(destPath);
  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 60000,
    maxRedirects: 5,
    headers: { 'User-Agent': 'FootballAIHub/1.0 video-service' },
  });
  return new Promise((resolve, reject) => {
    response.data.pipe(writer);
    let error = null;
    writer.on('error', (err) => { error = err; writer.close(); reject(err); });
    writer.on('close', () => { if (!error) resolve(destPath); });
  });
}

async function downloadMany(urls, dir, prefix) {
  const paths = [];
  for (let i = 0; i < urls.length; i++) {
    const ext = guessExt(urls[i]);
    const p = path.join(dir, `${prefix}_${i}${ext}`);
    try { await downloadToFile(urls[i], p); paths.push(p); }
    catch (e) { console.warn(`[download] skip ${urls[i]}: ${e.message}`); }
  }
  return paths;
}

function guessExt(url) {
  try {
    const u = new URL(url);
    const last = (u.pathname.split('/').pop() || '').toLowerCase();
    if (last.endsWith('.jpg') || last.endsWith('.jpeg')) return '.jpg';
    if (last.endsWith('.png')) return '.png';
    if (last.endsWith('.webp')) return '.webp';
    if (last.endsWith('.mp4')) return '.mp4';
    if (last.endsWith('.webm')) return '.webm';
  } catch (_) {}
  return '.jpg';
}

module.exports = { downloadToFile, downloadMany };
