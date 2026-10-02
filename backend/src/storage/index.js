'use strict';

// Where kiosk-captured visitor photos live.
//
// On the reception PC a folder next to the database is exactly right. In the
// cloud it is not: a container's filesystem is wiped on every deploy and is not
// shared between instances, so a photo written by one instance would 404 from
// another. Hence three drivers behind one tiny interface:
//
//   local — a folder on disk           (on-premise, packaged .exe, LAN Docker)
//   s3    — S3 / any S3-compatible API (AWS, Cloudflare R2, MinIO, Backblaze)
//   gcs   — Google Cloud Storage       (Google Cloud)
//
// The interface is deliberately minimal — the app only ever stores a photo and
// reads it back:
//
//   put(name, buffer, contentType) → Promise<void>
//   get(name)                      → Promise<Buffer|null>
//   describe()                     → string, for the startup banner
//
// The database stores only the photo's NAME, never a path or URL, so an install
// can move between drivers (or move folders) without rewriting rows.

const config = require('../config');

function createDriver() {
  switch (config.storage.driver) {
    case 's3':
      return require('./s3').createS3Storage(config);
    case 'gcs':
      return require('./gcs').createGcsStorage(config);
    case 'local':
      return require('./local').createLocalStorage(config);
    default:
      throw new Error(
        `Unknown STORAGE_DRIVER "${config.storage.driver}" (expected "local", "s3" or "gcs")`
      );
  }
}

const driver = createDriver();

module.exports = {
  driver,
  put: (name, buffer, contentType) => driver.put(name, buffer, contentType),
  get: (name) => driver.get(name),
  describe: () => driver.describe(),
};
