FROM node:20-bookworm-slim

# Install ffmpeg + node-canvas system deps + fonts
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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy app
COPY src ./src

# Ephemeral working dir for renders
RUN mkdir -p /tmp/renders

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
