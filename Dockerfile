FROM node:20-bookworm-slim

# ffmpeg + node-canvas system deps + fonts + python3 for edge-tts
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    fonts-dejavu-core \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Python edge-tts — Microsoft's neural voices via HTTP, more reliable than node msedge-tts
RUN pip3 install --break-system-packages --no-cache-dir edge-tts==6.1.* || pip3 install --no-cache-dir edge-tts==6.1.*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

RUN mkdir -p /tmp/renders

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
