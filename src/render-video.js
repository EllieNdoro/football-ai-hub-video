// FFmpeg slideshow renderer using direct spawn + filter_complex_script
// for reliable handling of commas/colons in style strings.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function renderVideo({
  workDir, visuals, narrationPath, srtPath, composition, durationSec,
}) {
  const isShort = composition !== 'LongForm';
  const W = isShort ? 1080 : 1920;
  const H = isShort ? 1920 : 1080;
  const FPS = 30;
  const outPath = path.join(workDir, 'video.mp4');

  const segs = computeSegments(visuals, durationSec);

  // Build filter graph lines
  const lines = [];
  segs.forEach((s, i) => {
    const frames = Math.max(1, Math.round(s.duration * FPS));
    lines.push(
      `[${i}:v]scale=${Math.round(W*1.2)}:${Math.round(H*1.2)}:force_original_aspect_ratio=increase,` +
      `crop=${W}:${H},setsar=1,zoompan=z='min(zoom+0.0009,1.15)':d=${frames}:s=${W}x${H}:fps=${FPS},` +
      `format=yuv420p[v${i}]`
    );
  });
  const concatIn = segs.map((_, i) => `[v${i}]`).join('');
  lines.push(`${concatIn}concat=n=${segs.length}:v=1:a=0[vcat]`);

  // Burn subtitles only if SRT has real cues
  let lastLabel = 'vcat';
  const srtRaw = (() => { try { return fs.readFileSync(srtPath, 'utf8'); } catch (_) { return ''; } })();
  if (srtRaw.replace(/\s/g, '').length > 25) {
    // Escape SRT path for ffmpeg subtitles filter: backslash colons
    const safePath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const force = 'FontName=DejaVu Sans,FontSize=22,PrimaryColour=&HFFFFFFFF,OutlineColour=&H000000,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=140,Bold=1';
    lines.push(`[vcat]subtitles='${safePath}':force_style='${force}'[vout]`);
    lastLabel = 'vout';
  }

  // Write the filter graph to a file (avoids any CLI escaping issues)
  const filterFile = path.join(workDir, 'filter.txt');
  fs.writeFileSync(filterFile, lines.join(';\n'));

  // Build argv
  const args = [];
  segs.forEach(s => {
    args.push('-loop', '1', '-t', s.duration.toFixed(2), '-framerate', String(FPS), '-i', s.local);
  });
  args.push('-i', narrationPath);
  args.push('-filter_complex_script', filterFile);
  args.push('-map', `[${lastLabel}]`);
  args.push('-map', `${segs.length}:a`);
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', '-shortest', '-y', outPath
  );

  console.log('[ffmpeg] starting render: segs=' + segs.length + ' W=' + W + ' H=' + H + ' duration=' + durationSec);

  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => reject(new Error('ffmpeg spawn: ' + err.message)));
    proc.on('close', code => {
      if (code === 0) {
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) return resolve(outPath);
        return reject(new Error('ffmpeg produced empty output'));
      }
      reject(new Error('ffmpeg exit ' + code + ': ' + stderr.split('\n').slice(-12).join(' | ').slice(-1500)));
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
