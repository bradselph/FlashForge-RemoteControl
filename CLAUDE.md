# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies (express, ws)
npm start            # Run server (node server.js)
npm run dev          # Run with auto-reload (node --watch server.js)
```

No build step, no linter, no tests yet. The app is plain JavaScript with zero compilation.

## Architecture

This is a two-file application: a Node.js backend (`server.js`) and a single-page frontend (`public/index.html`).

### server.js

The server handles three network protocols simultaneously:

**UDP Discovery** — Finds FlashForge printers on the LAN by sending empty UDP packets to multicast group `225.0.0.9` on ports 8899, 19000, and 48899. Printers respond with binary packets: 276 bytes (modern: AD5M/AD5X, contains name at 0x00, command port at 0x84, serial at 0x92) or 140 bytes (legacy: Adventurer 3/4).

**TCP G-code (port 8899)** — Primary control protocol. Every command is a new TCP socket connection: write `~COMMAND\r\n`, read until response contains `ok`, close. The `tcpCommand()` function handles this. All printer control flows through TCP: status polling, temperature, job control, LED, homing, speed. Each status poll fires 4 parallel TCP commands (`M105`, `M27`, `M119`, `M114`) via `getFullStatus()`.

**HTTP API (port 8898)** — Optional REST API on newer firmware. Auto-detected on connect via `checkHttpApi()`. Currently only the detection is wired up; all actual commands use TCP because the tested printer (AD5X firmware v1.2.3) does not expose port 8898. The `ffPost()` helper exists for when HTTP support is added.

**State model:** Single global `connectedPrinter` object (one printer at a time). A 3-second `setInterval` polls status and broadcasts to all WebSocket clients via `broadcast()`.

### public/index.html

Single HTML file containing all CSS, markup, and JavaScript inline. Two UI states: discovery panel (scan/manual IP) and dashboard (status, temps, job control, G-code console, files). The frontend connects a WebSocket to the server and receives `{ type, data }` messages. All printer actions go through `fetch('/api/...')` REST calls to the server.

### Data flow

```
Browser ←WebSocket→ server.js ←TCP 8899→ Printer
Browser ←REST API→  server.js ←TCP 8899→ Printer
                    server.js ←UDP→      Printer (discovery only)
```

The browser never talks to the printer directly. The server is the sole proxy.

### TCP response parsers

Each `parseM*()` function uses regex to extract structured data from raw TCP text responses. These are fragile — different firmware versions or printer models may return different formats. The parsers handle: `M105` (temperatures), `M27` (progress/layers), `M119` (machine status, current file, LED, endstops), `M115` (printer identity), `M114` (position). `mapMachineStatus()` normalizes FlashForge status strings (e.g. `BUILDING` → `printing`).

## FlashForge Protocol Reference

- TCP commands are prefixed with `~` (e.g. `~M105`), terminated with `\r\n`
- TCP responses are multi-line plain text ending with `ok`
- FlashForge uses non-standard G-codes: `M146` for LED RGB, `M661` for file listing, `M650`/`M651` for filament operations
- Boolean states in the HTTP API use strings `"open"` / `"close"` instead of true/false
- UDP discovery multicast group: `225.0.0.9`
- Modern discovery response binary layout: name (0x00, 132 bytes), commandPort (0x84, uint16 BE), productType (0x8C, uint16 BE), serial (0x92, 130 bytes)

## REST API Routes (server.js → frontend)

All routes return `{ success, ... }`. Most require a connected printer or return `{ success: false, error: 'Not connected' }`.

| Method | Route | Body / Params | Purpose |
|--------|-------|---------------|---------|
| GET | `/api/discover` | — | UDP scan for printers (5s timeout) |
| POST | `/api/connect` | `{ ip, serialNumber? }` | Connect via TCP M115, auto-detect HTTP API |
| POST | `/api/disconnect` | — | Stop polling, clear state |
| GET | `/api/status` | — | On-demand full status (normally pushed via WS) |
| POST | `/api/job/:action` | action: `pause`/`resume`/`continue`/`cancel` | M25/M24/M26 |
| POST | `/api/led/:state` | state: `on`/`off` | M146 RGB |
| POST | `/api/temperature` | `{ nozzle?, bed? }` | M104/M140 |
| POST | `/api/gcode` | `{ command }` | Raw G-code via TCP |
| POST | `/api/home` | — | G28 |
| POST | `/api/speed` | `{ speed }` | M220 S{speed} |
| POST | `/api/fan` | `{ speed? }` (0–255, default 255) | M106 |
| GET | `/api/info` | — | M115 printer identity |
| POST | `/api/print` | `{ fileName }` | M23 + M24 (select + start) |
| GET | `/api/files` | — | M661 file listing |

## WebSocket Messages (server → browser)

The frontend connects a single WebSocket and dispatches on `type`:

| Type | When | Data shape |
|------|------|------------|
| `printer-connected` | On connect + new WS client joins | `connectedPrinter` object |
| `printer-disconnected` | On disconnect | `{}` |
| `status-update` | Every 3s poll | `getFullStatus()` result (temps, progress, state, position, LED) |
| `status-error` | Poll failure | `{ error }` |

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PORT` | `3000` | Web server listen port |

## Known Limitations

- Only one printer connection at a time (global state, no multi-printer support)
- HTTP API (port 8898) is detected but not used for any commands yet
- File listing (`M661`) may return empty on some firmware; `M20` is an alternative
- No file upload support yet (would need HTTP multipart to `/uploadGcode`)
- No camera/RTSP streaming support
- TCP parsers assume specific response formats that may vary across models
- No authentication on the web UI
