// Cloudflare R2 upload. R2 is S3-compatible.
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET || 'football-ai-hub-assets';
const PUBLIC_BASE = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

async function uploadFile(localPath, key, contentType) {
  const body = fs.readFileSync(localPath);
  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return `${PUBLIC_BASE}/${key}`;
}

async function uploadBuffer(buffer, key, contentType) {
  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return `${PUBLIC_BASE}/${key}`;
}

module.exports = { uploadFile, uploadBuffer };
