'use strict';

// Google Cloud Storage photo storage.
//
// Credentials come from Application Default Credentials, which on Cloud Run /
// GKE / GCE means the attached service account — so no key file is needed and
// none should be shipped. Grant that service account `roles/storage.objectAdmin`
// on the bucket.
//
// `@google-cloud/storage` is an OPTIONAL dependency — required lazily, so a
// SQLite/local install never needs it installed.

function createGcsStorage(config) {
  const { bucket: bucketName, prefix } = config.storage;
  if (!bucketName) throw new Error('STORAGE_DRIVER=gcs requires PHOTOS_BUCKET');

  let Storage;
  try {
    ({ Storage } = require('@google-cloud/storage'));
  } catch (_) {
    throw new Error(
      'STORAGE_DRIVER=gcs needs the GCS client. Install it with:  npm install @google-cloud/storage'
    );
  }

  const storage = new Storage();
  const bucket = storage.bucket(bucketName);
  const fileFor = (name) => bucket.file(`${prefix}${String(name).replace(/^\/+/, '')}`);

  return {
    name: 'gcs',

    describe: () => `gs://${bucketName}/${prefix}`,

    async put(name, buffer, contentType) {
      await fileFor(name).save(buffer, {
        contentType: contentType || 'application/octet-stream',
        resumable: false, // photos are small; one request is faster
      });
    },

    async get(name) {
      try {
        const [buf] = await fileFor(name).download();
        return buf;
      } catch (_) {
        return null; // missing photo is not an error
      }
    },
  };
}

module.exports = { createGcsStorage };
