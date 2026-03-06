# 📻 Tuberadio

> **Audio-only web radio from an RTMP stream.**  
> Takes a live RTMP push (e.g. from a YouTube fan-out project), strips the video with FFmpeg, exposes the audio as an HLS stream, archives every transmission as a timestamped MP3, and provides an embeddable vanilla-JS player widget.

![Tuberadio dev site](https://github.com/user-attachments/assets/46fc9fea-8dbf-40ba-bd4e-bbd64ec310ac)

---

## Architecture

```
YouTube stream
      │
      ▼  RTMP push
┌─────────────────────────────────────────────────────────────────┐
│  Nginx RTMP  (port 1935)                                        │
│  application: live                                              │
│  exec_push → on-publish.sh $name                               │
└───────────────────────┬─────────────────────────────────────────┘
                        │  rtmp://127.0.0.1/live/<stream>
                        ▼
                   ┌─────────┐
                   │  FFmpeg │  (audio only, -vn)
                   └────┬────┘
          ┌─────────────┴──────────────┐
          ▼                            ▼
  /var/www/radio/hls/          /var/www/radio/archive/
  stream.m3u8  (HLS)           YYYY-MM-DD_HH-MM-SS_<name>.mp3
  seg00001.ts  …

          │                            │
          └──────────┬─────────────────┘
                     ▼
          Nginx HTTP  (port 8080)
          /hls/     → live HLS segments + manifest
          /archive/ → archived MP3 files (directory listing)
          /api/     → proxied to Node.js API (port 3000)

                     │
                     ▼
          Browser / Embedded widget
          tuberadio.js  (vanilla JS, zero runtime deps)
```

---

## Quick Start (Docker)

```bash
# 1. Clone and start
git clone https://github.com/jsilvanus/Tuberadio.git
cd Tuberadio
docker compose up -d

# 2. Push your RTMP stream to:
#    rtmp://<your-server>:1935/live/stream
#    (replace "stream" with any key you like)

# 3. Open the HLS stream in any player:
#    http://<your-server>:8080/hls/stream.m3u8

# 4. Browse archived recordings:
#    http://<your-server>:8080/archive/
```

---

## Repository layout

```
.
├── nginx/
│   └── nginx.conf          # Nginx RTMP + HTTP configuration
├── scripts/
│   └── on-publish.sh       # Called by nginx when a publisher connects
│                           # Launches FFmpeg → HLS + MP3 archive
├── server/
│   ├── index.js            # Node.js status & archive JSON API
│   ├── package.json
│   └── Dockerfile
├── frontend/
│   └── tuberadio.js        # Embeddable vanilla JS audio player widget
├── dev/                    # Vite development / demo site
│   ├── index.html
│   ├── src/main.js
│   ├── vite.config.js
│   └── package.json
└── docker-compose.yml
```

---

## Nginx RTMP configuration (`nginx/nginx.conf`)

Key points:

| Setting | Value | Purpose |
|---|---|---|
| RTMP port | `1935` | Receives the incoming stream |
| Application | `live` | Stream key is the path, e.g. `rtmp://…/live/mykey` |
| `exec_push` | `on-publish.sh $name` | Launches FFmpeg when a publisher connects |
| HTTP port | `8080` | Serves HLS + archives + API proxy |
| `/hls/` | `no-cache` + CORS | Rolling HLS segments |
| `/archive/` | autoindex + CORS | Downloadable MP3 archives |
| `/api/` | proxy → port 3000 | Node.js JSON status/archive API |

---

## FFmpeg processing (`scripts/on-publish.sh`)

A single FFmpeg process with **two simultaneous outputs**:

```
Input:  rtmp://127.0.0.1/live/<stream>   (from nginx)

Output 1 — Live HLS audio stream
  codec : AAC  128 kbps
  format: HLS  (4 s segments, 10-segment rolling window)
  path  : /var/www/radio/hls/stream.m3u8

Output 2 — Full-session archive
  codec : MP3 (libmp3lame)  128 kbps
  tags  : title=<stream>, date=<start timestamp>
  path  : /var/www/radio/archive/YYYY-MM-DD_HH-MM-SS_<stream>.mp3
```

Environment variables you can override:

| Variable | Default | Description |
|---|---|---|
| `HLS_DIR` | `/var/www/radio/hls` | HLS output directory |
| `ARCHIVE_DIR` | `/var/www/radio/archive` | Archive output directory |
| `LOG_DIR` | `/var/log/tuberadio` | FFmpeg log directory |
| `AUDIO_BITRATE` | `128k` | Bitrate for both outputs |
| `HLS_TIME` | `4` | HLS segment duration (seconds) |
| `HLS_LIST_SIZE` | `10` | Number of segments in playlist |

---

## Status API (`server/`)

A minimal Node.js / Express server on port 3000 (proxied by nginx at `/api/`).

### `GET /api/status`

```json
{
  "live": true,
  "streamUrl": "/hls/stream.m3u8",
  "lastUpdated": "2024-06-01T14:32:00.000Z"
}
```

A stream is considered **live** when `stream.m3u8` was modified less than 30 seconds ago.

### `GET /api/archive`

```json
{
  "recordings": [
    {
      "filename": "2024-06-01_14-30-00_stream.mp3",
      "url": "/archive/2024-06-01_14-30-00_stream.mp3",
      "startedAt": "2024-06-01T14:30:00",
      "streamName": "stream",
      "sizeBytes": 12345678
    }
  ]
}
```

---

## Embeddable widget (`frontend/tuberadio.js`)

A **self-contained vanilla JS file** — no build step, no runtime dependencies.  
HLS.js is loaded from the CDN automatically for non-Safari browsers; Safari uses native HLS.

### Declarative (recommended)

```html
<!-- Place anywhere in your HTML -->
<div
  data-tuberadio
  data-title="My Radio"
  data-stream-url="https://radio.example.com/hls/stream.m3u8"
  data-status-url="https://radio.example.com/api/status"
  data-archive-url="https://radio.example.com/api/archive"
></div>

<!-- Include once, anywhere on the page -->
<script src="https://radio.example.com/tuberadio.js"></script>
```

### Programmatic

```html
<div id="player"></div>
<script src="tuberadio.js"></script>
<script>
  const player = new TubeRadio({
    container:   document.getElementById('player'),
    title:       'My Radio',
    streamUrl:   'https://radio.example.com/hls/stream.m3u8',
    statusUrl:   'https://radio.example.com/api/status',
    archiveUrl:  'https://radio.example.com/api/archive',
    pollInterval: 10000,  // ms between status checks
  });

  // Later: player.destroy();
</script>
```

### `data-*` attributes

| Attribute | Default | Description |
|---|---|---|
| `data-title` | `Tuberadio` | Station name shown in the widget |
| `data-stream-url` | `/hls/stream.m3u8` | HLS manifest URL |
| `data-status-url` | `/api/status` | Status API endpoint |
| `data-archive-url` | `/api/archive` | Archive API endpoint |
| `data-poll-interval` | `10000` | Polling interval in ms |

---

## Vite dev site (`dev/`)

An interactive demo page for developing and previewing the widget.

**Features:**
- Live preview of the `tuberadio.js` widget
- Config panel — edit station title, URLs; player re-initialises instantly
- **Embed code generator** — live-updating HTML snippet
- **Copy button** — one click to copy the snippet to your clipboard
- Proxies `/api/`, `/hls/`, `/archive/` to the running backend

```bash
cd dev
npm install
npm run dev   # → http://localhost:5173
```

> Make sure the Node.js API server and nginx are running before starting Vite so the proxy targets exist.

```bash
# In another terminal — start the API server
cd server && npm start

# Then start Vite
cd dev && npm run dev
```

---

## Integration with a YouTube fan-out project

This project is designed to sit downstream of a fan-out tool that re-streams YouTube live broadcasts to multiple RTMP destinations.

Point one of the RTMP outputs at:

```
rtmp://<tuberadio-host>:1935/live/<stream-key>
```

Tuberadio handles the rest: audio extraction, HLS packaging, archiving, and the embeddable player.

---

## Requirements

- **Nginx** built with [`nginx-rtmp-module`](https://github.com/arut/nginx-rtmp-module)  
  (the Docker image `alfg/nginx-rtmp` includes this)
- **FFmpeg** with `libmp3lame` and native `aac` encoder  
  (standard static builds include both)
- **Node.js** ≥ 18 for the API server
- **npm** ≥ 9 for the dev site
