FROM node:20-bookworm-slim

# ffmpeg + node-canvas system deps + fonts + curl for downloading Piper voices
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    fonts-dejavu-core fonts-liberation fonts-noto-color-emoji ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Piper TTS — open-source neural TTS, runs locally (no external API, no IP blocking)
# en_GB-alan-medium = calm confident British male — closest free voice to Peter Drury
RUN curl -fsSL -o /tmp/piper.tar.gz \
    https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz \
    && tar -xzf /tmp/piper.tar.gz -C /opt/ \
    && rm /tmp/piper.tar.gz \
    && ln -sf /opt/piper/piper /usr/local/bin/piper

RUN mkdir -p /opt/piper-voices \
    && curl -fsSL -o /opt/piper-voices/en_GB-alan-medium.onnx \
       https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx \
    && curl -fsSL -o /opt/piper-voices/en_GB-alan-medium.onnx.json \
       https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx.json

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

RUN mkdir -p /tmp/renders

ENV NODE_ENV=production
ENV PORT=3000
ENV PIPER_VOICE=/opt/piper-voices/en_GB-alan-medium.onnx
EXPOSE 3000

CMD ["node", "src/server.js"]
