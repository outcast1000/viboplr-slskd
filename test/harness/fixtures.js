// slskd search-response fixtures. Field names mirror
// src/slskd/Search/Types/{Response,File}.cs exactly.
//
// Reminder for anyone editing these: `size` is BYTES, `length` is DURATION IN
// SECONDS, and `isLocked` is never set by slskd's mapper — locked files are
// identified by living in `lockedFiles`, not by the flag.

function file(overrides) {
  return Object.assign(
    {
      filename: "@@abc\\Music\\Artist - Album\\01 - Track.mp3",
      extension: "mp3",
      size: 8 * 1024 * 1024,
      length: 210,
      bitRate: 320,
      bitDepth: null,
      sampleRate: 44100,
      isVariableBitRate: false,
      code: 1
    },
    overrides || {}
  );
}

function response(overrides) {
  return Object.assign(
    {
      username: "peer",
      hasFreeUploadSlot: true,
      queueLength: 0,
      uploadSpeed: 500000,
      fileCount: 1,
      lockedFileCount: 0,
      files: [],
      lockedFiles: [],
      token: 1
    },
    overrides || {}
  );
}

module.exports = { file, response };
