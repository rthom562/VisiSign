'use strict';

// S3 photo storage — for AWS, and for any S3-compatible service (Cloudflare R2,
// MinIO, Backblaze B2, DigitalOcean Spaces) via S3_ENDPOINT.
//
// Credentials are NEVER read from config: the AWS SDK resolves them from the
// environment itself, which on AWS means the task/instance IAM role. That keeps
// long-lived access keys out of the deployment entirely. Set S3_ENDPOINT (and
// the usual AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) only for non-AWS targets.
//
// `@aws-sdk/client-s3` is an OPTIONAL dependency — it is required lazily, so a
// SQLite/local install never needs it installed.

function createS3Storage(config) {
  const { bucket, prefix, region } = config.storage;
  if (!bucket) throw new Error('STORAGE_DRIVER=s3 requires PHOTOS_BUCKET');

  let S3Client;
  let GetObjectCommand;
  let PutObjectCommand;
  try {
    ({ S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3'));
  } catch (_) {
    throw new Error(
      'STORAGE_DRIVER=s3 needs the AWS SDK. Install it with:  npm install @aws-sdk/client-s3'
    );
  }

  const client = new S3Client({
    ...(region ? { region } : {}),
    ...(process.env.S3_ENDPOINT
      ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }
      : {}),
  });

  const keyFor = (name) => `${prefix}${String(name).replace(/^\/+/, '')}`;

  return {
    name: 's3',

    describe: () => `s3://${bucket}/${prefix}`,

    async put(name, buffer, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: keyFor(name),
          Body: buffer,
          ContentType: contentType || 'application/octet-stream',
        })
      );
    },

    async get(name) {
      try {
        const out = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: keyFor(name) })
        );
        // Node 18+ streams expose transformToByteArray via the SDK's mixin.
        if (out.Body && typeof out.Body.transformToByteArray === 'function') {
          return Buffer.from(await out.Body.transformToByteArray());
        }
        const chunks = [];
        for await (const chunk of out.Body) chunks.push(chunk);
        return Buffer.concat(chunks);
      } catch (_) {
        return null; // missing photo is not an error
      }
    },
  };
}

module.exports = { createS3Storage };
