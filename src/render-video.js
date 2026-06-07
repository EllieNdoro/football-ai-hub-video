// FFmpeg slideshow renderer — now using REAL VIDEO CLIPS from Pexels (not images).
// Each input is an MP4 b-roll clip; we trim each to its segment duration.
// Memory-light for trial-tier Railway container.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function renderVideo({
  workDir, visuals, narrationPath, srtPath, composition, durationSec,
}) {
  const isShort = composition !== 'LongForm';
  const W = isShort ? 1080 : 1280;
  const H = isShort ? 1920 : 720;
  const FPS = 24;
  const outPath = path.join(workDir, 'video.mp4');

  const segs = computeSegments(visuals, durationSec);

  // Build filter graph: each input is a video; trim+scale+crop+fps it, then concat
  const lines = [];
  segs.forEach((s, i) => {
    const dur = s.duration.toFixed(2);
    // setpts=PTS-STARTPTS resets timestamps so concat works smoothly
    // If source clip is shorter than segment, loop it by setting -stream_loop on input
    lines.push(
      `[${i}:v]trim=duration=${dur},setpts=PTS-STARTPTS,` +
      `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `setsar=1,fps=${FPS},format=yuv420p[v${i}]`
    );
  });
  const concatIn = segs.map((_, i) => `[v${i}]`).join('');
  lines.push(`${concatIn}concat=n=${segs.length}:v=1:a=0[vcat]`);

  let lastLabel = 'vcat';
  const srtRaw = (() => { try { return fs.readFileSync(srtPath, 'utf8'); } catch (_) { return ''; } })();
  if (srtRaw.replace(/\s/g, '').length > 25) {
    const safePath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const force = 'FontName=DejaVu Sans,FontSize=22,PrimaryColour=&HFFFFFFFF,OutlineColour=&H000000,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=140,Bold=1';
    lines.push(`[vcat]subtitles='${safePath}':force_style='${force}'[vout]`);
    lastLabel = 'vout';
  }

  const filterFile = path.join(workDir, 'filter.txt');
  fs.writeFileSync(filterFile, lines.join(';\n'));

  const args = ['-hide_banner', '-loglevel', 'error'];
  segs.forEach(s => {
    // -stream_loop -1 lets a short clip loop until trim's duration is hit
    args.push('-stream_loop', '-1', '-i', s.local);
  });
  args.push('-i', narrationPath);
  args.push('-filter_complex_script', filterFile);
  args.push('-map', `[${lastLabel}]`);
  args.push('-map', `${segs.length}:a`);
  args.push(
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'fastdecode',
    '-crf', '28',
    '-pix_fmt', 'yuv420p',
    '-threads', '1',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '1',
    '-movflags', '+faststart', '-shortest', '-y', outPath
  );

  console.log('[ffmpeg] render with VIDEO clips: segs=' + segs.length + ' ' + W + 'x' + H + ' fps=' + FPS + ' dur=' + durationSec);

  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    proc.on('error', err => reject(new Error('ffmpeg spawn: ' + err.message)));
    proc.on('close', (code, signal) => {
      console.log('[ffmpeg] exit code=' + code + ' signal=' + signal);
      if (code === 0) {
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) return resolve(outPath);
        return reject(new Error('ffmpeg produced empty output'));
      }
      const trail = stderr.split('\n').filter(l => l.trim()).slice(-8).join(' | ');
      reject(new Error('ffmpeg exit ' + code + ' signal=' + signal + ': ' + trail.slice(-1000)));
    });
  });
}

function computeSegments(visuals, totalDuration) {
  if (visuals.length === 0) throw new Error('No visuals to render');
  const segs = [];
  for (let i = 0; i < visuals.length; i++) {
    const start = visuals[i].t;
    const end = i + 1 < visuals.length ? visuals[i + 1].t : totalDuration;
    const duration = Math.max(0.8, end - start);
    segs.push({ local: visuals[i].local, t: start, duration });
  }
  return segs;
}

module.exports = { renderVideo };
