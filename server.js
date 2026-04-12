/**
 * FlashForge Remote Control Server
 *
 * Communicates with FlashForge printers via:
 * - TCP API (port 8899) for G-code commands — works on ALL models
 * - HTTP API (port 8898) for modern printers that support it (optional)
 * - UDP discovery (ports 8899, 19000, 48899) for printer detection
 */

const express = require('express');
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── State ─────────────────────────────────────────────────────────
let connectedPrinter = null;   // { ip, serialNumber, name, model, hasHttpApi }
let pollingInterval = null;
const WS_CLIENTS = new Set();

// ─── WebSocket broadcast ───────────────────────────────────────────
wss.on('connection', (ws) => {
  WS_CLIENTS.add(ws);
  ws.on('close', () => WS_CLIENTS.delete(ws));
  if (connectedPrinter) {
    ws.send(JSON.stringify({ type: 'printer-connected', data: connectedPrinter }));
  }
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const ws of WS_CLIENTS) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ─── FlashForge TCP API (port 8899) — Primary protocol ────────────
function tcpCommand(ip, command, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('TCP timeout'));
    }, timeout);

    socket.connect(8899, ip, () => {
      socket.write(`~${command}\r\n`);
    });

    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('ok')) {
        clearTimeout(timer);
        socket.end();
        resolve(data);
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.on('close', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// ─── TCP Response Parsers ─────────────────────────────────────────
function parseM105(raw) {
  // "T0:219.9/220.0 T1:0.0/0.0 B:55.0/55.0"
  const result = {};
  const t0 = raw.match(/T0:([\d.]+)\/([\d.]+)/);
  if (t0) { result.nozzleTemp = parseFloat(t0[1]); result.nozzleTarget = parseFloat(t0[2]); }
  const b = raw.match(/B:([\d.]+)\/([\d.]+)/);
  if (b) { result.bedTemp = parseFloat(b[1]); result.bedTarget = parseFloat(b[2]); }
  return result;
}

function parseM27(raw) {
  // "SD printing byte 8/100" and "Layer: 4/118"
  const result = {};
  const sd = raw.match(/SD printing byte (\d+)\/(\d+)/);
  if (sd) { result.progress = parseInt(sd[1]); result.progressTotal = parseInt(sd[2]); }
  const layer = raw.match(/Layer:\s*(\d+)\/(\d+)/);
  if (layer) { result.currentLayer = parseInt(layer[1]); result.totalLayers = parseInt(layer[2]); }
  return result;
}

function parseM119(raw) {
  // MachineStatus: BUILDING, MoveMode: HOMING, LED: 0, CurrentFile: name.3mf
  const result = {};
  const status = raw.match(/MachineStatus:\s*(\S+)/);
  if (status) result.machineStatus = status[1];
  const mode = raw.match(/MoveMode:\s*(\S+)/);
  if (mode) result.moveMode = mode[1];
  const led = raw.match(/LED:\s*(\d+)/);
  if (led) result.ledState = parseInt(led[1]);
  const file = raw.match(/CurrentFile:\s*(.+?)[\r\n]/);
  if (file) result.currentFile = file[1].trim();
  const endstop = raw.match(/Endstop:\s*(.+?)[\r\n]/);
  if (endstop) result.endstops = endstop[1].trim();
  return result;
}

function parseM115(raw) {
  const result = {};
  const type = raw.match(/Machine Type:\s*(.+?)[\r\n]/);
  if (type) result.machineType = type[1].trim();
  const name = raw.match(/Machine Name:\s*(.+?)[\r\n]/);
  if (name) result.machineName = name[1].trim();
  const fw = raw.match(/Firmware:\s*(.+?)[\r\n]/);
  if (fw) result.firmware = fw[1].trim();
  const sn = raw.match(/SN:\s*(.+?)[\r\n]/);
  if (sn) result.serialNumber = sn[1].trim();
  const xyz = raw.match(/X:\s*(\d+)\s*Y:\s*(\d+)\s*Z:\s*(\d+)/);
  if (xyz) result.buildVolume = { x: parseInt(xyz[1]), y: parseInt(xyz[2]), z: parseInt(xyz[3]) };
  const mac = raw.match(/Mac Address:\s*(.+?)[\r\n]/);
  if (mac) result.macAddress = mac[1].trim();
  return result;
}

function parseM114(raw) {
  const result = {};
  const pos = raw.match(/X:([\d.-]+)\s*Y:([\d.-]+)\s*Z:([\d.-]+)/);
  if (pos) {
    result.x = parseFloat(pos[1]);
    result.y = parseFloat(pos[2]);
    result.z = parseFloat(pos[3]);
  }
  return result;
}

// Map FlashForge machine status to a simple state
function mapMachineStatus(status) {
  if (!status) return 'unknown';
  switch (status.toUpperCase()) {
    case 'READY': return 'ready';
    case 'BUILDING': return 'printing';
    case 'PAUSED': return 'paused';
    case 'ERROR': return 'error';
    case 'COMPLETED': return 'completed';
    case 'BUSY_F': case 'BUSY': return 'busy';
    default: return status.toLowerCase();
  }
}

// ─── Full status poll via TCP ─────────────────────────────────────
async function getFullStatus(ip) {
  // Run all status commands
  const [m105Raw, m27Raw, m119Raw, m114Raw] = await Promise.all([
    tcpCommand(ip, 'M105').catch(() => ''),
    tcpCommand(ip, 'M27').catch(() => ''),
    tcpCommand(ip, 'M119').catch(() => ''),
    tcpCommand(ip, 'M114').catch(() => ''),
  ]);

  const temps = parseM105(m105Raw);
  const progress = parseM27(m27Raw);
  const machineState = parseM119(m119Raw);
  const position = parseM114(m114Raw);

  return {
    state: mapMachineStatus(machineState.machineStatus),
    machineStatus: machineState.machineStatus || 'UNKNOWN',
    moveMode: machineState.moveMode || '',
    nozzleTemp: temps.nozzleTemp ?? 0,
    nozzleTarget: temps.nozzleTarget ?? 0,
    bedTemp: temps.bedTemp ?? 0,
    bedTarget: temps.bedTarget ?? 0,
    progress: progress.progress ?? 0,
    currentLayer: progress.currentLayer ?? 0,
    totalLayers: progress.totalLayers ?? 0,
    currentFile: machineState.currentFile || '',
    ledState: machineState.ledState ?? 0,
    position,
    endstops: machineState.endstops || '',
  };
}

// ─── HTTP API (port 8898) — optional for printers that support it ──
async function ffPost(ip, endpoint, body) {
  const url = `http://${ip}:8898${endpoint}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return resp.json();
}

async function checkHttpApi(ip) {
  try {
    await fetch(`http://${ip}:8898/product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(2000),
    });
    return true;
  } catch {
    return false;
  }
}

// ─── UDP Printer Discovery ────────────────────────────────────────
function discoverPrinters(timeout = 5000) {
  return new Promise((resolve) => {
    const printers = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const emptyPacket = Buffer.alloc(0);

    const timer = setTimeout(() => {
      socket.close();
      resolve(Array.from(printers.values()));
    }, timeout);

    socket.on('message', (buffer, rinfo) => {
      const printer = parseDiscoveryResponse(buffer, rinfo);
      if (printer) {
        const key = `${printer.ipAddress}:${printer.commandPort}`;
        printers.set(key, printer);
      }
    });

    socket.on('error', () => {});

    socket.bind(0, () => {
      socket.setBroadcast(true);
      try { socket.addMembership('225.0.0.9'); } catch (e) { /* */ }
      for (const port of [8899, 19000, 48899]) {
        try { socket.send(emptyPacket, 0, 0, port, '225.0.0.9'); } catch (e) { /* */ }
        try { socket.send(emptyPacket, 0, 0, port, '255.255.255.255'); } catch (e) { /* */ }
      }
      const interfaces = os.networkInterfaces();
      for (const [, nets] of Object.entries(interfaces)) {
        for (const iface of nets || []) {
          if (iface.family === 'IPv4' && !iface.internal && iface.netmask) {
            const ip = iface.address.split('.').map(Number);
            const mask = iface.netmask.split('.').map(Number);
            const bcast = ip.map((o, i) => o | (~mask[i] & 255)).join('.');
            for (const port of [8899, 19000, 48899]) {
              try { socket.send(emptyPacket, 0, 0, port, bcast); } catch (e) { /* */ }
            }
          }
        }
      }
    });
  });
}

function parseDiscoveryResponse(buffer, rinfo) {
  if (!buffer || buffer.length === 0) return null;
  try {
    if (buffer.length >= 276) {
      const name = buffer.toString('utf8', 0x00, 0x84).replace(/\0.*$/, '');
      const commandPort = buffer.readUInt16BE(0x84);
      const productType = buffer.readUInt16BE(0x8C);
      const serialNumber = buffer.toString('utf8', 0x92, 0x92 + 130).replace(/\0.*$/, '');
      const statusCode = buffer.readUInt16BE(0x90);
      let model = 'Unknown';
      const u = name.toUpperCase();
      if (u === 'AD5X') model = 'AD5X';
      else if (productType === 0x5A02) model = u.includes('PRO') ? 'Adventurer 5M Pro' : 'Adventurer 5M';
      else if (u.includes('5M')) model = u.includes('PRO') ? 'Adventurer 5M Pro' : 'Adventurer 5M';
      return { name, model, ipAddress: rinfo.address, commandPort, serialNumber, statusCode, protocol: 'modern' };
    }
    if (buffer.length >= 140) {
      const name = buffer.toString('utf8', 0x00, 0x80).replace(/\0.*$/, '');
      const commandPort = buffer.readUInt16BE(0x84);
      const statusCode = buffer.readUInt16BE(0x8A);
      let model = 'Unknown';
      const u = name.toUpperCase();
      if (u.includes('ADVENTURER 4') || u.includes('AD4')) model = 'Adventurer 4';
      else if (u.includes('ADVENTURER 3') || u.includes('AD3')) model = 'Adventurer 3';
      return { name, model, ipAddress: rinfo.address, commandPort, serialNumber: '', statusCode, protocol: 'legacy' };
    }
  } catch (e) { /* */ }
  return null;
}

// ─── Status Polling ───────────────────────────────────────────────
async function pollStatus() {
  if (!connectedPrinter) return;
  try {
    const status = await getFullStatus(connectedPrinter.ip);
    broadcast('status-update', status);
  } catch (err) {
    broadcast('status-error', { error: err.message });
  }
}

function startPolling() {
  stopPolling();
  pollStatus();
  pollingInterval = setInterval(pollStatus, 3000);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

// ─── REST API Routes ──────────────────────────────────────────────

app.get('/api/discover', async (req, res) => {
  try {
    const printers = await discoverPrinters(5000);
    res.json({ success: true, printers });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Connect — uses TCP M115 to identify printer (no HTTP needed)
app.post('/api/connect', async (req, res) => {
  const { ip, serialNumber } = req.body;
  if (!ip) return res.json({ success: false, error: 'IP address required' });

  try {
    // Verify connection via TCP
    const m115Raw = await tcpCommand(ip, 'M115');
    const info = parseM115(m115Raw);

    if (!info.machineName && !info.machineType) {
      return res.json({ success: false, error: 'Could not identify printer at ' + ip });
    }

    // Check if HTTP API is available (for newer firmware)
    const hasHttpApi = await checkHttpApi(ip);

    connectedPrinter = {
      ip,
      serialNumber: serialNumber || info.serialNumber || '',
      name: info.machineName || info.machineType || 'FlashForge Printer',
      model: info.machineType || 'Unknown',
      firmware: info.firmware || '',
      buildVolume: info.buildVolume || null,
      macAddress: info.macAddress || '',
      hasHttpApi,
    };

    console.log(`Connected to ${connectedPrinter.name} at ${ip} (TCP${hasHttpApi ? ' + HTTP' : ' only'})`);

    broadcast('printer-connected', connectedPrinter);
    startPolling();
    res.json({ success: true, printer: connectedPrinter });
  } catch (err) {
    res.json({ success: false, error: 'Could not connect: ' + err.message });
  }
});

app.post('/api/disconnect', (req, res) => {
  stopPolling();
  const name = connectedPrinter?.name || 'printer';
  connectedPrinter = null;
  broadcast('printer-disconnected', {});
  console.log(`Disconnected from ${name}`);
  res.json({ success: true });
});

app.get('/api/status', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  try {
    const status = await getFullStatus(connectedPrinter.ip);
    res.json({ success: true, status });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Job control via TCP G-code
app.post('/api/job/:action', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  const action = req.params.action;
  const cmdMap = { pause: 'M25', continue: 'M24', resume: 'M24', cancel: 'M26' };
  const cmd = cmdMap[action];
  if (!cmd) return res.json({ success: false, error: 'Unknown action: ' + action });

  try {
    const response = await tcpCommand(connectedPrinter.ip, cmd);
    res.json({ success: true, response });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// LED control via TCP
app.post('/api/led/:state', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  try {
    // M146 r:val g:val b:val F:0 for LED on, all 0 for off
    const on = req.params.state === 'on';
    const cmd = on ? 'M146 r255 g255 b255 F0' : 'M146 r0 g0 b0 F0';
    const response = await tcpCommand(connectedPrinter.ip, cmd);
    res.json({ success: true, response });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Temperature control via TCP G-code
app.post('/api/temperature', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  const { nozzle, bed } = req.body;
  try {
    const results = [];
    if (nozzle !== undefined) {
      const r = await tcpCommand(connectedPrinter.ip, `M104 S${nozzle} T0`);
      results.push('Nozzle: ' + r.trim());
    }
    if (bed !== undefined) {
      const r = await tcpCommand(connectedPrinter.ip, `M140 S${bed}`);
      results.push('Bed: ' + r.trim());
    }
    res.json({ success: true, response: results.join('\n') });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Send raw G-code via TCP
app.post('/api/gcode', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  const { command } = req.body;
  try {
    const response = await tcpCommand(connectedPrinter.ip, command);
    res.json({ success: true, response });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Home axes via TCP
app.post('/api/home', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  try {
    const response = await tcpCommand(connectedPrinter.ip, 'G28');
    res.json({ success: true, response });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Speed override via TCP
app.post('/api/speed', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  const { speed } = req.body;
  try {
    const response = await tcpCommand(connectedPrinter.ip, `M220 S${speed}`);
    res.json({ success: true, response });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Fan control via TCP
app.post('/api/fan', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  const { speed = 255 } = req.body; // 0-255
  try {
    const response = await tcpCommand(connectedPrinter.ip, `M106 S${speed}`);
    res.json({ success: true, response });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Get printer info (M115)
app.get('/api/info', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  try {
    const raw = await tcpCommand(connectedPrinter.ip, 'M115');
    const info = parseM115(raw);
    res.json({ success: true, info, raw });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Print a file (via TCP M23 + M24)
app.post('/api/print', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  const { fileName } = req.body;
  try {
    // Select file then start
    await tcpCommand(connectedPrinter.ip, `M23 0:/user/${fileName}`);
    const response = await tcpCommand(connectedPrinter.ip, 'M24');
    res.json({ success: true, response });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Get file list (via TCP M20)
app.get('/api/files', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  try {
    const raw = await tcpCommand(connectedPrinter.ip, 'M661');
    // Parse file listing
    const files = [];
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('CMD') && trimmed !== 'ok' && !trimmed.startsWith('Begin')) {
        files.push(trimmed);
      }
    }
    res.json({ success: true, files, raw });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── File Download from Printer ───────────────────────────────

app.get('/api/files/download', (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  const fileName = req.query.name;
  if (!fileName) return res.json({ success: false, error: 'File name required' });

  const ip = connectedPrinter.ip;

  // Try HTTP API (port 8898) — only works on printers that expose it
  if (connectedPrinter.hasHttpApi) {
    const body = JSON.stringify({
      serialNumber: connectedPrinter.serialNumber || '',
      checkCode: '0',
      fileName: fileName.startsWith('0:/') ? fileName : '0:/user/' + fileName,
    });

    const proxyReq = http.request({
      hostname: ip,
      port: 8898,
      path: '/downloadGcode',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 60000,
    }, (proxyRes) => {
      const ct = proxyRes.headers['content-type'] || '';
      if (proxyRes.statusCode === 200 && !ct.includes('json')) {
        res.set('Content-Type', 'text/plain');
        proxyRes.pipe(res);
      } else {
        let data = '';
        proxyRes.on('data', c => data += c);
        proxyRes.on('end', () => {
          res.json({ success: false, error: 'Printer error: ' + data.substring(0, 200) });
        });
      }
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.json({ success: false, error: 'Download failed: ' + err.message });
      }
    });

    proxyReq.write(body);
    proxyReq.end();
    return;
  }

  // No HTTP API — can't download via TCP protocol
  res.json({ success: false, error: 'HTTP API not available on this printer. Load the .gcode file from your computer.' });
});

// ─── Camera Proxy ─────────────────────────────────────────────

app.get('/api/camera/detect', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  const ip = connectedPrinter.ip;

  // Probe snapshot first — it returns a complete response quickly.
  // Stream keeps the connection open indefinitely so fetch() never resolves cleanly.
  const probeCandidates = [
    { probe: `http://${ip}:8080/?action=snapshot`, stream: `http://${ip}:8080/?action=stream` },
    { probe: `http://${ip}:8080/snapshot`, stream: `http://${ip}:8080/stream` },
  ];

  for (const { probe, stream } of probeCandidates) {
    try {
      const r = await fetch(probe, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        // Drain body to free the connection, then return the stream URL
        await r.body?.cancel();
        return res.json({ success: true, url: stream });
      }
    } catch {}
  }

  res.json({ success: false, error: 'No camera found at known endpoints' });
});

app.get('/api/camera/stream', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('URL parameter required');

  // Security: only allow proxying to the connected printer's IP
  try {
    const parsed = new URL(url);
    if (!connectedPrinter || parsed.hostname !== connectedPrinter.ip) {
      return res.status(403).send('URL must point to the connected printer');
    }
  } catch {
    return res.status(400).send('Invalid URL');
  }

  const proxyReq = http.get(url, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': proxyRes.headers['content-type'] || 'multipart/x-mixed-replace',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => {
    if (!res.headersSent) res.status(502).send('Camera connection failed');
  });

  req.on('close', () => proxyReq.destroy());
});

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  FlashForge Remote Control`);
  console.log(`  ========================`);
  console.log(`  Server running at http://localhost:${PORT}`);
  console.log(`  Access from other devices: http://${getLocalIP()}:${PORT}`);
  console.log(`\n  Protocol: TCP G-code (port 8899) + optional HTTP API (port 8898)`);
  console.log(`  Discovery: UDP multicast 225.0.0.9 on ports 8899, 19000, 48899\n`);
});

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const [, nets] of Object.entries(interfaces)) {
    for (const iface of nets || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}
