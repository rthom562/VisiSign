'use strict';

// Local-disk photo storage — the on-premise default.
//
// Photos land in a folder next to the database, so a VisiSign install is still
// "a folder you can copy". Used by the packaged .exe, the reception PC, and a
// Docker host with a mounted volume.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

function createLocalStorage(config) {
  const dir = config.storage.dir;

  // Reject anything that is not a bare filename, so a crafted photo name can
  // never escape the photos folder.
  const resolve = (name) => {
    const base = path.basename(String(name || ''));
    if (!base || base === '.' || base === '..') throw new Error('Invalid photo name');
    return path.join(dir, base);
  };

  return {
    name: 'local',

    describe: () => dir,

    async put(name, buffer) {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(resolve(name), buffer);
    },

    async get(name) {
      try {
        return await fsp.readFile(resolve(name));
      } catch (_) {
        return null; // missing photo is not an error — the badge prints without one
      }
    },

    // Synchronous read, for the direct Windows print path which hands a real
    // file path to PowerShell rather than a buffer.
    pathFor(name) {
      const p = resolve(name);
      return fs.existsSync(p) ? p : null;
    },
  };
}

module.exports = { createLocalStorage };
