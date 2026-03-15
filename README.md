# FlashForge Remote Control

A lightweight, web-based remote control for FlashForge 3D printers. Works directly over your local network — no cloud account, no FlashForge app required.

Built by reverse-engineering the FlashForge communication protocol from the Flash Maker APK and the [ff-5mp-api-ts](https://github.com/GhostTypes/ff-5mp-api-ts) project.

## Supported Printers

| Model | Status |
|-------|--------|
| Adventurer 5X (AD5X) | Tested |
| Adventurer 5M | Should work |
| Adventurer 5M Pro | Should work |
| Adventurer 4 | Should work (legacy TCP) |
| Adventurer 3 | Should work (legacy TCP) |

Any network-enabled FlashForge printer using TCP port 8899 should be compatible.

## Features

- **Auto-discovery** — Finds printers on your network via UDP multicast/broadcast
- **Live status** — Nozzle/bed temps, print progress, layer count, machine state (polls every 3s)
- **Job control** — Pause, resume, cancel active prints
- **Temperature control** — Set nozzle/bed temperatures, quick cool-down
- **LED control** — Toggle printer lights on/off
- **Speed override** — Adjust print speed percentage on the fly
- **G-code console** — Send any raw G/M-code command directly to the printer
- **File browser** — List files stored on the printer
- **Mobile-friendly** — Responsive UI works on phones, tablets, and desktops
- **WebSocket updates** — Real-time status pushed to all connected browsers

## Quick Start

```bash
git clone https://github.com/YOUR_USERNAME/FlashForge-RemoteControl.git
cd FlashForge-RemoteControl
npm install
node server.js
```

Open **http://localhost:3000** in your browser. Click **Scan Network** to find your printer, then click **Connect**.

Access from any device on your network using the IP shown at startup (e.g. `http://192.168.1.100:3000`).

## How It Works

### Communication Protocol

The server communicates with FlashForge printers using two protocols:

**TCP G-code (port 8899)** — Primary protocol, works on all models
- Commands are sent as `~COMMAND\r\n` (e.g. `~M105\r\n`)
- Responses are multi-line text terminated by `ok`
- Used for: status polling, temperature control, job control, LED, homing, speed

**HTTP API (port 8898)** — Optional, available on newer firmware
- JSON payloads authenticated with `serialNumber` + `checkCode`
- Endpoints: `/detail`, `/control`, `/product`, `/gcodeList`, `/printGcode`, `/uploadGcode`
- Auto-detected on connect; falls back to TCP-only if unavailable

**UDP Discovery (ports 8899, 19000, 48899)**
- Sends empty UDP packets to multicast group `225.0.0.9` and subnet broadcasts
- Modern printers respond with 276-byte packets (name, serial, status, ports)
- Legacy printers respond with 140-byte packets

### Key G-code Commands

| Command | Function |
|---------|----------|
| `M115` | Printer info (model, firmware, serial, build volume) |
| `M105` | Current temperatures (nozzle + bed, current/target) |
| `M119` | Machine status, current file, LED state, endstops |
| `M27` | Print progress (percentage + layer count) |
| `M114` | Current position (X/Y/Z) |
| `M104 S<temp>` | Set nozzle temperature |
| `M140 S<temp>` | Set bed temperature |
| `M24` | Resume print |
| `M25` | Pause print |
| `M26` | Cancel print |
| `M146 r<v> g<v> b<v>` | LED control (0=off, 255=on) |
| `M220 S<pct>` | Speed override percentage |
| `G28` | Home all axes |

### Architecture

```
server.js          — Express + WebSocket server, all printer communication
public/index.html  — Single-page responsive web UI
```

No build step. No framework. Just `node server.js`.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `3000` | Web server port |

## Development

```bash
# Run with auto-reload on changes (Node 18+)
npm run dev

# Or just
node --watch server.js
```

## Credits

- Protocol knowledge derived from the [Flash Maker APK](https://play.google.com/store/apps/details?id=com.flashforge.flashforge) (decompiled for research)
- API reference from [ff-5mp-api-ts](https://github.com/GhostTypes/ff-5mp-api-ts) by GhostTypes
- Inspired by [FlashForgeUI-Electron](https://github.com/Parallel-7/FlashForgeUI-Electron)

## License

MIT
