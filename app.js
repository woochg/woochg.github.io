/* =============================================================================
 * ArmBioZ Hydration Dashboard  v0.1.1   (Web Bluetooth PWA)
 * -----------------------------------------------------------------------------
 * Device protocol (see design/DESIGN_v0.1.1.md ch.7, ch.15):
 *   Service      4b1c0100-5a1e-4b1c-9f3e-8d2c6a7b0e41
 *   0101 Status       read/notify 24 B (v0.1.1: + session id/active)
 *   0102 Live         notify      20 B record
 *   0103 SyncInfo     read/notify 20 B
 *   0104 DataWindow   notify      DATA [D1][n][idx u16] + n*20 B  |  END 20 B
 *   0105 ControlPoint write       [op][args...]
 * Record (20 B LE): seq u32, time u32, R f32, Xc f32, flags u8, boot u8, crc16
 * Event markers (v0.1.1): R = NaN, Xc = event code (session start/stop…)
 * Integrity: CRC-16/CCITT-FALSE per record, CRC-32 (zlib) over a burst.
 * Storage: IndexedDB 'armbioz' / 'records' keyed [dev, seq] (upsert = no dupes)
 * ===========================================================================*/
'use strict';

const APP_VERSION = '0.1.1';
const UUID = (x) => `4b1c${x}-5a1e-4b1c-9f3e-8d2c6a7b0e41`;
const SVC = UUID('0100');
const CH = {
  status: UUID('0101'), live: UUID('0102'), sync: UUID('0103'),
  window: UUID('0104'), control: UUID('0105'),
};
const OP = {
  ACK: 0x01, NACK: 0x02, START: 0x10, ABORT: 0x11, READ_RANGE: 0x12,
  SET_TIME: 0x20, RESET_BASELINE: 0x30, SET_LED: 0x40,
  SESSION_START: 0x50, SESSION_STOP: 0x51, MARK: 0x52,
};
const FLAG = {
  TIME_VALID: 1, SIMULATED: 2, LEAD_OFF: 4, SETTLING: 8,
  RANGE: 16, LOW_BATT: 32, WARN: 64, ALERT: 128,
};
const STATE_NAMES = ['BOOT', 'WAIT_LEAD', 'SETTLING', 'RUN', 'LOW_BATT', 'FAULT', 'IDLE'];
const STORAGE_NAMES = ['?', 'INTERNAL', 'QSPI', 'RAM!'];
// Event marker codes (firmware Record.h record_event::*)
const EVENT_NAMES = {
  1: 'SESSION START', 2: 'SESSION STOP', 3: 'SESSION RESUME', 4: 'AUTO STOP (USB)',
  5: 'AUTO STOP (battery)', 6: 'BASELINE RESET',
};
// User marks: code sent with MARK, stored as 100 + code
const USER_EVENTS = [
  [1, '💧 음수'], [2, '🍽 식사'], [3, '🚻 소변'], [4, '🏃 운동'],
  [5, '😴 수면'], [6, '☀ 기상'], [7, '🚿 샤워'], [9, '📌 기타'],
];
const eventName = (code) => (code >= 100
  ? (USER_EVENTS.find(([c]) => c === code - 100) || [0, `USER ${code - 100}`])[1]
  : EVENT_NAMES[code] || `EVENT ${code}`);
const LEAD_NAMES = ['OK', 'OFF', 'SUSPECT'];
const ALARM_NAMES = ['none', 'WARN', 'ALERT'];
const RESET_NAMES = ['power-on', 'pin', 'WATCHDOG', 'soft', 'LOCKUP', 'wake', 'other'];
const PWR_NAMES = ['normal', 'warn', 'CRITICAL', 'SHUTDOWN'];
const MEDIAN_WIN_S = 300;

/* ---------------------------------------------------------------- utilities */
// localStorage may be missing or throw (private mode, blocked site data).
const store = {
  get(k) { try { return globalThis.localStorage ? localStorage.getItem(k) : null; } catch (_) { return null; } },
  set(k, v) { try { if (globalThis.localStorage) localStorage.setItem(k, v); } catch (_) { /* ignore */ } },
};
const $ = (id) => document.getElementById(id);
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');
const hms = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const hm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const ymdhms = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hms(d)}`;

function crc16(bytes) {            // CCITT-FALSE: poly 0x1021, init 0xFFFF
  let c = 0xffff;
  for (const b of bytes) {
    c ^= b << 8;
    for (let i = 0; i < 8; i++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(crc, bytes) {       // zlib-compatible, chainable (start with 0)
  let c = (~crc) >>> 0;
  for (const b of bytes) c = CRC32_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function parseRecord(u8, off = 0) {
  const raw = u8.subarray(off, off + 20);
  const dv = new DataView(raw.buffer, raw.byteOffset, 20);
  const rec = {
    seq: dv.getUint32(0, true),
    time: dv.getUint32(4, true),
    r: dv.getFloat32(8, true),
    xc: dv.getFloat32(12, true),
    flags: dv.getUint8(16),
    boot: dv.getUint8(17),
  };
  rec.crcOk = dv.getUint16(18, true) === crc16(raw.subarray(0, 18));
  return { rec, raw };
}

function encodeRecord(rec) {       // used by Demo mode
  const u8 = new Uint8Array(20);
  const dv = new DataView(u8.buffer);
  dv.setUint32(0, rec.seq, true); dv.setUint32(4, rec.time, true);
  dv.setFloat32(8, rec.r, true); dv.setFloat32(12, rec.xc, true);
  dv.setUint8(16, rec.flags); dv.setUint8(17, rec.boot);
  dv.setUint16(18, crc16(u8.subarray(0, 18)), true);
  return u8;
}

function derive(rec) {
  const z = Math.hypot(rec.r, rec.xc);
  const phi = Math.atan2(rec.xc, rec.r) * 180 / Math.PI;
  return { z, phi };
}

/* ---------------------------------------------------------------- logging */
const logLines = [];
function log(msg, level = 'info') {
  const t = hms(new Date());
  logLines.push(`${t} ${level === 'err' ? '✖ ' : level === 'warn' ? '⚠ ' : ''}${msg}`);
  if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
  const el = $('log');
  el.textContent = logLines.join('\n');
  el.scrollTop = el.scrollHeight;
}

/* ---------------------------------------------------------------- IndexedDB */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open('armbioz', 1);
      rq.onupgradeneeded = () => {
        const s = rq.result.createObjectStore('records', { keyPath: ['dev', 'seq'] });
        s.createIndex('dev', 'dev');
      };
      rq.onsuccess = () => { this.db = rq.result; res(); };
      rq.onerror = () => rej(rq.error);
    });
  },
  putMany(rows) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction('records', 'readwrite');
      const st = tx.objectStore('records');
      for (const r of rows) st.put(r);
      tx.oncomplete = () => res(rows.length);
      tx.onerror = () => rej(tx.error);
    });
  },
  getAll(dev) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction('records');
      const rq = dev ? tx.objectStore('records').index('dev').getAll(dev)
                     : tx.objectStore('records').getAll();
      rq.onsuccess = () => res(rq.result.sort((a, b) => (a.dev < b.dev ? -1 : a.dev > b.dev ? 1 : a.seq - b.seq)));
      rq.onerror = () => rej(rq.error);
    });
  },
  clear() {
    return new Promise((res, rej) => {
      const tx = this.db.transaction('records', 'readwrite');
      tx.objectStore('records').clear();
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },
};

/* ---------------------------------------------------------------- app state */
const S = {
  link: null,            // BleLink or DemoLink
  dev: store.get('armbioz.dev') || null,
  status: null,          // parsed Status + rxMs
  syncInfo: null,
  rows: [],              // records of current device (sorted by seq)
  winS: 3600,
  ledOn: true,
  sync: null,            // {buf, crc, tries, expectEnd}
  armCirc: parseFloat(store.get('armbioz.armCirc')) || NaN,
  height: parseFloat(store.get('armbioz.height')) || NaN,
};

/* --------------------------------------------------- record time re-basing */
// Records stored before SET_TIME carry uptime seconds. If they belong to the
// current boot, epoch = deviceNowEpoch - (deviceUptimeNow - rec.time).
function toRow(rec) {
  let t = null;
  if (rec.flags & FLAG.TIME_VALID) {
    t = rec.time;
  } else if (S.status && (S.status.boot & 0xff) === rec.boot) {
    const upNow = S.status.uptime + (Date.now() - S.status.rxMs) / 1000;
    t = Math.round(nowEpoch() - (upNow - rec.time));
  }
  const ev = Number.isNaN(rec.r) ? Math.round(rec.xc) : 0;   // marker record
  const { z, phi } = ev ? { z: NaN, phi: NaN } : derive(rec);
  return {
    dev: S.dev, seq: rec.seq, t, rawTime: rec.time, r: rec.r, xc: rec.xc,
    z, phi, flags: rec.flags, boot: rec.boot, ev,
  };
}

/* ------------------------------------------------------- packet handlers */
function onStatus(dv) {
  const s = {
    vbat: dv.getUint16(0, true), soc: dv.getUint8(2), state: dv.getUint8(3),
    lead: dv.getUint8(4), alarm: dv.getUint8(5), reset: dv.getUint8(6),
    fw: `${dv.getUint8(7)}.${dv.getUint8(8)}.${dv.getUint8(9)}`,
    uptime: dv.getUint32(10, true), lost: dv.getUint32(14, true),
    flags: dv.getUint8(18), power: dv.getUint8(19), rxMs: Date.now(),
    boot: S.syncInfo ? S.syncInfo.boot : (S.status ? S.status.boot : 0),
    session: dv.byteLength >= 24 ? dv.getUint16(20, true) : 0,
    sessionActive: dv.byteLength >= 24 ? !!(dv.getUint8(22) & 1) : null,
    usb: dv.byteLength >= 24 ? !!(dv.getUint8(22) & 2) : false,
    usbInhibit: dv.byteLength >= 24 ? !!(dv.getUint8(22) & 4) : false,
    storage: dv.byteLength >= 24 ? dv.getUint8(23) : 0,
  };
  const prev = S.status;
  S.status = s;
  if (!prev || prev.state !== s.state) log(`state → ${STATE_NAMES[s.state] || s.state}`);
  if (!prev || prev.alarm !== s.alarm) {
    if (s.alarm) log(`ALARM ${ALARM_NAMES[s.alarm]}`, 'warn');
  }
  if (!prev) {
    log(`fw ${s.fw}, reset=${RESET_NAMES[s.reset] || s.reset}`);
    if (s.sessionActive === null) log('firmware < v0.1.1: 세션 기능 없음 → 펌웨어 업데이트 필요', 'warn');
  }
  if (prev && prev.sessionActive !== s.sessionActive && s.sessionActive !== null) {
    log(`session #${s.session} ${s.sessionActive ? 'ACTIVE' : 'stopped'}`);
  }
  S.ledOn = !!(s.flags & 64);
  renderStatus();
}

function onSyncInfo(dv) {
  S.syncInfo = {
    unsynced: dv.getUint32(0, true), oldest: dv.getUint32(4, true),
    head: dv.getUint32(8, true), lastSync: dv.getUint32(12, true),
    mtu: dv.getUint16(16, true), rpp: dv.getUint8(18), boot: dv.getUint8(19),
  };
  if (S.status) S.status.boot = S.syncInfo.boot;
  renderStatus();
}

async function onLive(dv) {
  const u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  const { rec } = parseRecord(u8);
  if (!rec.crcOk) { log('live record CRC error', 'warn'); return; }
  const row = toRow(rec);
  if (row.ev) log(`event #${rec.seq}: ${eventName(row.ev)}`);
  else renderLive(row);
  if (rec.seq > 0 && S.dev) {          // seq 0 = not stored on device
    await DB.putMany([row]);
    upsertRow(row);
    renderPlots();
  }
}

function onWindow(dv) {
  const sy = S.sync;
  if (!sy) return;
  const u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  const type = u8[0];
  if (type === 0xd1) {
    const n = u8[1];
    if (u8.length !== 4 + n * 20) { sy.bad = true; return; }
    for (let i = 0; i < n; i++) {
      const { rec, raw } = parseRecord(u8, 4 + i * 20);
      sy.crc = crc32(sy.crc, raw);
      if (!rec.crcOk) { sy.bad = true; if (sy.firstBad == null) sy.firstBad = rec.seq; continue; }
      sy.buf.push(rec);
    }
    showProgress(sy.kept.length + sy.buf.length, sy.expect);
  } else if (type === 0xde) {
    const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const end = {
      count: d.getUint32(4, true), first: d.getUint32(8, true),
      last: d.getUint32(12, true), crc: d.getUint32(16, true),
    };
    finishBurst(end).catch((e) => log(`sync error: ${e.message}`, 'err'));
  }
}

async function finishBurst(end) {
  const sy = S.sync;
  const ok = !sy.bad && end.count === sy.buf.length && end.crc === sy.crc;
  if (end.count === 0) {
    log('sync: 미동기 데이터 없음');
    endSync();
    return;
  }
  if (!ok) {
    sy.tries += 1;
    log(`sync verify FAIL (got ${sy.buf.length}/${end.count}, crc ${sy.crc.toString(16)} vs ${end.crc.toString(16)}) → NACK #${sy.tries}`, 'warn');
    if (sy.tries > 3) { log('sync aborted after 3 retries', 'err'); await S.link.write([OP.ABORT]); endSync(); return; }
    const from = sy.firstBad ?? end.first;
    // Keep verified records before `from`: the device re-sends [from..last]
    // as a new burst with its own END/CRC, and the final ACK covers both.
    sy.kept = sy.kept.concat(sy.buf.filter((r) => r.seq < from));
    resetBurst();
    await S.link.write([OP.NACK, ...u32(from)]);
    return;
  }
  const rows = sy.kept.concat(sy.buf).map(toRow);
  await DB.putMany(rows);
  rows.forEach(upsertRow);
  await S.link.write([OP.ACK, ...u32(end.last)]);
  const dt = (Date.now() - sy.t0) / 1000;
  log(`sync OK: ${rows.length} records (…#${end.last}) ${dt.toFixed(1)} s, ${(rows.length * 20 / 1024 / Math.max(dt, 0.001)).toFixed(1)} KiB/s → ACK`);
  endSync();
  renderPlots();
  renderData();
}

function resetBurst() { Object.assign(S.sync, { buf: [], crc: 0, bad: false, firstBad: null }); }
function endSync() {
  S.sync = null;
  $('syncProg').hidden = true;
  $('connDot').classList.remove('busy');
  $('btnSync').disabled = !S.link;
}
const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

async function startSync() {
  if (!S.link || S.sync) return;
  const info = await S.link.readSyncInfo();
  if (info) onSyncInfo(info);
  const expect = S.syncInfo ? S.syncInfo.unsynced : 0;
  S.sync = { buf: [], kept: [], crc: 0, bad: false, firstBad: null, tries: 0, expect, t0: Date.now() };
  $('btnSync').disabled = true;
  $('connDot').classList.add('busy');
  showProgress(0, expect);
  log(`sync start: unsynced=${expect}, MTU=${S.syncInfo ? S.syncInfo.mtu : '?'}, ${S.syncInfo ? S.syncInfo.rpp : '?'} rec/pkt`);
  await S.link.write([OP.START, 0, 0]);
  // Safety net: device aborts on stall/ack timeout; mirror it here.
  const myRun = S.sync;
  setTimeout(() => { if (S.sync === myRun) { log('sync timeout', 'warn'); endSync(); } }, 120000);
}

function showProgress(n, total) {
  $('syncProg').hidden = false;
  const p = total ? Math.min(100, (100 * n) / total) : 100;
  $('syncBar').style.width = `${p}%`;
  $('syncTxt').textContent = `${n} / ${total || '?'}`;
}

/* ------------------------------------------------------------ BLE link */
class BleLink {
  constructor() { this.q = Promise.resolve(); this.ch = {}; }
  // Web Bluetooth allows one GATT operation at a time -> serialise.
  op(fn) { const p = this.q.then(fn, fn); this.q = p.catch(() => {}); return p; }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'ArmBioZ' }, { services: [SVC] }],
      optionalServices: [SVC, 'battery_service', 'device_information'],
    });
    this.device.addEventListener('gattserverdisconnected', () => onDisconnected());
    log(`connecting to ${this.device.name || this.device.id} …`);
    this.server = await this.device.gatt.connect();
    const svc = await this.server.getPrimaryService(SVC);
    for (const [k, u] of Object.entries(CH)) this.ch[k] = await svc.getCharacteristic(u);
    const sub = async (k, fn) => {
      this.ch[k].addEventListener('characteristicvaluechanged', (e) => fn(e.target.value));
      await this.op(() => this.ch[k].startNotifications());
    };
    await sub('status', onStatus);
    await sub('sync', onSyncInfo);
    await sub('window', onWindow);
    await sub('live', (v) => onLive(v).catch((e) => log(e.message, 'err')));
    return this.device.name || this.device.id;
  }
  async readStatus() { return this.op(() => this.ch.status.readValue()); }
  async readSyncInfo() { return this.op(() => this.ch.sync.readValue()); }
  async write(bytes) {
    return this.op(() => this.ch.control.writeValueWithResponse(new Uint8Array(bytes)));
  }
  disconnect() { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); }
}

/* ------------------------------------------------------------ Demo link */
// Emulates the firmware protocol in JS (same encoders, CRCs, END packet,
// ACK/NACK) so the dashboard can be exercised without hardware.
class DemoLink {
  constructor() {
    this.boot = 1; this.uptime0 = Date.now(); this.epochValid = false; this.epochOff = 0;
    this.head = 0; this.ack = 0; this.store = []; this.r = 120; this.xc = 25; this.led = true;
    this.state = 1; this.okRun = 0; this.lastSync = 0; this.session = 1; this.active = true;
    // 2 h backlog of session #1 recorded before "connection" (uptime-stamped)
    this.marker(1, 0);
    for (let i = 0; i < 1440; i++) this.measure(i * 5);
    this.marker(103, 3600);                // a 'urination' mark in the backlog
  }
  marker(code, tUp) {
    let f = FLAG.SIMULATED; let time = tUp;
    if (this.epochValid) { f |= FLAG.TIME_VALID; time = this.epochOff + tUp; }
    const rec = { seq: ++this.head, time, r: NaN, xc: code, flags: f, boot: this.boot };
    this.store.push(rec);
    return rec;
  }
  emit(rec) { onLive(this.dv(encodeRecord(rec))).catch(() => {}); }
  uptimeS() { return Math.floor((Date.now() - this.uptime0) / 1000) + 7200; }
  measure(tUp) {
    const g = () => { let s = 0; for (let i = 0; i < 6; i++) s += Math.random(); return (s - 3) / Math.sqrt(0.5); };
    const mu = 120 * (1 + Math.min(0.2, this.head / 3000 * 0.2));
    this.r += (mu - this.r) * (5 / 600) + 0.3 * g();
    this.xc += (25 * (1 + Math.min(0.1, this.head / 3000 * 0.1)) - this.xc) * (5 / 600) + 0.15 * g();
    if (this.okRun < 3) this.okRun++; else if (this.state === 1) this.state = 2;
    if (this.state === 2 && this.head > 30) this.state = 3;
    let f = FLAG.SIMULATED | (this.state !== 3 ? FLAG.SETTLING : 0);
    let time = tUp;
    if (this.epochValid) { f |= FLAG.TIME_VALID; time = this.epochOff + tUp; }
    const rec = { seq: ++this.head, time, r: this.r, xc: this.xc, flags: f, boot: this.boot };
    this.store.push(rec);
    return rec;
  }
  dv(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
  statusBytes() {
    const u8 = new Uint8Array(24); const d = this.dv(u8);
    d.setUint16(0, 3920, true); u8[2] = 78; u8[3] = this.active ? this.state : 6; u8[4] = 0; u8[5] = 0; u8[6] = 0;
    u8[7] = 0; u8[8] = 1; u8[9] = 0; d.setUint32(10, this.uptimeS(), true); d.setUint32(14, 0, true);
    u8[18] = 4 | 8 | 32 | (this.led ? 64 : 0) | (this.epochValid ? 2 : 0) | (this.ack > 0 ? 16 : 0);
    u8[19] = 0; d.setUint16(20, this.session, true); u8[22] = this.active ? 1 : 0; u8[23] = 1;
    return this.dv(u8);
  }
  syncBytes() {
    const u8 = new Uint8Array(20); const d = this.dv(u8);
    d.setUint32(0, this.head - this.ack, true); d.setUint32(4, this.ack + 1, true);
    d.setUint32(8, this.head, true); d.setUint32(12, this.lastSync, true);
    d.setUint16(16, 247, true); u8[18] = 12; u8[19] = this.boot;
    return this.dv(u8);
  }
  async connect() {
    await sleep(300);
    onSyncInfo(this.syncBytes());
    onStatus(this.statusBytes());
    this.timer = setInterval(() => {      // 5 s cycle accelerated to 1 s
      if (this.active) this.emit(this.measure(this.uptimeS()));
      onStatus(this.statusBytes());
      onSyncInfo(this.syncBytes());
    }, 1000);
    return 'ArmBioZ-DEMO';
  }
  async readStatus() { return this.statusBytes(); }
  async readSyncInfo() { return this.syncBytes(); }
  async burst(from, to) {
    let crc = 0, n = 0, first = 0, last = 0, idx = 0;
    const recs = this.store.filter((r) => r.seq >= from && r.seq <= to);
    for (let i = 0; i < recs.length; i += 12) {
      const chunk = recs.slice(i, i + 12);
      const pkt = new Uint8Array(4 + chunk.length * 20);
      pkt[0] = 0xd1; pkt[1] = chunk.length; pkt[2] = idx & 0xff; pkt[3] = idx >> 8; idx++;
      chunk.forEach((r, j) => {
        const b = encodeRecord(r); pkt.set(b, 4 + j * 20); crc = crc32(crc, b);
        if (!n) first = r.seq; last = r.seq; n++;
      });
      onWindow(this.dv(pkt));
      if (idx % 8 === 0) await sleep(5);
    }
    const end = new Uint8Array(20); const d = this.dv(end);
    end[0] = 0xde; d.setUint32(4, n, true); d.setUint32(8, first, true);
    d.setUint32(12, last, true); d.setUint32(16, crc, true);
    onWindow(d);
  }
  async write(bytes) {
    const d = new DataView(new Uint8Array(bytes).buffer);
    switch (bytes[0]) {
      case OP.START: setTimeout(() => this.burst(this.ack + 1, this.head), 50); break;
      case OP.NACK: setTimeout(() => this.burst(d.getUint32(1, true), this.head), 50); break;
      case OP.ACK: this.ack = Math.max(this.ack, Math.min(d.getUint32(1, true), this.head)); this.lastSync = nowEpoch();
        setTimeout(() => onSyncInfo(this.syncBytes()), 20); break;
      case OP.SET_TIME: this.epochValid = true; this.epochOff = d.getUint32(1, true) - this.uptimeS(); break;
      case OP.SET_LED: this.led = !!bytes[1]; break;
      case OP.RESET_BASELINE: this.state = 2; this.emit(this.marker(6, this.uptimeS())); break;
      case OP.SESSION_START:
        if (!this.active) { this.session++; this.active = true; this.state = 1; this.okRun = 0; this.emit(this.marker(1, this.uptimeS())); }
        setTimeout(() => onStatus(this.statusBytes()), 20); break;
      case OP.SESSION_STOP:
        if (this.active) { this.emit(this.marker(2, this.uptimeS())); this.active = false; }
        setTimeout(() => onStatus(this.statusBytes()), 20); break;
      case OP.MARK: this.emit(this.marker(100 + bytes[1], this.uptimeS())); break;
      default: break;
    }
  }
  disconnect() { clearInterval(this.timer); setTimeout(onDisconnected, 50); }
}

/* --------------------------------------------------- connect / disconnect */
async function connect(demo) {
  try {
    const link = demo ? new DemoLink() : new BleLink();
    const name = await link.connect();
    S.link = link;
    S.dev = name;
    store.set('armbioz.dev', name);
    $('devName').textContent = `${name} · v${APP_VERSION}`;
    $('connDot').classList.add('on');
    for (const id of ['btnDisconnect', 'btnSync', 'btnLed', 'btnBaseline']) $(id).disabled = false;
    renderSession();
    $('btnConnect').disabled = true; $('btnDemo').disabled = true;
    log(`connected: ${name}${demo ? ' (demo)' : ''}`);
    if (!demo) {
      onStatus(await link.readStatus());
      onSyncInfo(await link.readSyncInfo());
    }
    await link.write([OP.SET_TIME, ...u32(nowEpoch()), 0, 0]);
    log('time synchronised');
    await loadRows();
    if (S.syncInfo && S.syncInfo.unsynced > 0) await startSync();   // auto high-speed sync
  } catch (e) {
    log(`connect failed: ${e.message}`, 'err');
    S.link = null;
  }
}

function onDisconnected() {
  log('disconnected', 'warn');
  if (S.sync) endSync();
  S.link = null;
  $('connDot').classList.remove('on', 'busy');
  for (const id of ['btnDisconnect', 'btnSync', 'btnLed', 'btnBaseline']) $(id).disabled = true;
  $('btnConnect').disabled = !navigator.bluetooth; $('btnDemo').disabled = false;
  renderSession();
}

/* ------------------------------------------------------------ data access */
async function loadRows() {
  S.rows = S.dev ? await DB.getAll(S.dev) : [];
  renderPlots(); renderData();
}
function upsertRow(row) {
  const a = S.rows;
  if (!a.length || a[a.length - 1].seq < row.seq) { a.push(row); return; }
  let lo = 0, hi = a.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (a[m].seq === row.seq) { a[m] = row; return; }
    if (a[m].seq < row.seq) lo = m + 1; else hi = m - 1;
  }
  a.splice(lo, 0, row);
}
const usable = (r) => !r.ev && !(r.flags & (FLAG.LEAD_OFF | FLAG.SETTLING)) && Number.isFinite(r.z);
function median(v) {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function sessionStartIndex() {   // last START / RESUME / BASELINE RESET
  for (let i = S.rows.length - 1; i >= 0; i--) {
    const e = S.rows[i].ev;
    if (e === 1 || e === 3 || e === 6) return i;
  }
  return 0;
}
function baselineZ0() {         // 5-min median right after settling (Eq.2)
  const s0 = sessionStartIndex();
  const rel = S.rows.slice(s0).findIndex(usable);
  const first = rel < 0 ? -1 : s0 + rel;
  if (first < 0) return NaN;
  return median(S.rows.slice(first, first + 60).filter(usable).map((r) => r.z));
}

/* ------------------------------------------------------------ rendering */
function renderStatus() {
  const s = S.status; const y = S.syncInfo;
  if (s) {
    $('stState').textContent = STATE_NAMES[s.state] || s.state;
    $('stLead').textContent = LEAD_NAMES[s.lead] || s.lead;
    $('stAlarm').textContent = ALARM_NAMES[s.alarm] || s.alarm;
    $('stBatt').textContent = (s.flags & 128) ? 'USB / n.a.' : `${(s.vbat / 1000).toFixed(2)} V · ${s.soc}% ${s.flags & 1 ? '⚡' : ''}`;
    $('stUptime').textContent = `${Math.floor(s.uptime / 3600)} h ${Math.floor((s.uptime % 3600) / 60)} m`;
    $('stSource').textContent = `${s.flags & 4 ? 'SIMULATED' : 'MAX30002'} · ${s.storage ? STORAGE_NAMES[s.storage] : (s.flags & 8 ? 'FLASH' : 'RAM!')}`;
    $('stMeta').textContent = `fw ${s.fw} · reset ${RESET_NAMES[s.reset] || s.reset} · power ${PWR_NAMES[s.power] || s.power} · lost ${s.lost} · baseline ${s.flags & 16 ? 'set' : '—'} · write ${s.flags & 32 ? 'on' : 'OFF'}`;
    const b = $('alarmBanner');
    if (s.alarm === 2) { b.className = 'banner alert'; b.textContent = 'ALERT: |Z| ≥ 1.20 × 기준 — 탈수 의심 (잠정 임계치, 비임상)'; b.hidden = false; }
    else if (s.alarm === 1) { b.className = 'banner warn'; b.textContent = 'WARN: |Z| ≥ 1.10 × 기준 — 수분 섭취 확인 (잠정 임계치)'; b.hidden = false; }
    else if (s.power >= 2) { b.className = 'banner alert'; b.textContent = '배터리 저전압: 플래시 기록 중단됨'; b.hidden = false; }
    else b.hidden = true;
  }
  renderSession();
  if (y) {
    $('stUnsynced').textContent = `${y.unsynced}  (head #${y.head})`;
    $('stLastSync').textContent = y.lastSync ? ymdhms(new Date(y.lastSync * 1000)) : '—';
  }
}

function renderSession() {
  const s = S.status;
  const linked = !!S.link;
  const supported = s && s.sessionActive !== null;
  const active = !!(s && s.sessionActive);
  $('sessState').textContent = !s ? '—' : !supported ? '미지원 (fw v0.1.0)'
    : active ? `#${s.session} 측정 중 · ${STATE_NAMES[s.state] || s.state}` : `정지 (마지막 #${s.session})`;
  $('sessCard').classList.toggle('live', active);
  $('btnStart').disabled = !linked || !supported || active || (s.usbInhibit && s.usb);
  $('btnStop').disabled = !linked || !supported || !active;
  document.querySelectorAll('.evbtn').forEach((b) => { b.disabled = !linked || !supported; });
  $('sessHint').textContent = !s ? '' : (s.usbInhibit && s.usb) ? 'USB 전원 연결 중: 측정 금지 설정으로 시작할 수 없습니다.'
    : active ? '연결을 끊어도 측정·기록은 계속됩니다.' : 'Start를 누르면 새 세션(기준값 Z₀ 재설정, 30분 안정화)이 시작됩니다.';
}

function renderLive(row) {
  $('mR').textContent = fmt(row.r); $('mXc').textContent = fmt(row.xc);
  $('mZ').textContent = fmt(row.z); $('mPhi').textContent = fmt(row.phi, 1);
  const z0 = baselineZ0();
  $('mHi').textContent = Number.isFinite(z0) ? fmt(row.z / z0, 3) : '—';
  const d = S.armCirc / Math.PI / 100;           // m
  $('mZd').textContent = Number.isFinite(d) && d > 0 ? fmt(row.z / d, 0) : '—';
}

function renderData() {
  $('dbCount').textContent = S.rows.length.toLocaleString();
  $('dbRange').textContent = S.rows.length ? `#${S.rows[0].seq} … #${S.rows[S.rows.length - 1].seq}` : '—';
}

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function prepCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth; const h = cv.height / (cv._dpr || 1);
  cv._dpr = dpr; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}
function axes(g, w, h, pad, x0, x1, y0, y1, xfmt, yfmt) {
  g.strokeStyle = css('--line'); g.fillStyle = css('--muted'); g.lineWidth = 1;
  g.font = '11px system-ui'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = y0 + (y1 - y0) * i / 4; const y = h - pad.b - (h - pad.t - pad.b) * i / 4;
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
    g.fillText(yfmt(v), pad.l - 4, y);
  }
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (let i = 0; i <= 3; i++) {
    const v = x0 + (x1 - x0) * i / 3; const x = pad.l + (w - pad.l - pad.r) * i / 3;
    g.fillText(xfmt(v), x, h - pad.b + 4);
  }
}

function renderPlots() {
  const rows = S.rows.filter((r) => Number.isFinite(r.z));
  // ---- |Z| time series (x = epoch if known, else seq*5 s) -------------------
  {
    const { g, w, h } = prepCanvas($('cvTime'));
    const pad = { l: 44, r: 10, t: 10, b: 22 };
    const tx = (r) => (r.t != null ? r.t : r.seq * 5);
    let pts = rows;
    if (S.winS && pts.length) { const tEnd = tx(pts[pts.length - 1]); pts = pts.filter((r) => tx(r) >= tEnd - S.winS); }
    if (pts.length < 2) {
      g.fillStyle = css('--muted'); g.font = '13px system-ui'; g.textAlign = 'center';
      g.fillText('데이터 대기 중', w / 2, h / 2);
    } else {
      const xs = pts.map(tx); const zs = pts.map((r) => r.z);
      const x0 = xs[0], x1 = xs[xs.length - 1] || x0 + 1;
      let y0 = Math.min(...zs), y1 = Math.max(...zs); const m = (y1 - y0) * 0.08 || 1; y0 -= m; y1 += m;
      const X = (v) => pad.l + (w - pad.l - pad.r) * (v - x0) / ((x1 - x0) || 1);
      const Y = (v) => h - pad.b - (h - pad.t - pad.b) * (v - y0) / (y1 - y0);
      const hasT = pts[0].t != null;
      axes(g, w, h, pad, x0, x1, y0, y1,
        (v) => (hasT ? hm(new Date(v * 1000)) : `${Math.round((v - x0) / 60)}m`),
        (v) => v.toFixed(1));
      // raw points
      for (const r of pts) {
        g.fillStyle = usable(r) ? css('--plot-line') : css('--plot-grey');
        g.globalAlpha = 0.55; g.fillRect(X(tx(r)) - 1, Y(r.z) - 1, 2, 2);
      }
      g.globalAlpha = 1;
      // 5-min rolling median (usable only)
      const u = pts.filter(usable); const med = []; let lo = 0;
      for (let i = 0; i < u.length; i += Math.max(1, Math.floor(u.length / 400))) {
        while (tx(u[lo]) < tx(u[i]) - MEDIAN_WIN_S) lo++;
        med.push([tx(u[i]), median(u.slice(lo, i + 1).map((r) => r.z))]);
      }
      g.strokeStyle = css('--plot-median'); g.lineWidth = 2; g.beginPath();
      med.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
      g.stroke();
      // event markers (vertical lines + short labels)
      const tEnd = xs[xs.length - 1], tStart = xs[0];
      const marks = S.rows.filter((r) => r.ev && tx(r) >= tStart && tx(r) <= tEnd);
      g.font = '10px system-ui'; g.textAlign = 'left'; g.textBaseline = 'top';
      marks.slice(-40).forEach((r, i) => {
        const x = X(tx(r));
        const sys = r.ev < 100;
        g.strokeStyle = sys ? css('--accent') : css('--warn'); g.lineWidth = 1;
        g.setLineDash(sys ? [] : [2, 3]);
        g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, h - pad.b); g.stroke();
        g.setLineDash([]);
        g.fillStyle = g.strokeStyle;
        g.fillText(eventName(r.ev).replace('SESSION ', ''), x + 2, pad.t + (i % 3) * 11);
      });
      const z0 = baselineZ0();
      if (Number.isFinite(z0) && z0 > y0 && z0 < y1) {
        g.setLineDash([4, 4]); g.strokeStyle = css('--warn'); g.lineWidth = 1;
        g.beginPath(); g.moveTo(pad.l, Y(z0)); g.lineTo(w - pad.r, Y(z0)); g.stroke(); g.setLineDash([]);
      }
    }
  }
  // ---- R–Xc plane ----------------------------------------------------------
  {
    const { g, w, h } = prepCanvas($('cvBiva'));
    const pad = { l: 44, r: 10, t: 10, b: 22 };
    const pts = rows.filter(usable).slice(-2000);
    if (pts.length < 2) {
      g.fillStyle = css('--muted'); g.font = '13px system-ui'; g.textAlign = 'center';
      g.fillText('R–Xc: 데이터 대기 중', w / 2, h / 2);
      return;
    }
    let x0 = Math.min(...pts.map((r) => r.r)), x1 = Math.max(...pts.map((r) => r.r));
    let y0 = Math.min(...pts.map((r) => r.xc)), y1 = Math.max(...pts.map((r) => r.xc));
    const mx = (x1 - x0) * 0.1 || 1, my = (y1 - y0) * 0.1 || 1; x0 -= mx; x1 += mx; y0 -= my; y1 += my;
    axes(g, w, h, pad, x0, x1, y0, y1, (v) => `R ${v.toFixed(0)}`, (v) => v.toFixed(1));
    const X = (v) => pad.l + (w - pad.l - pad.r) * (v - x0) / (x1 - x0);
    const Y = (v) => h - pad.b - (h - pad.t - pad.b) * (v - y0) / (y1 - y0);
    g.fillStyle = css('--plot-line');
    pts.forEach((r, i) => { g.globalAlpha = 0.15 + 0.85 * (i / pts.length); g.beginPath(); g.arc(X(r.r), Y(r.xc), 2, 0, 6.283); g.fill(); });
    g.globalAlpha = 1;
    const last = pts[pts.length - 1];
    g.strokeStyle = css('--plot-median'); g.lineWidth = 2; g.beginPath(); g.arc(X(last.r), Y(last.xc), 5, 0, 6.283); g.stroke();
  }
}

/* ------------------------------------------------------------ export */
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function exportCsv() {
  const rows = await DB.getAll(null);
  const head = 'device,seq,epoch_s,iso_time,time_valid,raw_time,boot,event_code,event,R_ohm,Xc_ohm,Z_ohm,phase_deg,flags_hex,settling,lead_off,simulated';
  const lines = rows.map((r) => [
    r.dev, r.seq, r.t ?? '', r.t != null ? new Date(r.t * 1000).toISOString() : '',
    r.flags & FLAG.TIME_VALID ? 1 : 0, r.rawTime, r.boot, r.ev || '', r.ev ? `"${eventName(r.ev)}"` : '',
    r.ev ? '' : r.r.toFixed(4), r.ev ? '' : r.xc.toFixed(4),
    r.ev ? '' : r.z.toFixed(4), r.ev ? '' : r.phi.toFixed(3), `0x${r.flags.toString(16).padStart(2, '0')}`,
    r.flags & FLAG.SETTLING ? 1 : 0, r.flags & FLAG.LEAD_OFF ? 1 : 0, r.flags & FLAG.SIMULATED ? 1 : 0,
  ].join(','));
  download(`armbioz_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`, [head, ...lines].join('\n'), 'text/csv');
  log(`CSV exported: ${rows.length} rows`);
}
async function exportJson() {
  const rows = await DB.getAll(null);
  const meta = { app: APP_VERSION, exported: new Date().toISOString(), armCircCm: S.armCirc, heightCm: S.height };
  download(`armbioz_${Date.now()}.json`, JSON.stringify({ meta, rows }), 'application/json');
  log(`JSON exported: ${rows.length} rows`);
}

/* ------------------------------------------------------------ wiring */
function bind() {
  $('btnConnect').onclick = () => connect(false);
  $('btnDemo').onclick = () => connect(true);
  $('btnDisconnect').onclick = () => S.link && S.link.disconnect();
  $('btnSync').onclick = () => startSync().catch((e) => log(e.message, 'err'));
  $('btnLed').onclick = async () => { S.ledOn = !S.ledOn; await S.link.write([OP.SET_LED, S.ledOn ? 1 : 0]); log(`LED heartbeat ${S.ledOn ? 'ON' : 'OFF'}`); };
  $('btnBaseline').onclick = async () => {
    if (!confirm('재착용으로 기준값(Z₀)을 다시 잡습니까? 장치는 settling부터 다시 시작합니다.')) return;
    await S.link.write([OP.RESET_BASELINE]); log('baseline reset requested');
  };
  $('btnStart').onclick = async () => {
    await S.link.write([OP.SESSION_START]);
    log('session START requested');
  };
  $('btnStop').onclick = async () => {
    if (!confirm('측정 세션을 종료합니까? 전류 주입이 멈추고 기록이 중단됩니다.')) return;
    await S.link.write([OP.SESSION_STOP]);
    log('session STOP requested');
  };
  const ev = $('evButtons');
  USER_EVENTS.forEach(([code, label]) => {
    const b = document.createElement('button');
    b.className = 'evbtn ghost'; b.textContent = label; b.disabled = true;
    b.onclick = async () => { await S.link.write([OP.MARK, code]); };
    ev.appendChild(b);
  });
  $('btnCsv').onclick = () => exportCsv().catch((e) => log(e.message, 'err'));
  $('btnJson').onclick = () => exportJson().catch((e) => log(e.message, 'err'));
  $('btnClear').onclick = async () => {
    if (!confirm('이 브라우저에 저장된 모든 레코드를 지웁니다. (장치 플래시는 유지)')) return;
    await DB.clear(); await loadRows(); log('local store cleared');
  };
  $('btnCopyLog').onclick = () => navigator.clipboard.writeText(logLines.join('\n')).then(() => log('log copied'));
  $('btnClearLog').onclick = () => { logLines.length = 0; $('log').textContent = ''; };
  document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    S.winS = +b.dataset.win; renderPlots();
  }));
  const inC = $('inArmCirc'), inH = $('inHeight');
  if (Number.isFinite(S.armCirc)) inC.value = S.armCirc;
  if (Number.isFinite(S.height)) inH.value = S.height;
  inC.onchange = () => { S.armCirc = parseFloat(inC.value); store.set('armbioz.armCirc', inC.value); };
  inH.onchange = () => { S.height = parseFloat(inH.value); store.set('armbioz.height', inH.value); };
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderPlots, 150); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', renderPlots);
  // Web Bluetooth only works in the foreground; release the link when hidden
  // long enough to save device power (design 7.5).
  let hideTimer;
  document.addEventListener('visibilitychange', () => {
    clearTimeout(hideTimer);
    if (document.hidden && S.link && !S.sync) hideTimer = setTimeout(() => { log('background → disconnect (power save)'); S.link && S.link.disconnect(); }, 60000);
  });
}

async function main() {
  bind();
  if (!navigator.bluetooth) { $('unsupported').hidden = false; $('btnConnect').disabled = true; }
  try { await DB.open(); } catch (e) { log(`IndexedDB unavailable: ${e.message}`, 'err'); }
  await loadRows();
  log(`ArmBioZ dashboard v${APP_VERSION} ready${S.dev ? ` (last device: ${S.dev})` : ''}`);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => log(`SW: ${e.message}`, 'warn'));
  }
}

if (typeof window !== 'undefined') window.addEventListener('DOMContentLoaded', main);
if (typeof module !== 'undefined') module.exports = { crc16, crc32, parseRecord, encodeRecord, derive, median };
