'use strict';

/**
 * Tuberadio — Status & Archive API server
 *
 * Endpoints:
 *   GET /api/status   — whether the HLS stream is currently live
 *   GET /api/archive  — list of archived MP3 recordings (newest first)
 *
 * Environment variables:
 *   PORT                     Port to listen on                          (default: 3000)
 *   HLS_DIR                  Directory containing stream.m3u8           (default: /var/www/radio/hls)
 *   ARCHIVE_DIR              Directory containing archived MP3s         (default: /var/www/radio/archive)
 *   HIDDEN_ARCHIVE_DIR       Directory for hidden (aged-out) archives   (default: /var/www/radio/hidden_archive)
 *   STALE_MS                 ms after which a manifest is stale         (default: 30000)
 *   HLS_STREAM_URL           Public URL returned in /api/status         (default: /hls/stream.m3u8)
 *   ARCHIVE_URL_PREFIX       URL prefix for archive MP3 links           (default: /archive)
 *   ARCHIVE_AGE_DAYS         Move recordings to hidden archive after N days (0 = disabled, default: 0)
 *   HIDDEN_ARCHIVE_DELETE_DAYS  Delete from hidden archive after N days (0 = disabled, default: 0)
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HLS_DIR = process.env.HLS_DIR || '/var/www/radio/hls';
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || '/var/www/radio/archive';
const HIDDEN_ARCHIVE_DIR = process.env.HIDDEN_ARCHIVE_DIR || '/var/www/radio/hidden_archive';
/** If the HLS manifest hasn't been updated in this many ms, the stream is stale */
const STALE_MS = Number(process.env.STALE_MS) || 30_000;
/** Public URL for the HLS stream — returned in the /api/status payload */
const HLS_STREAM_URL = process.env.HLS_STREAM_URL || '/hls/stream.m3u8';
/** URL prefix used to build archive download links returned by /api/archive */
const ARCHIVE_URL_PREFIX = (process.env.ARCHIVE_URL_PREFIX || '/archive').replace(/\/$/, '');
/** Move MP3s older than this many days from ARCHIVE_DIR to HIDDEN_ARCHIVE_DIR; 0 = disabled */
const ARCHIVE_AGE_DAYS = Number(process.env.ARCHIVE_AGE_DAYS) || 0;
/** Delete MP3s from HIDDEN_ARCHIVE_DIR after this many days; 0 = disabled */
const HIDDEN_ARCHIVE_DELETE_DAYS = Number(process.env.HIDDEN_ARCHIVE_DELETE_DAYS) || 0;

// ---------------------------------------------------------------------------
// CORS — all responses allow any origin so the embeddable widget works across
// different domains
// ---------------------------------------------------------------------------
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  next();
});

app.options('*', (_req, res) => res.sendStatus(204));

// ---------------------------------------------------------------------------
// Rate limiting — prevent excessive filesystem access from any single client
// ---------------------------------------------------------------------------
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,             // 60 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

app.use('/api/', apiLimiter);

// ---------------------------------------------------------------------------
// GET /api/status
// ---------------------------------------------------------------------------
app.get('/api/status', (_req, res) => {
  const manifestPath = path.join(HLS_DIR, 'stream.m3u8');

  let live = false;
  let lastUpdated = null;

  try {
    const stat = fs.statSync(manifestPath);
    const ageMs = Date.now() - stat.mtimeMs;
    live = ageMs < STALE_MS;
    lastUpdated = stat.mtime.toISOString();
  } catch {
    // manifest doesn't exist yet → stream is not live
  }

  res.json({
    live,
    streamUrl: HLS_STREAM_URL,
    lastUpdated,
  });
});

// ---------------------------------------------------------------------------
// GET /api/archive
// ---------------------------------------------------------------------------
app.get('/api/archive', (_req, res) => {
  let recordings = [];

  try {
    recordings = fs
      .readdirSync(ARCHIVE_DIR)
      .filter((f) => f.endsWith('.mp3'))
      .sort()
      .reverse()
      .map((filename) => {
        const filePath = path.join(ARCHIVE_DIR, filename);
        let sizeBytes = 0;
        try {
          sizeBytes = fs.statSync(filePath).size;
        } catch {
          // ignore
        }

        // Filename pattern: YYYY-MM-DD_HH-MM-SS_<streamname>.mp3
        // Parse the leading timestamp for a human-readable date
        const match = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})_(.+)\.mp3$/);
        let startedAt = null;
        let streamName = null;
        if (match) {
          startedAt = `${match[1]}T${match[2].replace(/-/g, ':')}`;
          streamName = match[3];
        }

        return {
          filename,
          url: `${ARCHIVE_URL_PREFIX}/${filename}`,
          startedAt,
          streamName,
          sizeBytes,
        };
      });
  } catch {
    // archive dir doesn't exist yet
  }

  res.json({ recordings });
});

// ---------------------------------------------------------------------------
// Archive maintenance — move aged recordings to hidden archive; optionally
// delete very old files from the hidden archive.
// Runs once at startup and then every hour.
// ---------------------------------------------------------------------------

/**
 * Return the age of a file in whole completed days, based on its mtime.
 * @param {string} filePath
 * @returns {number}
 */
function fileAgeInDays(filePath) {
  const stat = fs.statSync(filePath);
  return Math.floor((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24));
}

function runArchiveMaintenance() {
  // 1. Move recordings older than ARCHIVE_AGE_DAYS from ARCHIVE_DIR → HIDDEN_ARCHIVE_DIR
  if (ARCHIVE_AGE_DAYS > 0) {
    try {
      fs.mkdirSync(HIDDEN_ARCHIVE_DIR, { recursive: true });
      const files = fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.mp3'));
      for (const filename of files) {
        const src = path.join(ARCHIVE_DIR, filename);
        try {
          if (fileAgeInDays(src) >= ARCHIVE_AGE_DAYS) {
            const dest = path.join(HIDDEN_ARCHIVE_DIR, filename);
            // Use copy-then-delete to support moves across different filesystems/volumes
            fs.copyFileSync(src, dest);
            fs.unlinkSync(src);
            console.log(`[archive] Moved to hidden archive: ${filename}`);
          }
        } catch (err) {
          console.error(`[archive] Error processing ${filename}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`[archive] Error reading ARCHIVE_DIR: ${err.message}`);
    }
  }

  // 2. Delete recordings older than HIDDEN_ARCHIVE_DELETE_DAYS from HIDDEN_ARCHIVE_DIR
  if (HIDDEN_ARCHIVE_DELETE_DAYS > 0) {
    try {
      fs.mkdirSync(HIDDEN_ARCHIVE_DIR, { recursive: true });
      const files = fs.readdirSync(HIDDEN_ARCHIVE_DIR).filter((f) => f.endsWith('.mp3'));
      for (const filename of files) {
        const filePath = path.join(HIDDEN_ARCHIVE_DIR, filename);
        try {
          if (fileAgeInDays(filePath) >= HIDDEN_ARCHIVE_DELETE_DAYS) {
            fs.unlinkSync(filePath);
            console.log(`[archive] Permanently deleted: ${filename}`);
          }
        } catch (err) {
          console.error(`[archive] Error deleting ${filename}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`[archive] Error reading HIDDEN_ARCHIVE_DIR: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Tuberadio API server listening on port ${PORT}`);
  console.log(`  HLS_DIR                    : ${HLS_DIR}`);
  console.log(`  ARCHIVE_DIR                : ${ARCHIVE_DIR}`);
  console.log(`  HIDDEN_ARCHIVE_DIR         : ${HIDDEN_ARCHIVE_DIR}`);
  console.log(`  HLS_STREAM_URL             : ${HLS_STREAM_URL}`);
  console.log(`  ARCHIVE_URL_PREFIX         : ${ARCHIVE_URL_PREFIX}`);
  console.log(`  ARCHIVE_AGE_DAYS           : ${ARCHIVE_AGE_DAYS || 'disabled'}`);
  console.log(`  HIDDEN_ARCHIVE_DELETE_DAYS : ${HIDDEN_ARCHIVE_DELETE_DAYS || 'disabled'}`);

  if (ARCHIVE_AGE_DAYS > 0 || HIDDEN_ARCHIVE_DELETE_DAYS > 0) {
    runArchiveMaintenance();
    setInterval(runArchiveMaintenance, 60 * 60 * 1000); // run every hour
  }
});
