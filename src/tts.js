// Edge TTS narration. Microsoft's free voice service, no auth.
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const fs = require('fs');
const path = require('path');

// Voice persona -> Edge TTS voice mapping
const VOICE_MAP = {
  hype_male:       'en-US-GuyNeural',
  calm_analyst:    'en-US-DavisNeural',
  female_energetic:'en-US-AvaNeural',
  british_pundit:  'en-GB-RyanNeural',
  spanish_latin:   'es-MX-JorgeNeural',
};

const RATE_MAP = {
  hype_male:       '+8%',
  calm_analyst:    '0%',
  female_energetic:'+10%',
  british_pundit:  '+4%',
  spanish_latin:   '+6%',
};

const PITCH_MAP = {
  hype_male:       '+5Hz',
  calm_analyst:    '0Hz',
  female_energetic:'+10Hz',
  british_pundit:  '0Hz',
  spanish_latin:   '+0Hz',
};

async function synthesize(text, voicePersona, outPath) {
  const voice = VOICE_MAP[voicePersona] || VOICE_MAP.hype_male;
  const rate  = RATE_MAP[voicePersona]  || '+5%';
  const pitch = PITCH_MAP[voicePersona] || '0Hz';

  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioFilePath } = await tts.toFile(outPath.replace(/\.mp3$/, ''), text, {
    rate, pitch, volume: '+0%',
  });
  const finalPath = audioFilePath || (outPath.replace(/\.mp3$/, '') + '.mp3');
  if (finalPath !== outPath && fs.existsSync(finalPath)) {
    fs.renameSync(finalPath, outPath);
  }
  return outPath;
}

module.exports = { synthesize, VOICE_MAP };
