'use strict';

// ============================================================
//  WasteWatch – app.js
//  Industrial IoT Dashboard for Smart Waste Bin System
//  Parses Arduino Mega B2 USB Serial stream (9600 baud)
//  Google Maps Engine (Dual Node Live Tracking: B1 + B2)
//  Theme: Precision Industrial Dark (Black, Blue, White)
// ============================================================

// ---------- DOM & Utility Helpers ----------
const $ = (id) => document.getElementById(id);

const ts = (d = new Date()) =>
  d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

function elapsed(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function safeNum(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toUpperCase();
  if (['NA', 'ERR', 'ERROR', 'NOFIX', '--', 'NAN', 'NULL', ''].includes(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Haversine formula for distance in meters between two lat/lon coordinates
function calcDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

// ---------- Application State ----------
const S = {
  mode: 'disconnected',   // 'disconnected' | 'live' | 'demo'

  // Latest Telemetry Fields
  seq: null,
  gas: null,
  dout: null,
  gasAlert: 'UNKNOWN',
  tempAlert: 'UNKNOWN',
  humAlert: 'UNKNOWN',
  dist: null,
  fill: null,
  fillAlert: 'UNKNOWN',
  status: 'WAITING',
  temp: null,
  hum: null,
  b1Lat: null,
  b1Lon: null,
  b1Fix: 'NOFIX',
  b1Sats: null,
  alert: 'UNKNOWN',
  b2Lat: null,
  b2Lon: null,
  b2Fix: 'NOFIX',
  b2Sats: null,
  rssi: null,
  snr: null,
  ackStatus: null,

  lastPacketAt: null,
  everSawB1: false,

  gasHistory:  [],   // [{at, v}]
  tempHistory: [],
  fillHistory: [],
  alertLog:    [],   // [{id, sev, title, desc, at}]
  telLog:      [],   // up to 50 parsed records
  consoleLines:[],   // up to 150 terminal lines

  // User Local Thresholds
  gasThresh:   400,
  tempThresh:  35,
  humThresh:   80,
  fillWarn:    80,
  fillCrit:    95,

  demoTimer:   null,
  demoTick:    0,
};

// ---------- Serial State ----------
let serialPort      = null;
let serialReader    = null;
let serialPipe      = null;
let serialBuf       = '';
let isDisconnecting = false;
let pendingPkt      = null;

// ============================================================
//  TELEMETRY PARSER
// ============================================================

/**
 * Parses the comma-separated key:value line:
 * B1,SEQ:5,GAS:127,DOUT:1,GAS_ALERT:INACTIVE,...,B2_SATS:6
 */
function parseTelemetryLine(line) {
  if (!line.startsWith('B1,')) return null;

  const obj = {};
  const parts = line.split(',');
  for (let i = 1; i < parts.length; i++) {
    const idx = parts[i].indexOf(':');
    if (idx <= 0) continue;
    const key = parts[i].slice(0, idx).trim();
    const val = parts[i].slice(idx + 1).trim();
    obj[key] = val;
  }

  if (!('SEQ' in obj)) return null;
  return obj;
}

/**
 * Applies parsed packet to state and triggers complete UI render
 */
function applyTelemetry(obj, rssi, snr, ack) {
  S.seq       = safeNum(obj.SEQ) ?? S.seq;
  S.gas       = safeNum(obj.GAS);
  S.dout      = safeNum(obj.DOUT);
  S.gasAlert  = (obj.GAS_ALERT || 'UNKNOWN').toUpperCase();
  S.tempAlert = (obj.TEMP_ALERT || 'UNKNOWN').toUpperCase();
  S.humAlert  = (obj.HUM_ALERT || 'UNKNOWN').toUpperCase();
  S.dist      = safeNum(obj.DIST);
  S.fill      = safeNum(obj.FILL);
  S.fillAlert = (obj.FILL_ALERT || 'UNKNOWN').toUpperCase();
  S.status    = (obj.STATUS || 'UNKNOWN').toUpperCase();
  S.temp      = safeNum(obj.TEMP);
  S.hum       = safeNum(obj.HUM);
  S.b1Lat     = safeNum(obj.LAT ?? obj.B1_LAT ?? obj.LATITUDE);
  S.b1Lon     = safeNum(obj.LON ?? obj.B1_LON ?? obj.LONGITUDE);
  S.b1Fix     = (obj.GPS_FIX || obj.B1_GPS_FIX || obj.B1_FIX || obj.FIX || 'NOFIX').toUpperCase();
  S.b1Sats    = safeNum(obj.SATS ?? obj.B1_SATS);
  S.alert     = (obj.ALERT || 'UNKNOWN').toUpperCase();
  S.b2Lat     = safeNum(obj.B2_LAT ?? obj.B2_LATITUDE);
  S.b2Lon     = safeNum(obj.B2_LON ?? obj.B2_LONGITUDE);
  S.b2Fix     = (obj.B2_GPS_FIX || obj.B2_FIX || 'NOFIX').toUpperCase();
  S.b2Sats    = safeNum(obj.B2_SATS);

  if (rssi !== null) S.rssi = rssi;
  if (snr  !== null) S.snr  = snr;
  if (ack  !== null) S.ackStatus = ack;

  S.lastPacketAt = Date.now();
  S.everSawB1    = true;

  // Append history
  const now = new Date();
  if (S.gas  !== null) { S.gasHistory.push({ at: now, v: S.gas });   if (S.gasHistory.length  > 30) S.gasHistory.shift(); }
  if (S.temp !== null) { S.tempHistory.push({ at: now, v: S.temp }); if (S.tempHistory.length > 30) S.tempHistory.shift(); }
  if (S.fill !== null) { S.fillHistory.push({ at: now, v: S.fill }); if (S.fillHistory.length > 30) S.fillHistory.shift(); }

  // Telemetry log record
  S.telLog.unshift({
    at: now, seq: S.seq, temp: S.temp, hum: S.hum, gas: S.gas,
    dist: S.dist, fill: S.fill, fillAlert: S.fillAlert,
    alert: S.alert, b1Fix: S.b1Fix, rssi: S.rssi
  });
  if (S.telLog.length > 50) S.telLog.length = 50;

  addConsole(`SEQ#${S.seq ?? '?'} | GAS:${S.gas ?? 'NA'} | TEMP:${S.temp ?? 'NA'}°C | HUM:${S.hum ?? 'NA'}% | FILL:${S.fill ?? 'NA'}% | ALERT:${S.alert}`, 'data');

  evaluateLocalAlerts();
  renderAll();
}

/**
 * Handles incoming serial line chunks
 */
function processLine(raw) {
  const line = raw.replace(/\u0000/g, '').trim();
  if (!line) return;

  addConsole(line, line.includes('ERROR') || line.includes('FAILED') ? 'warn' : 'data');

  // Main telemetry line
  if (line.startsWith('B1,')) {
    if (pendingPkt) commitPending();
    pendingPkt = { obj: parseTelemetryLine(line), rssi: null, snr: null, ack: null };
    if (!pendingPkt.obj) {
      pendingPkt = null;
      addConsole('Malformed telemetry string rejected.', 'warn');
    }
    return;
  }

  // RSSI line: "RSSI:-72 dBm"
  if (line.startsWith('RSSI:') && pendingPkt) {
    const m = line.match(/RSSI:\s*([-\d.]+)/);
    if (m) pendingPkt.rssi = parseFloat(m[1]);
    return;
  }

  // SNR line: "SNR:8.25 dB"
  if (line.startsWith('SNR:') && pendingPkt) {
    const m = line.match(/SNR:\s*([-\d.]+)/);
    if (m) pendingPkt.snr = parseFloat(m[1]);
    return;
  }

  // ACK line
  if (line.startsWith('ACK_TX:') && pendingPkt) {
    pendingPkt.ack = line.includes('SUCCESS') ? 'SUCCESS' : 'FAILED';
    return;
  }

  // Packet separator line "---"
  if (line.startsWith('---')) {
    if (pendingPkt) commitPending();
  }
}

function commitPending() {
  if (!pendingPkt) return;
  const { obj, rssi, snr, ack } = pendingPkt;
  pendingPkt = null;
  if (obj) applyTelemetry(obj, rssi, snr, ack);
}

// ============================================================
//  ALERTS EVALUATION
// ============================================================

function addOrUpdateAlert(id, sev, title, desc) {
  const idx = S.alertLog.findIndex(a => a.id === id);
  const entry = { id, sev, title, desc, at: new Date() };
  if (idx >= 0) {
    if (S.alertLog[idx].title === title && S.alertLog[idx].desc === desc) {
      entry.at = S.alertLog[idx].at;
    }
    S.alertLog[idx] = entry;
  } else {
    S.alertLog.unshift(entry);
    if (S.alertLog.length > 40) S.alertLog.length = 40;
    addConsole(`ALERT [${sev.toUpperCase()}]: ${title}`, sev === 'critical' ? 'err' : 'warn');
  }
}

function clearAlert(id) {
  S.alertLog = S.alertLog.filter(a => a.id !== id);
}

function evaluateLocalAlerts() {
  // Gas threshold
  if (S.gas !== null && S.gas >= S.gasThresh) {
    addOrUpdateAlert('gas-adc', 'critical', 'Gas ADC Level High', `MQ-2 sensor reads ${S.gas} ADC (threshold ${S.gasThresh}). Potential hazardous fumes.`);
  } else clearAlert('gas-adc');

  // Temperature threshold
  if (S.temp !== null && S.temp >= S.tempThresh) {
    addOrUpdateAlert('temp-high', 'warning', 'High Internal Temperature', `DHT22 temperature reads ${S.temp.toFixed(1)}°C (limit ${S.tempThresh}°C).`);
  } else clearAlert('temp-high');

  // Humidity threshold
  if (S.hum !== null && S.hum >= S.humThresh) {
    addOrUpdateAlert('hum-high', 'warning', 'High Humidity Level', `DHT22 humidity reads ${S.hum.toFixed(1)}% (limit ${S.humThresh}%).`);
  } else clearAlert('hum-high');

  // Fill Critical
  if (S.fill !== null && S.fill >= S.fillCrit) {
    addOrUpdateAlert('fill-crit', 'critical', 'Bin is 100% FULL — Dispatch Collector', `Ultrasonic fill level is ${S.fill}% (critical ${S.fillCrit}%). Immediate pickup required.`);
  } else clearAlert('fill-crit');

  // Fill Warning
  if (S.fill !== null && S.fill >= S.fillWarn && S.fill < S.fillCrit) {
    addOrUpdateAlert('fill-warn', 'warning', 'Bin Fill Level High', `Ultrasonic fill level is ${S.fill}% (warning ${S.fillWarn}%). Plan route pickup.`);
  } else clearAlert('fill-warn');

  // GPS Fix
  if (S.b1Fix !== 'FIX' && S.everSawB1) {
    addOrUpdateAlert('gps-nofix', 'info', 'B1 GPS Satellite Acquisition', 'B1 GPS reporting NOFIX. Check antenna or clear outdoor sky view.');
  } else clearAlert('gps-nofix');

  // Sensor Error
  if (S.status === 'SENSOR_ERR') {
    addOrUpdateAlert('sensor-err', 'warning', 'B1 Sensor Error', 'Firmware reporting SENSOR_ERR. Check DHT22 or HC-SR04 pin wiring.');
  } else clearAlert('sensor-err');

  // Link stale
  if (S.everSawB1 && S.lastPacketAt && Date.now() - S.lastPacketAt > 15000 && S.mode === 'live') {
    addOrUpdateAlert('link-stale', 'warning', 'B1 RF Telemetry Stale', 'No packet received via B2 gateway in over 15 seconds. Check LoRa link.');
  } else clearAlert('link-stale');
}

// ============================================================
//  UI RENDERING
// ============================================================

function renderAll() {
  renderTopStatus();
  renderAlertBanner();
  renderKPIs();
  renderNetwork();
  renderCharts();
  renderAlertLog();
  renderTelTable();
  renderGoogleMap(); // Google Map renders both B1 & B2 live
}

function renderTopStatus() {
  const live = S.mode === 'live';
  const demo = S.mode === 'demo';

  // Clock dot
  const cd = $('clockDot');
  if (cd) cd.classList.toggle('is-live', live || demo);

  // Status box
  const cs = $('connStatus');
  if (cs) {
    cs.classList.toggle('is-live', live);
    cs.classList.toggle('is-demo', demo);
  }

  const cl = $('connLabel');
  if (cl) cl.textContent = live ? 'LIVE SERIAL' : demo ? 'DEMO MODE' : 'NOT CONNECTED';

  const ch = $('connHint');
  if (ch) ch.textContent = live ? 'B2 USB gateway connected at 9600 baud.' :
    demo ? 'Simulated industrial telemetry. Not from physical hardware.' :
    'Connect the B2 Mega by USB to receive live telemetry.';

  // Sidebar elements
  const sbSeq = $('sidebarSeq');   if (sbSeq) sbSeq.textContent = S.seq !== null ? `#${S.seq}` : '—';
  const sbRssi = $('sidebarRssi'); if (sbRssi) sbRssi.textContent = S.rssi !== null ? `${S.rssi} dBm` : '— dBm';
  const sbSnr = $('sidebarSnr');   if (sbSnr) sbSnr.textContent = S.snr !== null ? `${S.snr} dB` : '— dB';
  const sbStat = $('sidebarStatus'); if (sbStat) sbStat.textContent = live ? 'Online · B2 USB' : demo ? 'Demo mode' : 'Not connected';

  const sp = $('sidebarPulse'); if (sp) sp.classList.toggle('is-live', (live || demo) && S.everSawB1);
  const sfd = $('sfDot');        if (sfd) sfd.classList.toggle('is-live', live || demo);

  // Badges
  const cnt = String(S.alertLog.length);
  const sac = $('sidebarAlertCount'); if (sac) sac.textContent = cnt;
  const aac = $('activeAlertCount');  if (aac) aac.textContent = cnt;

  // Live dot & last update text
  const ld = $('liveDot');
  if (ld) ld.classList.toggle('is-live', S.lastPacketAt !== null && Date.now() - S.lastPacketAt < 20000);

  const lut = $('lastUpdateText');
  if (lut) lut.textContent = S.lastPacketAt ? `Updated ${elapsed(S.lastPacketAt)}` : 'No telemetry received';

  // Bridge dot
  const bd = $('bridgeDot');
  if (bd) bd.classList.toggle('is-live', S.everSawB1 && S.lastPacketAt && Date.now() - S.lastPacketAt < 15000);

  // Console chip
  const cmc = $('consoleModeChip'); if (cmc) cmc.textContent = live ? 'LIVE' : demo ? 'DEMO' : 'WAITING';
  const cfs = $('consoleFootStatus'); if (cfs) cfs.textContent = live ? 'Connected to B2 USB Uplink' : demo ? 'Simulated Telemetry Feed' : 'Not connected';
  const fl = $('footLed'); if (fl) fl.classList.toggle('is-live', live || demo);
}

function alertSeverity(alertCode) {
  if (['FULL', 'GAS'].includes(alertCode)) return 'critical';
  if (['HOT', 'HUMID', 'FILL', 'SENSOR'].includes(alertCode)) return 'warning';
  if (alertCode === 'GPS') return 'info';
  return null;
}

function renderAlertBanner() {
  const banner = $('alertBanner');
  if (!banner) return;

  const a = S.alert;
  const sev = alertSeverity(a);

  if (!sev || !S.everSawB1) {
    banner.classList.add('hidden');
    return;
  }

  banner.classList.remove('hidden', 'severity-critical', 'severity-warning', 'severity-info');
  banner.classList.add(`severity-${sev}`);

  const icons = { critical: '🚨', warning: '⚠️', info: 'ℹ️' };
  const titles = {
    FULL: 'BIN CAPACITY EXCEEDED',
    GAS: 'HAZARDOUS GAS DETECTED',
    HOT: 'HIGH TEMPERATURE WARNING',
    HUMID: 'HIGH HUMIDITY DETECTED',
    FILL: 'BIN FILL LEVEL WARNING',
    SENSOR: 'HARDWARE SENSOR ERROR',
    GPS: 'GPS SATELLITE SEARCH'
  };
  const descs = {
    FULL:   `Bin fill level has reached ${S.fill ?? '?'}%. Route pickup requested immediately.`,
    GAS:    `MQ-2 gas sensor triggered. Raw ADC reading: ${S.gas ?? '?'}.`,
    HOT:    `Internal bin temperature is ${S.temp?.toFixed(1) ?? '?'}°C — exceeds industrial threshold.`,
    HUMID:  `Internal humidity is ${S.hum?.toFixed(1) ?? '?'}% — above ambient tolerance.`,
    FILL:   `Fill level at ${S.fill ?? '?'}%. Scheduled for upcoming collection cycle.`,
    SENSOR: 'Hardware diagnostics report SENSOR_ERR. Inspect DHT22 / HC-SR04.',
    GPS:    'GPS receiver has no fix. Waiting for outdoor satellite lock.',
  };

  $('alertBannerIcon').textContent  = icons[sev] || '⚠';
  $('alertBannerTitle').textContent = titles[a]  || a;
  $('alertBannerDesc').textContent  = descs[a]   || '';
  $('alertBannerTime').textContent  = S.lastPacketAt ? ts(new Date(S.lastPacketAt)) : '—';
}

function renderKPIs() {
  // --- Fill Gauge ---
  const fillNum  = S.fill;
  const fillDisp = fillNum !== null ? String(fillNum) : '—';
  const fillPct  = fillNum !== null ? Math.min(100, Math.max(0, fillNum)) : 0;

  // Arc stroke-dasharray = 157
  const offset = fillNum !== null ? Math.round(157 * (1 - fillPct / 100)) : 157;
  const gf = $('gaugeFill');
  if (gf) {
    gf.style.strokeDashoffset = String(offset);

    // Industrial Blue/Amber/Red
    let gaugeColor = '#3b82f6';
    let fillClass  = '';
    if (fillNum !== null && fillNum >= S.fillCrit)      { gaugeColor = '#ef4444'; fillClass = 'crit'; }
    else if (fillNum !== null && fillNum >= S.fillWarn) { gaugeColor = '#f59e0b'; fillClass = 'warn'; }
    gf.style.stroke = gaugeColor;

    const gv = $('fillValue');
    if (gv) {
      gv.textContent = fillDisp;
      gv.className   = `gauge-value ${fillClass}`;
    }

    setState('fillState', fillNum !== null ? `${S.dist?.toFixed(1) ?? '?'} cm distance` : 'Waiting for sensor', fillClass === 'crit' ? 'bad' : fillClass === 'warn' ? 'warn' : 'ok');
    const fa = $('fillAccent');
    if (fa) fa.style.background = gaugeColor;
  }

  // --- Temperature ---
  const tv = $('tempValue');
  if (tv) tv.textContent = S.temp !== null ? S.temp.toFixed(1) : '--.-';
  setState('tempState', S.temp !== null ? (S.temp >= S.tempThresh ? 'High Temperature!' : 'DHT22 / AM2303') : 'Sensor read error', S.temp !== null ? (S.temp >= S.tempThresh ? 'bad' : 'ok') : 'warn');

  // --- Humidity ---
  const hv = $('humValue');
  if (hv) hv.textContent = S.hum !== null ? S.hum.toFixed(1) : '--.-';
  setState('humState', S.hum !== null ? (S.hum >= S.humThresh ? 'Above Threshold!' : 'Relative humidity') : 'Sensor read error', S.hum !== null ? (S.hum >= S.humThresh ? 'bad' : 'ok') : 'warn');

  // --- Gas Sensor ---
  const gv = $('gasValue');
  if (gv) gv.textContent = S.gas !== null ? String(S.gas) : '---';
  setState('gasState', S.gas !== null ? (S.gas >= S.gasThresh ? 'Gas Active!' : 'MQ-2 Raw 0–1023') : 'Waiting for sensor', S.gas !== null ? (S.gas >= S.gasThresh ? 'bad' : 'ok') : 'muted');

  const doutEl = $('doutPill');
  if (doutEl) {
    if (S.dout !== null) {
      const active = S.dout === 0; // Active low
      doutEl.textContent = active ? 'DOUT: ACTIVE' : 'DOUT: NORMAL';
      doutEl.className   = `dout-pill${active ? ' active' : ''}`;
    } else {
      doutEl.textContent = 'DOUT —';
      doutEl.className   = 'dout-pill';
    }
  }

  // --- Distance ---
  const dv = $('distValue');
  if (dv) dv.textContent = S.dist !== null ? S.dist.toFixed(1) : '--.-';
  setState('distState', S.dist !== null ? 'HC-SR04 Ultrasonic' : 'Out of range', S.dist !== null ? 'ok' : 'warn');

  // --- RF Link ---
  const rv = $('rssiValue');
  if (rv) rv.textContent = S.rssi !== null ? String(S.rssi) : '—';
  const sv = $('snrValue');
  if (sv) sv.textContent = S.snr !== null ? S.snr.toFixed(2) : '—';

  let rssiState = 'No RF signal';
  if (S.rssi !== null) rssiState = S.rssi > -90 ? 'Strong Link' : S.rssi > -110 ? 'Fair Signal' : 'Weak Signal';
  setState('rssiState', rssiState, S.rssi !== null ? (S.rssi > -90 ? 'ok' : S.rssi > -110 ? 'warn' : 'bad') : 'muted');
}

function setState(id, text, cls = 'muted') {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className   = `kpi-state ${cls}`;
}

function renderNetwork() {
  const fresh = S.lastPacketAt && Date.now() - S.lastPacketAt < 20000;
  const b2Live = S.mode === 'live' || S.mode === 'demo';

  setBadge('b1Badge', Boolean(fresh));
  setBadge('b2Badge', b2Live);

  const nll = $('netLinkLine');
  if (nll) nll.classList.toggle('is-live', Boolean(fresh));

  const mc = $('netModeChip');
  if (mc) {
    mc.textContent = S.mode === 'demo' ? 'DEMO DATA' : (S.everSawB1 ? 'ACTIVE LINK' : 'STANDBY');
    mc.classList.toggle('is-live', S.everSawB1);
  }

  const b1ns = $('b1NodeState'); if (b1ns) b1ns.textContent = fresh ? `Last packet ${elapsed(S.lastPacketAt)}` : S.lastPacketAt ? 'Telemetry stale' : 'Waiting for packet';
  const b2ns = $('b2NodeState'); if (b2ns) b2ns.textContent = b2Live ? 'Uplink active · RX 9600' : 'USB not connected';
  const lpa = $('lastPktAge');   if (lpa) lpa.textContent = S.lastPacketAt ? elapsed(S.lastPacketAt) : 'No packets';

  const ackEl = $('ackStatus');
  if (ackEl) {
    ackEl.textContent = S.ackStatus ?? '—';
    ackEl.style.color = S.ackStatus === 'SUCCESS' ? 'var(--blue-bright)' : S.ackStatus === 'FAILED' ? 'var(--red)' : 'var(--muted)';
  }
  const ackSeq = $('ackSeq'); if (ackSeq) ackSeq.textContent = S.seq !== null ? `ACK for SEQ#${S.seq}` : 'No ACK yet';

  const b1s = $('b1Status');    if (b1s) b1s.textContent = S.status || 'WAITING';
  const b1ss = $('b1StatusSub'); if (b1ss) b1ss.textContent = S.everSawB1 ? (S.status === 'ONLINE' ? 'All sensors nominal' : 'Sensor fault detected') : 'No packet received';

  const faEl = $('fillAlertNet');
  if (faEl) {
    faEl.textContent = S.fillAlert || 'UNKNOWN';
    faEl.style.color = S.fillAlert === 'CRITICAL' ? 'var(--red)' : S.fillAlert === 'WARNING' ? 'var(--amber)' : S.fillAlert === 'NORMAL' ? 'var(--blue-bright)' : 'var(--muted)';
  }
  const fas = $('fillAlertSub'); if (fas) fas.textContent = S.fill !== null ? `Fill level: ${S.fill}%` : '—';

  const gaEl = $('gasAlertNet');
  if (gaEl) {
    gaEl.textContent = S.gasAlert || 'UNKNOWN';
    gaEl.style.color = S.gasAlert === 'ACTIVE' ? 'var(--red)' : S.gasAlert === 'INACTIVE' ? 'var(--blue-bright)' : 'var(--muted)';
  }
  const gas = $('gasAlertSub'); if (gas) gas.textContent = S.gas !== null ? `Raw ADC: ${S.gas}` : '—';
}

function setBadge(id, online) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle('is-online', online);
  el.lastElementChild.textContent = online ? 'ONLINE' : 'OFFLINE';
}

// ============================================================
//  OFFICIAL GOOGLE MAPS PLATFORM ENGINE (Dual Node B1 + B2)
//  Source: Google Maps Platform Code Assist
// ============================================================

let _gMap           = null; // Official google.maps.Map instance
let _markerB1       = null; // google.maps.Marker for B1 Sensor Node
let _markerB2       = null; // google.maps.Marker for B2 Gateway Node
let _infoWindowB1   = null; // InfoWindow for B1
let _infoWindowB2   = null; // InfoWindow for B2
let _linkLine       = null; // Dashed google.maps.Polyline connecting B1 & B2
let _gmapsLoaded    = false;
let _gmapsLoading   = false;

/** Industrial Dark Map Theme for Google Maps */
const INDUSTRIAL_DARK_MAP_STYLES = [
  { elementType: "geometry", stylers: [{ color: "#0c1424" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#070b12" }, { weight: 2 }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#94a3b8" }] },
  {
    featureType: "administrative",
    elementType: "geometry",
    stylers: [{ visibility: "off" }]
  },
  {
    featureType: "administrative.locality",
    elementType: "labels.text.fill",
    stylers: [{ color: "#cbd5e1" }]
  },
  {
    featureType: "poi",
    elementType: "labels.text.fill",
    stylers: [{ color: "#64748b" }]
  },
  {
    featureType: "poi.park",
    elementType: "geometry",
    stylers: [{ color: "#111c30" }]
  },
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#1e293b" }]
  },
  {
    featureType: "road",
    elementType: "geometry.stroke",
    stylers: [{ color: "#0f172a" }]
  },
  {
    featureType: "road",
    elementType: "labels.text.fill",
    stylers: [{ color: "#94a3b8" }]
  },
  {
    featureType: "road.highway",
    elementType: "geometry",
    stylers: [{ color: "#1d4ed8" }, { lightness: -20 }]
  },
  {
    featureType: "road.highway",
    elementType: "geometry.stroke",
    stylers: [{ color: "#1e3a8a" }]
  },
  {
    featureType: "road.highway",
    elementType: "labels.text.fill",
    stylers: [{ color: "#bfdbfe" }]
  },
  {
    featureType: "transit",
    elementType: "geometry",
    stylers: [{ color: "#1e293b" }]
  },
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#060a14" }]
  },
  {
    featureType: "water",
    elementType: "labels.text.fill",
    stylers: [{ color: "#38bdf8" }]
  }
];

/** Creates an official Google Maps Marker icon from inline SVG */
function makeGoogleMarkerIcon(label, primaryColor, ringColor) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="46" viewBox="0 0 40 46">
    <defs>
      <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="2.5" stdDeviation="2.5" flood-color="#000000" flood-opacity="0.8"/>
      </filter>
    </defs>
    <!-- Pin Body -->
    <path d="M20 2 C11.5 2, 5 8.5, 5 17 C5 26, 20 44, 20 44 C20 44, 35 26, 35 17 C35 8.5, 28.5 2, 20 2 Z"
          fill="${primaryColor}" stroke="#ffffff" stroke-width="2" filter="url(#sh)"/>
    <!-- Core Center Disc -->
    <circle cx="20" cy="17" r="10" fill="#0b111e" stroke="${ringColor}" stroke-width="2"/>
    <!-- Node Label -->
    <text x="20" y="21" text-anchor="middle" font-size="10" font-weight="800"
          font-family="system-ui, -apple-system, 'DM Mono', monospace" fill="#ffffff">${label}</text>
  </svg>`;

  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(40, 46),
    anchor: new google.maps.Point(20, 44),
  };
}

/** Formatted HTML for B1 InfoWindow */
function getB1InfoWindowHtml() {
  return `
    <div style="font-family:'DM Mono',monospace;color:#ffffff;background:#0b111e;padding:12px;border-radius:8px;min-width:210px;border:1px solid #1e293b;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;border-bottom:1px solid #1e293b;padding-bottom:6px;">
        <span style="background:#2563eb;color:#ffffff;font-size:11px;font-weight:800;padding:2px 8px;border-radius:4px;">B1</span>
        <strong style="font-size:12px;color:#ffffff;font-family:'Manrope',sans-serif;">Sensor Node (Bin Site)</strong>
      </div>
      <div style="font-size:11px;line-height:1.7;color:#cbd5e1;">
        LAT: <b style="color:#ffffff;">${S.b1Lat !== null ? S.b1Lat.toFixed(6) : '—'}</b><br>
        LON: <b style="color:#ffffff;">${S.b1Lon !== null ? S.b1Lon.toFixed(6) : '—'}</b><br>
        SATS: <b style="color:#60a5fa;">${S.b1Sats ?? 0}</b> · FIX: <b style="color:#60a5fa;">${S.b1Fix}</b><br>
        TEMP: <b>${S.temp !== null ? S.temp.toFixed(1) + ' °C' : '—'}</b> | HUM: <b>${S.hum !== null ? S.hum.toFixed(1) + ' %' : '—'}</b><br>
        FILL: <b style="color:#38bdf8;">${S.fill !== null ? S.fill + ' %' : '—'}</b> | GAS: <b>${S.gas ?? '—'} ADC</b>
      </div>
    </div>`;
}

/** Formatted HTML for B2 InfoWindow */
function getB2InfoWindowHtml() {
  return `
    <div style="font-family:'DM Mono',monospace;color:#ffffff;background:#0b111e;padding:12px;border-radius:8px;min-width:210px;border:1px solid #1e293b;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;border-bottom:1px solid #1e293b;padding-bottom:6px;">
        <span style="background:#0891b2;color:#ffffff;font-size:11px;font-weight:800;padding:2px 8px;border-radius:4px;">B2</span>
        <strong style="font-size:12px;color:#ffffff;font-family:'Manrope',sans-serif;">Gateway Node (Uplink Site)</strong>
      </div>
      <div style="font-size:11px;line-height:1.7;color:#cbd5e1;">
        LAT: <b style="color:#ffffff;">${S.b2Lat !== null ? S.b2Lat.toFixed(6) : '—'}</b><br>
        LON: <b style="color:#ffffff;">${S.b2Lon !== null ? S.b2Lon.toFixed(6) : '—'}</b><br>
        SATS: <b style="color:#22d3ee;">${S.b2Sats ?? 0}</b> · FIX: <b style="color:#22d3ee;">${S.b2Fix}</b><br>
        RSSI: <b style="color:#38bdf8;">${S.rssi !== null ? S.rssi + ' dBm' : '—'}</b><br>
        SNR: <b style="color:#38bdf8;">${S.snr !== null ? S.snr + ' dB' : '—'}</b>
      </div>
    </div>`;
}

/** Loads the official Google Maps JavaScript API SDK dynamically */
function loadGoogleMapsSDK(callback) {
  if (window.google && window.google.maps) {
    _gmapsLoaded = true;
    if (callback) callback();
    return;
  }
  if (_gmapsLoading) {
    const checkInterval = setInterval(() => {
      if (window.google && window.google.maps) {
        clearInterval(checkInterval);
        _gmapsLoaded = true;
        if (callback) callback();
      }
    }, 100);
    return;
  }
  _gmapsLoading = true;

  const savedKey = localStorage.getItem('gmaps_api_key') || '';
  const keyParam = savedKey ? `&key=${encodeURIComponent(savedKey)}` : '';
  const script = document.createElement('script');
  script.id = 'google-maps-js-sdk';
  script.src = `https://maps.googleapis.com/maps/api/js?v=weekly&libraries=geometry${keyParam}&callback=__onGoogleMapsApiLoaded`;
  script.async = true;
  script.defer = true;

  window.__onGoogleMapsApiLoaded = function() {
    _gmapsLoaded = true;
    _gmapsLoading = false;
    delete window.__onGoogleMapsApiLoaded;
    initGoogleMap();
    renderGoogleMap();
    if (callback) callback();
  };

  script.onerror = function() {
    _gmapsLoading = false;
    console.error('Failed to load Google Maps JavaScript API SDK.');
    const ph = $('mapPlaceholder');
    if (ph) {
      ph.classList.remove('hidden');
      ph.innerHTML = `
        <span class="map-ph-icon" style="color:#ef4444;">⚠</span>
        <strong>Google Maps Connection Offline</strong>
        <small>Could not connect to Google Maps servers. Check network connection or configure an API key.</small>
      `;
    }
  };

  document.head.appendChild(script);
}

/** Configures or updates the Google Maps API Key via UI prompt */
function configureGoogleMapsApiKey() {
  const currentKey = localStorage.getItem('gmaps_api_key') || '';
  const promptMsg = currentKey 
    ? `Current Google Maps API Key: ${currentKey.slice(0, 8)}...${currentKey.slice(-4)}\n\nEnter a new Google Maps API Key, or leave blank to reset:`
    : `Enter your Google Maps API Key or Demo Key:\n(Leave blank to load in standard development mode)`;

  const entered = window.prompt(promptMsg, currentKey);
  if (entered === null) return;

  const trimmed = entered.trim();
  if (trimmed) {
    localStorage.setItem('gmaps_api_key', trimmed);
    toast('API Key Saved', 'Reloading Google Maps with your key...');
  } else {
    localStorage.removeItem('gmaps_api_key');
    toast('API Key Cleared', 'Resetting Google Maps to development mode.');
  }

  setTimeout(() => {
    window.location.reload();
  }, 500);
}

/** Initializes the Google Maps instance inside the fixed container */
function initGoogleMap() {
  if (_gMap || !window.google || !window.google.maps) return;
  const container = $('googleMap');
  if (!container) return;

  const defaultCenter = { lat: 12.852101, lng: 80.226501 };

  _gMap = new google.maps.Map(container, {
    center: defaultCenter,
    zoom: 16,
    mapTypeId: google.maps.MapTypeId.ROADMAP,
    styles: INDUSTRIAL_DARK_MAP_STYLES,
    mapTypeControl: true,
    mapTypeControlOptions: {
      style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
      position: google.maps.ControlPosition.TOP_RIGHT
    },
    zoomControl: true,
    zoomControlOptions: {
      position: google.maps.ControlPosition.RIGHT_CENTER
    },
    streetViewControl: true,
    streetViewControlOptions: {
      position: google.maps.ControlPosition.RIGHT_BOTTOM
    },
    fullscreenControl: true,
    fullscreenControlOptions: {
      position: google.maps.ControlPosition.TOP_RIGHT
    },
    backgroundColor: '#0c1424'
  });

  _infoWindowB1 = new google.maps.InfoWindow();
  _infoWindowB2 = new google.maps.InfoWindow();
}

/** Renders live dual-node pins (B1 + B2) and RF line on the Google Map */
function renderGoogleMap() {
  const b1Fixed = S.b1Fix === 'FIX' && S.b1Lat !== null && S.b1Lon !== null;
  const b2Fixed = S.b2Fix === 'FIX' && S.b2Lat !== null && S.b2Lon !== null;
  const anyFixed = b1Fixed || b2Fixed;

  // Toggle placeholder
  const ph = $('mapPlaceholder');
  if (ph) ph.classList.toggle('hidden', anyFixed);

  // Status Chip
  const fixChip = $('mapFixChip');
  if (fixChip) {
    if (b1Fixed && b2Fixed) {
      fixChip.textContent = 'B1 + B2 FIXED';
      fixChip.className   = 'map-fix-chip is-fixed';
    } else if (b1Fixed) {
      fixChip.textContent = 'B1 FIXED';
      fixChip.className   = 'map-fix-chip is-fixed';
    } else if (b2Fixed) {
      fixChip.textContent = 'B2 FIXED';
      fixChip.className   = 'map-fix-chip is-fixed';
    } else {
      fixChip.textContent = 'GPS NOT FIXED';
      fixChip.className   = 'map-fix-chip';
    }
  }

  // Update coordinate overlay numbers
  const mB1Lat = $('mapB1Lat'); if (mB1Lat) mB1Lat.textContent = b1Fixed ? S.b1Lat.toFixed(6) : '—';
  const mB1Lon = $('mapB1Lon'); if (mB1Lon) mB1Lon.textContent = b1Fixed ? S.b1Lon.toFixed(6) : '—';
  const mB2Lat = $('mapB2Lat'); if (mB2Lat) mB2Lat.textContent = b2Fixed ? S.b2Lat.toFixed(6) : '—';
  const mB2Lon = $('mapB2Lon'); if (mB2Lon) mB2Lon.textContent = b2Fixed ? S.b2Lon.toFixed(6) : '—';

  const mB1Sats = $('mapB1Sats'); if (mB1Sats) mB1Sats.textContent = S.b1Sats !== null ? String(S.b1Sats) : '0';
  const mB2Sats = $('mapB2Sats'); if (mB2Sats) mB2Sats.textContent = S.b2Sats !== null ? String(S.b2Sats) : '0';

  // Google Maps Deep Link
  const oml = $('openMapLink');
  if (oml) {
    if (b1Fixed && b2Fixed) {
      oml.href = `https://www.google.com/maps/dir/?api=1&origin=${S.b1Lat},${S.b1Lon}&destination=${S.b2Lat},${S.b2Lon}&travelmode=walking`;
    } else if (b1Fixed) {
      oml.href = `https://maps.google.com/?q=${S.b1Lat},${S.b1Lon}`;
    } else if (b2Fixed) {
      oml.href = `https://maps.google.com/?q=${S.b2Lat},${S.b2Lon}`;
    } else {
      oml.href = 'https://maps.google.com/';
    }
  }

  // Ensure Google Maps SDK is loaded
  if (!_gmapsLoaded) {
    loadGoogleMapsSDK();
    return;
  }

  // Ensure map instance is initialized
  if (!_gMap) {
    initGoogleMap();
    if (!_gMap) return;
  }

  const iconB1 = makeGoogleMarkerIcon('B1', '#2563eb', '#60a5fa'); // Industrial Blue
  const iconB2 = makeGoogleMarkerIcon('B2', '#06b6d4', '#22d3ee'); // Electric Cyan

  // --- B1 Marker (Sensor Node) ---
  if (b1Fixed) {
    const pos = { lat: S.b1Lat, lng: S.b1Lon };
    if (!_markerB1) {
      _markerB1 = new google.maps.Marker({
        position: pos,
        map: _gMap,
        title: 'B1 Sensor Node (Waste Bin)',
        icon: iconB1,
        animation: google.maps.Animation.DROP
      });
      _markerB1.addListener('click', () => {
        if (_infoWindowB1) {
          _infoWindowB1.setContent(getB1InfoWindowHtml());
          _infoWindowB1.open(_gMap, _markerB1);
        }
      });
    } else {
      _markerB1.setPosition(pos);
      _markerB1.setIcon(iconB1);
      _markerB1.setMap(_gMap);
      if (_infoWindowB1 && _infoWindowB1.getMap()) {
        _infoWindowB1.setContent(getB1InfoWindowHtml());
      }
    }
  } else if (_markerB1) {
    _markerB1.setMap(null);
    _markerB1 = null;
  }

  // --- B2 Marker (Gateway Node) ---
  if (b2Fixed) {
    const pos = { lat: S.b2Lat, lng: S.b2Lon };
    if (!_markerB2) {
      _markerB2 = new google.maps.Marker({
        position: pos,
        map: _gMap,
        title: 'B2 Gateway Node (Uplink Station)',
        icon: iconB2,
        animation: google.maps.Animation.DROP
      });
      _markerB2.addListener('click', () => {
        if (_infoWindowB2) {
          _infoWindowB2.setContent(getB2InfoWindowHtml());
          _infoWindowB2.open(_gMap, _markerB2);
        }
      });
    } else {
      _markerB2.setPosition(pos);
      _markerB2.setIcon(iconB2);
      _markerB2.setMap(_gMap);
      if (_infoWindowB2 && _infoWindowB2.getMap()) {
        _infoWindowB2.setContent(getB2InfoWindowHtml());
      }
    }
  } else if (_markerB2) {
    _markerB2.setMap(null);
    _markerB2 = null;
  }

  // --- Connecting RF Link Polyline (when both fixed) ---
  if (b1Fixed && b2Fixed) {
    const pts = [
      { lat: S.b1Lat, lng: S.b1Lon },
      { lat: S.b2Lat, lng: S.b2Lon }
    ];
    const distMeters = calcDistanceMeters(S.b1Lat, S.b1Lon, S.b2Lat, S.b2Lon);
    const distText = distMeters >= 1000 ? `${(distMeters / 1000).toFixed(2)} km` : `${distMeters} m`;

    const lineSymbol = {
      path: 'M 0,-1 0,1',
      strokeOpacity: 1,
      strokeWeight: 2,
      scale: 3
    };

    if (!_linkLine) {
      _linkLine = new google.maps.Polyline({
        path: pts,
        strokeColor: '#3b82f6',
        strokeOpacity: 0,
        icons: [{
          icon: lineSymbol,
          offset: '0',
          repeat: '14px'
        }],
        map: _gMap
      });
    } else {
      _linkLine.setPath(pts);
      _linkLine.setMap(_gMap);
    }
  } else if (_linkLine) {
    _linkLine.setMap(null);
    _linkLine = null;
  }

  // --- Auto-fit Map Bounds to Show Both Nodes on Single Map ---
  if (b1Fixed && b2Fixed) {
    const bounds = new google.maps.LatLngBounds();
    bounds.extend(new google.maps.LatLng(S.b1Lat, S.b1Lon));
    bounds.extend(new google.maps.LatLng(S.b2Lat, S.b2Lon));
    _gMap.fitBounds(bounds, { top: 45, right: 45, bottom: 45, left: 45 });
  } else if (b1Fixed) {
    _gMap.panTo(new google.maps.LatLng(S.b1Lat, S.b1Lon));
  } else if (b2Fixed) {
    _gMap.panTo(new google.maps.LatLng(S.b2Lat, S.b2Lon));
  }
}

// ============================================================
//  SVG HISTORICAL CHARTS (Industrial Black & Blue Theme)
// ============================================================

function renderSVGChart(svgId, history, color, threshold, threshColor, unit) {
  const svg = $(svgId);
  if (!svg) return;
  const samples = history.slice(-30);

  if (!samples.length) {
    svg.innerHTML = `<text x="320" y="82" text-anchor="middle" fill="#64748b" font-family="'Inter', sans-serif" font-size="12">Waiting for ${unit} telemetry…</text>`;
    return;
  }

  const W = 640, H = 160, LEFT = 38, RIGHT = 12, TOP = 10, BOT = 26;
  const cW = W - LEFT - RIGHT, cH = H - TOP - BOT;
  const vals = samples.map(d => d.v);
  let mn = Math.min(...vals), mx = Math.max(...vals);
  if (threshold !== null) { mn = Math.min(mn, threshold); mx = Math.max(mx, threshold); }
  const pad = Math.max(3, (mx - mn) * 0.18);
  mn = mn - pad; mx = mx + pad;
  if (mx - mn < 5) mx = mn + 5;

  const xp = i => LEFT + (samples.length === 1 ? cW / 2 : (i / (samples.length - 1)) * cW);
  const yp = v => TOP + ((mx - v) / (mx - mn)) * cH;

  // Grid lines
  let grid = '';
  for (let i = 0; i <= 3; i++) {
    const yy = TOP + (i / 3) * cH;
    const lbl = (mx - (i / 3) * (mx - mn)).toFixed(unit === '°C' || unit === '%' ? 1 : 0);
    grid += `<line x1="${LEFT}" y1="${yy}" x2="${W - RIGHT}" y2="${yy}" stroke="#1e293b" stroke-dasharray="3 4"/>`;
    grid += `<text x="${LEFT - 6}" y="${yy + 3.5}" text-anchor="end" font-size="8" fill="#64748b" font-family="'JetBrains Mono', monospace">${lbl}</text>`;
  }

  // Threshold line
  let threshLine = '';
  if (threshold !== null) {
    const ty = yp(threshold);
    threshLine = `<line x1="${LEFT}" y1="${ty}" x2="${W - RIGHT}" y2="${ty}" stroke="${threshColor}" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.85"/>`;
    threshLine += `<text x="${W - RIGHT + 2}" y="${ty + 3}" font-size="8" fill="${threshColor}" font-family="'JetBrains Mono', monospace" opacity="0.9">THR</text>`;
  }

  // Shaded area + polyline
  const pts  = samples.map((d, i) => `${xp(i).toFixed(1)},${yp(d.v).toFixed(1)}`).join(' ');
  const area = `${xp(0).toFixed(1)},${(TOP + cH).toFixed(1)} ${pts} ${xp(samples.length - 1).toFixed(1)},${(TOP + cH).toFixed(1)}`;

  const gradId = `grad_${svgId}`;
  const defs = `<defs><linearGradient id="${gradId}" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="0.35"/><stop offset="100%" stop-color="${color}" stop-opacity="0.02"/></linearGradient></defs>`;

  // Dots
  const dots = samples.map((d, i) =>
    `<circle cx="${xp(i).toFixed(1)}" cy="${yp(d.v).toFixed(1)}" r="2.8" fill="${color}" stroke="#070b12" stroke-width="1.5"><title>${d.v}${unit} · ${ts(d.at)}</title></circle>`
  ).join('');

  // Time labels
  const t0 = ts(samples[0].at);
  const t1 = ts(samples[samples.length - 1].at);
  const timeLabels =
    `<text x="${LEFT}" y="${H - 5}" font-size="8" fill="#64748b" font-family="'JetBrains Mono', monospace">${t0}</text>` +
    (samples.length > 1 ? `<text x="${W - RIGHT}" y="${H - 5}" text-anchor="end" font-size="8" fill="#64748b" font-family="'JetBrains Mono', monospace">${t1}</text>` : '');

  svg.innerHTML = `${defs}${grid}${threshLine}<polygon points="${area}" fill="url(#${gradId})"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}${timeLabels}`;
}

function renderCharts() {
  renderSVGChart('gasChart',  S.gasHistory,  '#818cf8', S.gasThresh,  '#ef4444', '');
  renderSVGChart('tempChart', S.tempHistory, '#f59e0b', S.tempThresh, '#ef4444', '°C');
  renderSVGChart('fillChart', S.fillHistory, '#3b82f6', S.fillWarn,   '#f59e0b', '%');

  const gcl = $('gasChartLatest');  if (gcl) gcl.textContent = S.gas !== null ? String(S.gas) : '—';
  const tcl = $('tempChartLatest'); if (tcl) tcl.textContent = S.temp !== null ? S.temp.toFixed(1) + ' °C' : '—';
  const fcl = $('fillChartLatest'); if (fcl) fcl.textContent = S.fill !== null ? S.fill + ' %' : '—';

  const gsc = $('gasSampleCount');  if (gsc) gsc.textContent = `${S.gasHistory.length} samples`;
  const tsc = $('tempSampleCount'); if (tsc) tsc.textContent = `${S.tempHistory.length} samples`;
  const fsc = $('fillSampleCount'); if (fsc) fsc.textContent = `${S.fillHistory.length} samples`;

  const gtl = $('gasThreshLegend');  if (gtl) gtl.textContent = `Threshold: ${S.gasThresh}`;
  const ttl = $('tempThreshLegend'); if (ttl) ttl.textContent = `Threshold: ${S.tempThresh}°C`;
}

function renderAlertLog() {
  const list = $('alertsList');
  if (!list) return;

  const countPill = $('alertPillCount');
  if (countPill) countPill.textContent = `${S.alertLog.length} ENTR${S.alertLog.length === 1 ? 'Y' : 'IES'}`;

  if (!S.alertLog.length) {
    list.innerHTML = `<div class="empty-state"><span class="empty-icon">✓</span><strong>No active alerts</strong><small>${S.everSawB1 ? 'Current telemetry within configured operational rules.' : 'Connect B2 gateway or try demo mode.'}</small></div>`;
    return;
  }

  list.replaceChildren();
  S.alertLog.forEach(a => {
    const item = document.createElement('div'); item.className = 'alert-item';
    const mark = document.createElement('span'); mark.className = `alert-mark ${a.sev}`;
    mark.textContent = a.sev === 'critical' ? '!' : a.sev === 'info' ? 'ℹ' : '△';
    const copy = document.createElement('div'); copy.className = 'alert-copy';
    const strong = document.createElement('strong'); strong.textContent = a.title;
    const small  = document.createElement('small');  small.textContent  = a.desc;
    copy.append(strong, small);
    const time = document.createElement('span'); time.className = 'alert-time'; time.textContent = ts(a.at);
    item.append(mark, copy, time);
    list.append(item);
  });
}

function renderTelTable() {
  const body = $('telTableBody');
  if (!body) return;

  const tc = $('telemetryCount');
  if (tc) tc.textContent = `${S.telLog.length} RECORD${S.telLog.length === 1 ? '' : 'S'}`;

  if (!S.telLog.length) {
    body.innerHTML = `<tr class="table-empty"><td colspan="11">No telemetry records yet.</td></tr>`;
    return;
  }

  body.replaceChildren();
  S.telLog.slice(0, 12).forEach(r => {
    const tr = document.createElement('tr');
    const fv = p => p !== null && p !== undefined ? String(p) : '—';
    const fvf = (p, d) => p !== null && p !== undefined ? p.toFixed(d) : '—';

    const fillPct = r.fill !== null ? Math.min(100, Math.max(0, r.fill)) : null;
    const fillCls = fillPct !== null ? (fillPct >= S.fillCrit ? 'crit' : fillPct >= S.fillWarn ? 'warn' : '') : '';
    const alertCls = r.alert || 'UNKNOWN';

    tr.innerHTML = `
      <td>${fv(r.seq)}</td>
      <td>${fvf(r.temp, 1)}${r.temp !== null ? ' °C' : ''}</td>
      <td>${fvf(r.hum, 1)}${r.hum !== null ? ' %' : ''}</td>
      <td>${fv(r.gas)}</td>
      <td>${fvf(r.dist, 1)}${r.dist !== null ? ' cm' : ''}</td>
      <td class="fill-bar-cell">
        ${fillPct !== null ? `<span class="fill-bar"><span class="fill-bar-inner ${fillCls}" style="width:${fillPct}%"></span></span>` : ''}
        ${fv(r.fill)}${r.fill !== null ? ' %' : ''}
      </td>
      <td><span class="alert-chip ${r.fillAlert || 'UNKNOWN'}">${r.fillAlert || 'UNKNOWN'}</span></td>
      <td><span class="alert-chip ${alertCls}">${alertCls}</span></td>
      <td><span class="gps-pill ${r.b1Fix === 'FIX' ? 'fixed' : ''}">${r.b1Fix === 'FIX' ? '● FIX' : '○ NOFIX'}</span></td>
      <td>${r.rssi !== null ? r.rssi + ' dBm' : '—'}</td>
      <td>${ts(r.at)}</td>`;
    body.append(tr);
  });
}

// ============================================================
//  CONSOLE
// ============================================================

function addConsole(msg, level = 'data') {
  S.consoleLines.push({ time: ts(), msg: String(msg), level });
  if (S.consoleLines.length > 150) S.consoleLines.shift();
  renderConsole();
}

function renderConsole() {
  const out = $('consoleOutput');
  if (!out) return;
  out.replaceChildren();
  S.consoleLines.forEach(item => {
    const row = document.createElement('div'); row.className = 'c-line';
    const t = document.createElement('span'); t.className = 'c-time'; t.textContent = item.time;
    const l = document.createElement('span');
    l.className = item.level === 'err' ? 'c-err' : item.level === 'warn' ? 'c-warn' : item.level === 'sys' ? 'c-sys' : 'c-data';
    l.textContent = item.level === 'err' ? '[ERR]' : item.level === 'warn' ? '[WARN]' : item.level === 'sys' ? '[SYS]' : '[DATA]';
    const m = document.createElement('span'); m.textContent = item.msg;
    row.append(t, l, m);
    out.append(row);
  });
  out.scrollTop = out.scrollHeight;
  const clc = $('consoleLineCount'); if (clc) clc.textContent = `${S.consoleLines.length} lines`;
}

// ============================================================
//  SERIAL (Web Serial API)
// ============================================================

async function connectSerial() {
  if (S.mode === 'demo') stopDemo(false);
  if (!('serial' in navigator)) {
    toast('Web Serial Unavailable', 'Use Chrome or Edge. Open via VS Code Live Server or http://localhost.', 'error');
    addConsole('Web Serial API not available in this browser/context.', 'err');
    return;
  }

  try {
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({ baudRate: 9600 });
    serialBuf = '';
    pendingPkt = null;

    const decoder = new TextDecoderStream();
    serialPipe = serialPort.readable.pipeTo(decoder.writable).catch(e => {
      if (!isDisconnecting) addConsole(`Serial pipe ended: ${e.message}`, 'warn');
    });
    serialReader = decoder.readable.getReader();

    setMode('live');
    addConsole('B2 USB Serial connected at 9600 baud.', 'sys');
    addConsole('Close Arduino IDE Serial Monitor if open (only one process can bind a COM port).', 'sys');
    toast('B2 Gateway Connected', 'Streaming real-time telemetry from B2 USB port.');

    try {
      while (true) {
        const { done, value } = await serialReader.read();
        if (done) break;
        if (value) parseChunk(value);
      }
    } catch (e) {
      if (!isDisconnecting) {
        addConsole(`Serial read error: ${e.message}`, 'err');
        toast('Serial Read Error', 'Check USB cable connection.', 'error');
      }
    }
  } catch (e) {
    if (e && e.name !== 'NotFoundError') {
      addConsole(`Could not open serial port: ${e.message}`, 'err');
      toast('Connection Failed', e.message || 'Could not open COM port.', 'error');
    }
    await cleanupSerial(false);
    if (S.mode !== 'demo') setMode('disconnected');
  }
}

function parseChunk(chunk) {
  serialBuf += chunk;
  if (serialBuf.length > 16000) serialBuf = serialBuf.slice(-4000);
  let nl;
  while ((nl = serialBuf.indexOf('\n')) !== -1) {
    const line = serialBuf.slice(0, nl);
    serialBuf = serialBuf.slice(nl + 1);
    processLine(line);
  }
}

async function cleanupSerial(showMsg = true) {
  isDisconnecting = true;
  try { if (serialReader) await serialReader.cancel(); } catch (_) {}
  try { if (serialReader) serialReader.releaseLock(); } catch (_) {}
  serialReader = null;
  if (serialPipe) { try { await serialPipe; } catch (_) {} }
  serialPipe = null;
  if (serialPort) { try { await serialPort.close(); } catch (_) {} }
  serialPort = null;
  isDisconnecting = false;
  if (showMsg) {
    addConsole('B2 USB Serial disconnected.', 'sys');
    toast('Disconnected', 'Live stream paused. Telemetry history preserved.');
  }
}

async function disconnectSerial() {
  await cleanupSerial(true);
  setMode('disconnected');
}

// ============================================================
//  MODE SWITCHING & SIMULATION (DEMO MODE)
// ============================================================

function setMode(mode) {
  S.mode = mode;
  const live = mode === 'live', demo = mode === 'demo';
  const connBtn = $('connectBtn');    if (connBtn) connBtn.classList.toggle('hidden', live);
  const discBtn = $('disconnectBtn'); if (discBtn) discBtn.classList.toggle('hidden', !live);
  const demoBtn = $('demoBtn');       if (demoBtn) demoBtn.textContent = demo ? 'Stop demo' : 'Try demo';
  renderAll();
}

function startDemo() {
  stopDemo(false);
  if (serialPort) cleanupSerial(false);

  S.demoTick = 0;
  S.gasHistory  = [];
  S.tempHistory = [];
  S.fillHistory = [];
  S.alertLog    = [];
  S.telLog      = [];
  S.lastPacketAt = null;
  S.everSawB1   = false;

  setMode('demo');
  addConsole('DEMO MODE started. Simulating dual-node IoT waste collection telemetry.', 'sys');
  toast('Demo Mode Started', 'Displaying live simulated data on Google Map & KPIs.');

  const tick = () => {
    const n = ++S.demoTick;

    // Fill level rises smoothly 20% -> 96% and resets
    const fill = Math.round(25 + ((n * 4) % 75));
    const dist = Math.round(120 * (1 - fill / 100) * 10) / 10; // 120 cm bin

    // Gas sensor (ambient around 110-160, occasional spike to 580 on n%14==0)
    const gas  = n % 14 === 0 ? 590 : Math.round(120 + Math.sin(n / 2.8) * 35);
    const temp = parseFloat((30.8 + Math.sin(n / 4.2) * 2.8).toFixed(1));
    const hum  = parseFloat((65.0 + Math.cos(n / 3.5) * 8.0).toFixed(1));

    const fillAlert = fill >= 95 ? 'CRITICAL' : fill >= 80 ? 'WARNING' : 'NORMAL';
    const gasAlert2 = gas >= S.gasThresh ? 'ACTIVE' : 'INACTIVE';
    const overAlert = fill >= 95 ? 'FULL' : fill >= 80 ? 'FILL' : gas >= S.gasThresh ? 'GAS' : 'NORMAL';

    // B1 Sensor location + B2 Gateway location
    const obj = {
      SEQ: String(n),
      GAS: String(gas),
      DOUT: gas >= S.gasThresh ? '0' : '1',
      GAS_ALERT: gasAlert2,
      TEMP_ALERT: temp >= S.tempThresh ? 'HIGH' : 'NORMAL',
      HUM_ALERT: hum >= S.humThresh ? 'HIGH' : 'NORMAL',
      DIST: String(dist),
      FILL: String(fill),
      FILL_ALERT: fillAlert,
      STATUS: 'ONLINE',
      TEMP: String(temp),
      HUM: String(hum),
      LAT: '12.852100',
      LON: '80.226500',
      GPS_FIX: 'FIX',
      SATS: '8',
      ALERT: overAlert,
      B2_LAT: '12.852172',
      B2_LON: '80.226555',
      B2_GPS_FIX: 'FIX',
      B2_SATS: '7',
    };

    const rssi = -73 + Math.round(Math.sin(n / 4) * 6);
    const snr  = parseFloat((8.2 + Math.cos(n / 3) * 1.4).toFixed(2));

    applyTelemetry(obj, rssi, snr, 'SUCCESS');
  };

  tick();
  S.demoTimer = window.setInterval(tick, 3500);
}

function stopDemo(showToast = true) {
  if (S.demoTimer) { window.clearInterval(S.demoTimer); S.demoTimer = null; }
  if (S.mode === 'demo') {
    setMode('disconnected');
    if (showToast) toast('Demo Stopped', 'Simulation stream halted.');
  }
}

// ============================================================
//  EXPORT CSV
// ============================================================

function exportCSV() {
  if (!S.telLog.length) {
    toast('No Records', 'Wait for incoming packets or run demo mode.', 'error');
    return;
  }
  const cols = ['timestamp', 'seq', 'gas_adc', 'temp_c', 'hum_pct', 'dist_cm', 'fill_pct', 'fill_alert', 'alert', 'b1_fix', 'rssi_dbm'];
  const rows = S.telLog.map(r => [
    new Date(r.at).toISOString(), r.seq ?? '', r.gas ?? '', r.temp ?? '', r.hum ?? '', r.dist ?? '', r.fill ?? '', r.fillAlert ?? '', r.alert ?? '', r.b1Fix ?? '', r.rssi ?? ''
  ]);
  const csv = [cols, ...rows].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url; a.download = `wastewatch-telemetry-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  toast('CSV Exported', `${S.telLog.length} records downloaded.`);
}

// ============================================================
//  ALERT THRESHOLDS
// ============================================================

function applyThresholds() {
  const gas  = Number($('gasThreshInput').value);
  const temp = Number($('tempThreshInput').value);
  const hum  = Number($('humThreshInput').value);
  const fw   = Number($('fillWarnInput').value);
  const fc   = Number($('fillCritInput').value);

  if (!Number.isFinite(gas)  || gas  < 0   || gas  > 1023) { toast('Invalid Gas Threshold', 'Value must be between 0 and 1023.', 'error'); return; }
  if (!Number.isFinite(temp) || temp < -40  || temp > 80)   { toast('Invalid Temp Threshold', 'Value must be between -40 and 80°C.', 'error'); return; }
  if (!Number.isFinite(hum)  || hum  < 0   || hum  > 100)  { toast('Invalid Humidity Threshold', 'Value must be 0–100%.', 'error'); return; }
  if (!Number.isFinite(fw)   || fw   < 0   || fw   > 100)  { toast('Invalid Warning Threshold', 'Value must be 0–100%.', 'error'); return; }
  if (!Number.isFinite(fc)   || fc   < 0   || fc   > 100)  { toast('Invalid Critical Threshold', 'Value must be 0–100%.', 'error'); return; }

  S.gasThresh  = gas;
  S.tempThresh = temp;
  S.humThresh  = hum;
  S.fillWarn   = fw;
  S.fillCrit   = fc;

  if (S.everSawB1) evaluateLocalAlerts();
  renderAll();
  toast('Thresholds Applied', 'New operational rules active.');
}

// ============================================================
//  TOAST NOTIFICATIONS
// ============================================================

function toast(title, msg, kind = 'ok') {
  const region = $('toastRegion');
  if (!region) return;
  const div = document.createElement('div');
  div.className = `toast${kind === 'error' ? ' error' : ''}`;
  const mark = document.createElement('span');
  mark.className = 'toast-mark';
  mark.textContent = kind === 'error' ? '!' : '✓';
  const copy = document.createElement('div');
  const h = document.createElement('strong'); h.textContent = title;
  const p = document.createElement('p'); p.textContent = msg;
  copy.append(h, p); div.append(mark, copy); region.append(div);
  window.setTimeout(() => div.remove(), 4200);
}

// ============================================================
//  CLOCK & REFRESH
// ============================================================

function updateClock() {
  const now = new Date();
  const lc = $('localClock'); if (lc) lc.textContent = ts(now);
  const ld = $('localDate');  if (ld) ld.textContent = now.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();

  // Stale connection alert check
  if (S.everSawB1 && S.lastPacketAt && Date.now() - S.lastPacketAt > 15000 && S.mode === 'live') {
    addOrUpdateAlert('link-stale', 'warning', 'B1 RF Telemetry Stale', 'No packet received in 15 seconds. Check B1 battery or radio.');
  } else {
    clearAlert('link-stale');
  }

  renderTopStatus();
  renderNetwork();
  renderAlertLog();
}

// ============================================================
//  EVENT LISTENERS & STARTUP
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  const cb = $('connectBtn');     if (cb) cb.addEventListener('click', connectSerial);
  const db = $('disconnectBtn');  if (db) db.addEventListener('click', disconnectSerial);
  const dmb = $('demoBtn');       if (dmb) dmb.addEventListener('click', () => S.mode === 'demo' ? stopDemo() : startDemo());
  const ec = $('exportCsvBtn');   if (ec) ec.addEventListener('click', exportCSV);
  const cab = $('clearAlertsBtn'); if (cab) cab.addEventListener('click', () => {
    S.alertLog = []; renderAlertLog();
    $('activeAlertCount').textContent = '0';
    $('sidebarAlertCount').textContent = '0';
    toast('Alerts Cleared', 'Active conditions may re-trigger if unresolved.');
  });

  const ccb = $('clearConsoleBtn'); if (ccb) ccb.addEventListener('click', () => {
    S.consoleLines = []; addConsole('Console cleared.', 'sys');
  });

  const ccp = $('copyConsoleBtn'); if (ccp) ccp.addEventListener('click', async () => {
    const text = S.consoleLines.map(l => `[${l.time}] ${l.msg}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied', 'Terminal output copied to clipboard.');
    } catch (_) {
      toast('Copy Failed', 'Clipboard access denied.', 'error');
    }
  });

  const atb = $('applyThreshBtn'); if (atb) atb.addEventListener('click', applyThresholds);
  const gkb = $('gmapsKeyBtn');    if (gkb) gkb.addEventListener('click', configureGoogleMapsApiKey);

  // Initialize official Google Maps Platform SDK immediately
  loadGoogleMapsSDK();

  if ('serial' in navigator) {
    navigator.serial.addEventListener('disconnect', e => {
      if (serialPort && e.target === serialPort) {
        addConsole('B2 USB hardware unplugged.', 'warn');
        cleanupSerial(false).then(() => setMode('disconnected'));
      }
    });
  }

  // Pre-seed startup console
  S.consoleLines = [
    { time: ts(), msg: 'WasteWatch Industrial IoT Dashboard initialized.', level: 'sys' },
    { time: ts(), msg: 'Official Google Maps dual-node tracking ready (B1 Sensor + B2 Gateway).', level: 'sys' },
    { time: ts(), msg: 'Uplink Baud: 9600 | LoRa Frequency: 433.92 MHz SF9.', level: 'sys' },
    { time: ts(), msg: 'Click "✦ Try demo" to run simulation or "Connect B2 USB" for hardware.', level: 'sys' }
  ];

  renderConsole();
  renderAll();
  updateClock();
  window.setInterval(updateClock, 1000);
});
