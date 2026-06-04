// FFmpeg-based slideshow video renderer.
// Composes: visuals (Ken Burns pan/zoom) + narration audio + burned-in captions.
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

async function renderVideo({
  workDir,
  visuals,
  narrationPath,
  srtPath,
  composition,
  durationSec,
}) {
  const isShort = composition !== 'LongForm';
  const W = isShort ? 1080 : 1920;
  const H = isShort ? 1920 : 1080;
  const FPS = 30;
  const outPath = path.join(workDir, 'video.mp4');

  const segs = computeSegments(visuals, durationSec);

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();

    segs.forEach((s) => {
      cmd.input(s.local)
        .inputOptions(['-loop 1', `-t ${s.duration.toFixed(2)}`, '-framerate ' + FPS]);
    });

    cmd.input(narrationPath);

    const filters = [];
    segs.forEach((s, i) => {
      const frames = Math.max(1, Math.round(s.duration * FPS));
      filters.push(
        `[${i}:v]scale=${W * 1.2}:${H * 1.2}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H},setsar=1,zoompan=z='min(zoom+0.0009,1.15)':d=${frames}:s=${W}x${H}:fps=${FPS},` +
        `format=yuv420p[v${i}]`
      );
    });

    const concatIn = segs.map((_, i) => `[v${i}]`).join('');
    filters.push(`${concatIn}concat=n=${segs.length}:v=1:a=0[concat]`);

    const srtFilterPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    filters.push(
      `[concat]subtitles='${srtFilterPath}':force_style='` +
      `FontName=DejaVu Sans,FontSize=22,PrimaryColour=&HFFFFFFFF,OutlineColour=&H000000,` +
      `BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=140,Bold=1` +
      `'[vout]`
    );

    const narrationIndex = segs.length;

    cmd
      .complexFilter(filters, ['vout'])
      .outputOptions([
        '-map', '[vout]',
        '-map', `${narrationIndex}:a`,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-shortest',
      ])
      .output(outPath)
      .on('start', (cmdLine) => console.log('[ffmpeg] start'))
      .on('stderr', (line) => { if (process.env.FFMPEG_DEBUG) console.log('[ffmpeg]', line); })
      .on('error', (err) => reject(new Error('ffmpeg: ' + err.message)))
      .on('end', () => resolve(outPath))
      .run();
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
