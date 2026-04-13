/**
 * FlashForge Remote Control Server
 *
 * Communicates with FlashForge printers via:
 * - HTTP API (port 8898) for modern printers — preferred when checkCode is provided
 * - TCP API (port 8899) for G-code commands — fallback, works on ALL models
 * - UDP discovery (ports 8899, 19000, 48899) for printer detection
 */

const express = require('express');
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});

// ─── State ─────────────────────────────────────────────────────────
let connectedPrinter = null; // { ip, serialNumber, name, model, firmware, buildVolume, macAddress, hasHttpApi, checkCode }
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

// ─── FlashForge TCP API (port 8899) ───────────────────────────────
function tcpCommand(ip, command, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('TCP timeout')); }, timeout);

    socket.connect(8899, ip, () => { socket.write(`~${command}\r\n`); });

    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('ok')) { clearTimeout(timer); socket.end(); resolve(data); }
    });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
    socket.on('close', () => { clearTimeout(timer); resolve(data); });
  });
}

// ─── HTTP API helpers (port 8898) ─────────────────────────────────
async function ffPost(ip, endpoint, body) {
  const resp = await fetch(`http://${ip}:8898${endpoint}`, {
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
  } catch { return false; }
}

// Build a multipart/form-data body for /uploadGcode
function buildMultipart(fields, fileBuffer, fileName) {
  const boundary = '----FlashForgeBoundary' + crypto.randomBytes(12).toString('hex');
  const crlf = '\r\n';
  const parts = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="${name}"${crlf}${crlf}` +
      `${value}${crlf}`
    ));
  }

  parts.push(Buffer.from(
    `--${boundary}${crlf}` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"${crlf}` +
    `Content-Type: application/octet-stream${crlf}${crlf}`
  ));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`${crlf}--${boundary}--${crlf}`));

  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// ─── TCP Response Parsers ─────────────────────────────────────────
function parseM105(raw) {
  const result = {};
  const t0 = raw.match(/T0:([\d.]+)\/([\d.]+)/);
  if (t0) { result.nozzleTemp = parseFloat(t0[1]); result.nozzleTarget = parseFloat(t0[2]); }
  const b = raw.match(/B:([\d.]+)\/([\d.]+)/);
  if (b) { result.bedTemp = parseFloat(b[1]); result.bedTarget = parseFloat(b[2]); }
  return result;
}

function parseM27(raw) {
  const result = {};
  const sd = raw.match(/SD printing byte (\d+)\/(\d+)/);
  if (sd) { result.progress = parseInt(sd[1]); result.progressTotal = parseInt(sd[2]); }
  const layer = raw.match(/Layer:\s*(\d+)\/(\d+)/);
  if (layer) { result.currentLayer = parseInt(layer[1]); result.totalLayers = parseInt(layer[2]); }
  return result;
}

function parseM119(raw) {
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
  if (pos) { result.x = parseFloat(pos[1]); result.y = parseFloat(pos[2]); result.z = parseFloat(pos[3]); }
  return result;
}

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

// ─── HTTP /detail response → unified status shape ─────────────────
function parseDetailResponse(data) {
  // Printer may wrap in { code, detail: {...} } or return flat
  const d = data?.detail ?? data;
  if (!d || typeof d !== 'object') return null;

  return {
    state: mapMachineStatus(d.status),
    machineStatus: d.status || 'UNKNOWN',
    moveMode: '',
    // Temperatures
    nozzleTemp: d.rightTemperature ?? d.nozzleTemps?.[0] ?? 0,
    nozzleTarget: d.rightTargetTemperature ?? d.nozzleTargetTemps?.[0] ?? 0,
    nozzleTempLeft: d.leftTemperature ?? d.nozzleTemps?.[1] ?? 0,
    nozzleTargetLeft: d.leftTargetTemperature ?? d.nozzleTargetTemps?.[1] ?? 0,
    bedTemp: d.platformCurTemperature ?? 0,
    bedTarget: d.platformTargetTemperature ?? 0,
    chamberTemp: d.chamberTemp ?? 0,
    chamberTarget: d.chamberTargetTemp ?? 0,
    // Job info
    progress: d.progress ?? 0,
    currentLayer: d.printLayer ?? 0,
    totalLayers: d.targetLayer ?? 0,
    currentFile: d.jobID || '',
    thumbnailPath: d.thumbnailPath || '',
    estimateTime: d.estimateTime ?? 0,
    duration: d.duration ?? 0,
    currentSpeed: d.currentSpeed ?? 100,
    // States
    ledState: d.light === 'open' ? 1 : 0,
    doorOpen: d.door === 'open',
    errorCode: d.errorCode || '',
    // Filament
    rightFilamentType: d.rightFilamentType || '',
    leftFilamentType: d.leftFilamentType || '',
    hasMs: d.hasMs ?? false,
    // Fans
    coolingFan: d.coolingFan ?? 0,
    chamberFan: d.chamberFan ?? 0,
    clearFan: d.clearFan ?? 0,
    // Misc
    tvoc: d.tvoc ?? 0,
    remainMemory: d.remainMemory ?? 0,
    cumulativePrintTime: d.cumulativePrintTime ?? 0,
    cumulativeFilament: d.cumulativeFilament ?? 0,
    nozzleCount: d.nozzleCount ?? 1,
    firmwareVersion: d.firmwareVersion || '',
    // Camera
    hlsStream: d.hlsStream || '',
    cameraStreamUrl: d.cameraStreamUrl || '',
    videoUrl: d.videoUrl || '',
    // Position (not in detail, keep as empty)
    position: {},
    endstops: '',
  };
}

// ─── Full status via TCP (fallback) ───────────────────────────────
async function getTcpStatus(ip) {
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
    nozzleTempLeft: 0,
    nozzleTargetLeft: 0,
    bedTemp: temps.bedTemp ?? 0,
    bedTarget: temps.bedTarget ?? 0,
    chamberTemp: 0,
    chamberTarget: 0,
    progress: progress.progress ?? 0,
    currentLayer: progress.currentLayer ?? 0,
    totalLayers: progress.totalLayers ?? 0,
    currentFile: machineState.currentFile || '',
    ledState: machineState.ledState ?? 0,
    doorOpen: false,
    errorCode: '',
    currentSpeed: 100,
    position,
    endstops: machineState.endstops || '',
    hlsStream: '',
    cameraStreamUrl: '',
    videoUrl: '',
  };
}

// ─── Full status — prefers HTTP /detail when available ────────────
async function getFullStatus(ip) {
  if (connectedPrinter?.hasHttpApi && connectedPrinter?.checkCode) {
    try {
      const data = await ffPost(ip, '/detail', {
        serialNumber: connectedPrinter.serialNumber,
        checkCode: connectedPrinter.checkCode,
      });
      const parsed = parseDetailResponse(data);
      if (parsed) return parsed;
    } catch { /* fall through to TCP */ }
  }
  return getTcpStatus(ip);
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
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
}

// ─── UDP Printer Discovery ────────────────────────────────────────
function discoverPrinters(timeout = 5000) {
  return new Promise((resolve) => {
    const printers = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const emptyPacket = Buffer.alloc(0);

    const timer = setTimeout(() => { socket.close(); resolve(Array.from(printers.values())); }, timeout);

    socket.on('message', (buffer, rinfo) => {
      const printer = parseDiscoveryResponse(buffer, rinfo);
      if (printer) printers.set(`${printer.ipAddress}:${printer.commandPort}`, printer);
    });
    socket.on('error', () => {});

    socket.bind(0, () => {
      socket.setBroadcast(true);
      try { socket.addMembership('225.0.0.9'); } catch {}
      for (const port of [8899, 19000, 48899]) {
        try { socket.send(emptyPacket, 0, 0, port, '225.0.0.9'); } catch {}
        try { socket.send(emptyPacket, 0, 0, port, '255.255.255.255'); } catch {}
      }
      for (const [, nets] of Object.entries(os.networkInterfaces())) {
        for (const iface of nets || []) {
          if (iface.family === 'IPv4' && !iface.internal && iface.netmask) {
            const ip = iface.address.split('.').map(Number);
            const mask = iface.netmask.split('.').map(Number);
            const bcast = ip.map((o, i) => o | (~mask[i] & 255)).join('.');
            for (const port of [8899, 19000, 48899]) {
              try { socket.send(emptyPacket, 0, 0, port, bcast); } catch {}
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
  } catch {}
  return null;
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

// Connect — verify via TCP M115, auto-detect HTTP API
app.post('/api/connect', async (req, res) => {
  const { ip, serialNumber, checkCode } = req.body;
  if (!ip) return res.json({ success: false, error: 'IP address required' });

  try {
    const m115Raw = await tcpCommand(ip, 'M115');
    const info = parseM115(m115Raw);

    if (!info.machineName && !info.machineType) {
      return res.json({ success: false, error: 'Could not identify printer at ' + ip });
    }

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
      checkCode: checkCode || '',
    };

    const apiMode = hasHttpApi
      ? (checkCode ? 'HTTP + TCP' : 'TCP only (no checkCode for HTTP)')
      : 'TCP only';
    console.log(`Connected to ${connectedPrinter.name} at ${ip} [${apiMode}]`);

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

// ─── Job control ──────────────────────────────────────────────────
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

// ─── LED ──────────────────────────────────────────────────────────
app.post('/api/led/:state', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  const on = req.params.state === 'on';
  try {
    // Prefer HTTP /control lightControl_cmd when available
    if (connectedPrinter.hasHttpApi && connectedPrinter.checkCode) {
      const result = await ffPost(connectedPrinter.ip, '/control', {
        serialNumber: connectedPrinter.serialNumber,
        checkCode: connectedPrinter.checkCode,
        cmd: 'lightControl_cmd',
        status: on ? 'open' : 'close',
      });
      return res.json({ success: true, result });
    }
    // TCP fallback
    const tcpCmd = on ? 'M146 r255 g255 b255 F0' : 'M146 r0 g0 b0 F0';
    const response = await tcpCommand(connectedPrinter.ip, tcpCmd);
    res.json({ success: true, response });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Temperature ─────────────────────────────────────────────────
app.post('/api/temperature', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  const { nozzle, bed, chamber } = req.body;
  try {
    // Prefer HTTP /control temperatureCtl_cmd
    if (connectedPrinter.hasHttpApi && connectedPrinter.checkCode) {
      const body = {
        serialNumber: connectedPrinter.serialNumber,
        checkCode: connectedPrinter.checkCode,
        cmd: 'temperatureCtl_cmd',
      };
      if (nozzle !== undefined) body.rightNozzle = nozzle;
      if (bed !== undefined) body.platform = bed;
      if (chamber !== undefined) body.chamber = chamber;
      const result = await ffPost(connectedPrinter.ip, '/control', body);
      return res.json({ success: true, result });
    }
    // TCP fallback
    const results = [];
    if (nozzle !== undefined) { results.push(await tcpCommand(connectedPrinter.ip, `M104 S${nozzle} T0`)); }
    if (bed !== undefined) { results.push(await tcpCommand(connectedPrinter.ip, `M140 S${bed}`)); }
    res.json({ success: true, response: results.join('\n') });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Fan ─────────────────────────────────────────────────────────
app.post('/api/fan', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  const { speed = 255 } = req.body;
  try {
    const response = await tcpCommand(connectedPrinter.ip, `M106 S${speed}`);
    res.json({ success: true, response });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Speed ───────────────────────────────────────────────────────
app.post('/api/speed', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  const { speed } = req.body;
  try {
    // Prefer HTTP /control printerCtl_cmd
    if (connectedPrinter.hasHttpApi && connectedPrinter.checkCode) {
      const result = await ffPost(connectedPrinter.ip, '/control', {
        serialNumber: connectedPrinter.serialNumber,
        checkCode: connectedPrinter.checkCode,
        cmd: 'printerCtl_cmd',
        speed: Number(speed),
      });
      return res.json({ success: true, result });
    }
    const response = await tcpCommand(connectedPrinter.ip, `M220 S${speed}`);
    res.json({ success: true, response });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Home ────────────────────────────────────────────────────────
app.post('/api/home', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  try {
    // Prefer HTTP /control homingCtrl_cmd
    if (connectedPrinter.hasHttpApi && connectedPrinter.checkCode) {
      const result = await ffPost(connectedPrinter.ip, '/control', {
        serialNumber: connectedPrinter.serialNumber,
        checkCode: connectedPrinter.checkCode,
        cmd: 'homingCtrl_cmd',
      });
      return res.json({ success: true, result });
    }
    const response = await tcpCommand(connectedPrinter.ip, 'G28');
    res.json({ success: true, response });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Move axis ───────────────────────────────────────────────────
app.post('/api/move', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  const { axis, delta } = req.body;
  if (!axis || delta === undefined) return res.json({ success: false, error: 'axis and delta required' });

  try {
    if (connectedPrinter.hasHttpApi && connectedPrinter.checkCode) {
      const result = await ffPost(connectedPrinter.ip, '/control', {
        serialNumber: connectedPrinter.serialNumber,
        checkCode: connectedPrinter.checkCode,
        cmd: 'moveCtrl_cmd',
        axis: axis.toUpperCase(),
        delta: Number(delta),
      });
      return res.json({ success: true, result });
    }
    // TCP fallback: relative move
    await tcpCommand(connectedPrinter.ip, 'G91');
    await tcpCommand(connectedPrinter.ip, `G1 ${axis.toUpperCase()}${delta} F3000`);
    const response = await tcpCommand(connectedPrinter.ip, 'G90');
    res.json({ success: true, response });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Extrude / Retract ───────────────────────────────────────────
app.post('/api/extrude', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  const { amount = 10 } = req.body; // positive = extrude, negative = retract

  try {
    if (connectedPrinter.hasHttpApi && connectedPrinter.checkCode) {
      const result = await ffPost(connectedPrinter.ip, '/control', {
        serialNumber: connectedPrinter.serialNumber,
        checkCode: connectedPrinter.checkCode,
        cmd: 'extrudeCtrl_cmd',
        amount: Number(amount),
      });
      return res.json({ success: true, result });
    }
    // TCP fallback
    await tcpCommand(connectedPrinter.ip, 'T0');
    await tcpCommand(connectedPrinter.ip, 'G91');
    await tcpCommand(connectedPrinter.ip, `G1 E${amount} F200`);
    const response = await tcpCommand(connectedPrinter.ip, 'G90');
    res.json({ success: true, response });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── G-code (raw TCP) ────────────────────────────────────────────
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

// ─── Printer info ─────────────────────────────────────────────────
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

// ─── Product info (HTTP API) ──────────────────────────────────────
app.get('/api/product', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  try {
    if (connectedPrinter.hasHttpApi) {
      const product = await ffPost(connectedPrinter.ip, '/product', {
        serialNumber: connectedPrinter.serialNumber,
        checkCode: connectedPrinter.checkCode || '',
      });
      return res.json({ success: true, product });
    }
    // Fall back to M115
    const raw = await tcpCommand(connectedPrinter.ip, 'M115');
    res.json({ success: true, product: parseM115(raw) });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── File listing ─────────────────────────────────────────────────
app.get('/api/files', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  try {
    // Prefer HTTP /gcodeList (returns richer data)
    if (connectedPrinter.hasHttpApi && connectedPrinter.checkCode) {
      const result = await ffPost(connectedPrinter.ip, '/gcodeList', {
        serialNumber: connectedPrinter.serialNumber,
        checkCode: connectedPrinter.checkCode,
      });
      return res.json({ success: true, files: result });
    }
    // TCP fallback: M661 then M20
    let raw = await tcpCommand(connectedPrinter.ip, 'M661');
    const files = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('CMD') && t !== 'ok' && !t.startsWith('Begin')) files.push(t);
    }
    if (files.length === 0) {
      raw = await tcpCommand(connectedPrinter.ip, 'M20');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (t && !t.startsWith('CMD') && t !== 'ok' && !t.startsWith('Begin') && !t.startsWith('End')) files.push(t);
      }
    }
    res.json({ success: true, files, raw });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Print file already on printer ───────────────────────────────
app.post('/api/print', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  const { fileName, levelingBeforePrint = false } = req.body;
  try {
    // Prefer HTTP /printGcode
    if (connectedPrinter.hasHttpApi && connectedPrinter.checkCode) {
      const result = await ffPost(connectedPrinter.ip, '/printGcode', {
        serialNumber: connectedPrinter.serialNumber,
        checkCode: connectedPrinter.checkCode,
        fileName,
        levelingBeforePrint: levelingBeforePrint ? 1 : 0,
      });
      return res.json({ success: true, result });
    }
    // TCP fallback
    await tcpCommand(connectedPrinter.ip, `M23 0:/user/${fileName}`);
    const response = await tcpCommand(connectedPrinter.ip, 'M24');
    res.json({ success: true, response });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Upload file to printer ───────────────────────────────────────
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  if (!connectedPrinter.hasHttpApi) {
    return res.json({ success: false, error: 'HTTP API not available on this printer — upload requires port 8898' });
  }
  if (!connectedPrinter.checkCode) {
    return res.json({ success: false, error: 'checkCode (access PIN) required for file upload — re-connect with the printer PIN' });
  }
  if (!req.file) return res.json({ success: false, error: 'No file provided' });

  const {
    printNow = '0',
    levelingBeforePrint = '0',
    flowCalibration = '0',
    firstLayerInspection = '0',
    timeLapseVideo = '0',
    useMatlStation = '0',
    gcodeToolCnt = '1',
    materialMappings = '[]',
  } = req.body;

  const { serialNumber, checkCode, ip } = connectedPrinter;
  const { body, contentType } = buildMultipart(
    {
      serialNumber,
      checkCode,
      fileSize: String(req.file.size),
      printNow,
      levelingBeforePrint,
      flowCalibration,
      firstLayerInspection,
      timeLapseVideo,
      useMatlStation,
      gcodeToolCnt,
      materialMappings,
    },
    req.file.buffer,
    req.file.originalname
  );

  console.log(`Uploading ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB) to ${ip}`);

  try {
    const resp = await fetch(`http://${ip}:8898/uploadGcode`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
      signal: AbortSignal.timeout(300000), // 5 min for large files
    });
    const result = await resp.json().catch(() => ({ code: resp.status }));
    const success = result?.code === 200 || result?.success === true || resp.ok;
    console.log(`Upload ${success ? 'succeeded' : 'failed'}:`, result);
    res.json({ success, result });
  } catch (err) {
    res.json({ success: false, error: 'Upload failed: ' + err.message });
  }
});

// ─── File download from printer ───────────────────────────────────
app.get('/api/files/download', (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  const fileName = req.query.name;
  if (!fileName) return res.json({ success: false, error: 'File name required' });

  const ip = connectedPrinter.ip;

  if (connectedPrinter.hasHttpApi) {
    const bodyStr = JSON.stringify({
      serialNumber: connectedPrinter.serialNumber || '',
      checkCode: connectedPrinter.checkCode || '0',
      fileName: fileName.startsWith('0:/') ? fileName : '0:/user/' + fileName,
    });

    const proxyReq = http.request({
      hostname: ip, port: 8898, path: '/downloadGcode', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
      timeout: 60000,
    }, (proxyRes) => {
      const ct = proxyRes.headers['content-type'] || '';
      if (proxyRes.statusCode === 200 && !ct.includes('json')) {
        res.set('Content-Type', 'text/plain');
        proxyRes.pipe(res);
      } else {
        let data = '';
        proxyRes.on('data', c => data += c);
        proxyRes.on('end', () => res.json({ success: false, error: 'Printer error: ' + data.substring(0, 200) }));
      }
    });
    proxyReq.on('error', (err) => { if (!res.headersSent) res.json({ success: false, error: err.message }); });
    proxyReq.write(bodyStr);
    proxyReq.end();
    return;
  }

  res.json({ success: false, error: 'HTTP API not available on this printer. Load the .gcode file from your computer.' });
});

// ─── Camera detection & proxy ─────────────────────────────────────
app.get('/api/camera/detect', async (req, res) => {
  if (!connectedPrinter) return res.json({ success: false, error: 'Not connected' });
  const ip = connectedPrinter.ip;

  // First: check /detail for stream URLs
  if (connectedPrinter.hasHttpApi && connectedPrinter.checkCode) {
    try {
      const data = await ffPost(ip, '/detail', {
        serialNumber: connectedPrinter.serialNumber,
        checkCode: connectedPrinter.checkCode,
      });
      const d = data?.detail ?? data;
      if (d?.hlsStream) return res.json({ success: true, url: d.hlsStream, type: 'hls' });
      if (d?.cameraStreamUrl) return res.json({ success: true, url: d.cameraStreamUrl, type: 'mjpeg' });
      if (d?.videoUrl) return res.json({ success: true, url: d.videoUrl, type: 'mjpeg' });
    } catch {}
  }

  // Fallback: probe port 8080 (AD5X MJPEG)
  const portOpen = await new Promise(resolve => {
    const sock = net.createConnection({ host: ip, port: 8080 });
    sock.setTimeout(3000);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
  });

  if (portOpen) return res.json({ success: true, url: `http://${ip}:8080/?action=stream`, type: 'mjpeg' });
  res.json({ success: false, error: 'No camera found' });
});

app.get('/api/camera/stream', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('URL parameter required');
  try {
    const parsed = new URL(url);
    if (!connectedPrinter || parsed.hostname !== connectedPrinter.ip) {
      return res.status(403).send('URL must point to the connected printer');
    }
  } catch { return res.status(400).send('Invalid URL'); }

  const proxyReq = http.get(url, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': proxyRes.headers['content-type'] || 'multipart/x-mixed-replace',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
    });
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => { if (!res.headersSent) res.status(502).send('Camera connection failed'); });
  req.on('close', () => proxyReq.destroy());
});

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
  console.log(`\n  Status: HTTP /detail preferred (requires checkCode), TCP fallback always active`);
  console.log(`  Upload: POST /api/upload (requires HTTP API + checkCode)\n`);
});

function getLocalIP() {
  for (const [, nets] of Object.entries(os.networkInterfaces())) {
    for (const iface of nets || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}
