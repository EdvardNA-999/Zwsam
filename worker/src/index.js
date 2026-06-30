// Zeus WASM Worker — Lightweight JS bridge
// Heavy logic (VLESS parsing, DNS encoding, byte manipulation) lives in WASM

import wasmInit, {
  parse_vless_header,
  extract_uuid,
  validate_uuid,
  encode_dns_query,
  parse_dns_response,
  build_vless_response,
  bytes_to_hex,
  generate_vless_link,
  generate_sub_userinfo,
  TrafficCounter,
} from '../wasm/zeus_wasm_core.js';

import { connect } from 'cloudflare:sockets';

// ============================================================
// WASM initialization
// ============================================================
let wasmReady = false;
let trafficCounter = null;

async function ensureWasm() {
  if (!wasmReady) {
    await wasmInit();
    trafficCounter = new TrafficCounter();
    wasmReady = true;
  }
}

// ============================================================
// Constants
// ============================================================
const WS_PATH = '/In_Panel_Rayeghan_Ast_Va_Gheyre_Ghabele_Foroosh';
const DNS_CACHE_TTL = 5 * 60 * 1000;
const DOH_RESOLVER = 'https://cloudflare-dns.com/dns-query';
const UPSTREAM_BUNDLE_TARGET_BYTES = 16 * 1024;
const UPSTREAM_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
const UPSTREAM_QUEUE_MAX_ITEMS = 4096;
const DOWNSTREAM_GRAIN_BYTES = 32 * 1024;
const DOWNSTREAM_GRAIN_TAIL_THRESHOLD = 512;
const DOWNSTREAM_GRAIN_SILENT_MS = 1;
const TCP_CONCURRENCY = 2;

// ============================================================
// Global state (in-memory, per-isolate)
// ============================================================
const GLOBAL_TRAFFIC_CACHE = new Map();
const ACTIVE_CONNECTIONS_COUNT = new Map();
const GLOBAL_LAST_ACTIVE_WRITE = new Map();
const GLOBAL_LAST_DB_WRITE = new Map();
const GLOBAL_WRITE_LOCK = new Map();
const DNS_CACHE = new Map();
const USER_REQ_CACHE = new Map();
let GLOBAL_REQ_COUNT = 0;
let GLOBAL_LAST_REQ_WRITE = 0;

// ============================================================
// Main fetch handler
// ============================================================
export default {
  async fetch(request, env, ctx) {
    await ensureWasm();
    trackRequest(env, ctx);
    await DbService.ensureSchema(env.DB);
    const url = new URL(request.url);

    if (isWebSocketUpgrade(request) && url.pathname === WS_PATH) {
      return await handleWebSocket(request, env, ctx);
    }

    if (url.pathname.startsWith('/sub/') || url.pathname.startsWith('/feed/')) {
      return await handleSubscription(url, env);
    }

    if (url.pathname.startsWith('/api/') || url.pathname === '/locations') {
      return await handleApi(request, url, env, ctx);
    }

    if (url.pathname === '/panel' || url.pathname === '/login') {
      return await handlePanel(request, env);
    }

    if (url.pathname.startsWith('/status/')) {
      return await handleUserStatus(url, env);
    }

    return new Response(HTML_TEMPLATES.nginx, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};

// ============================================================
// WebSocket upgrade detection
// ============================================================
function isWebSocketUpgrade(request) {
  return (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';
}

// ============================================================
// Request tracking
// ============================================================
function trackRequest(env, ctx) {
  GLOBAL_REQ_COUNT++;
  const now = Date.now();
  if (now - GLOBAL_LAST_REQ_WRITE > 15000 && GLOBAL_REQ_COUNT > 0) {
    GLOBAL_LAST_REQ_WRITE = now;
    const countToSave = GLOBAL_REQ_COUNT;
    GLOBAL_REQ_COUNT = 0;
    const task = async () => {
      try {
        const today = new Date().toISOString().split('T')[0];
        await env.DB.prepare(
          "INSERT INTO settings (key, value) VALUES ('req_total', ?) ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ?"
        ).bind(String(countToSave), String(countToSave)).run();
        const lastDateRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'req_last_date'").first();
        if (!lastDateRow || lastDateRow.value !== today) {
          await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('req_last_date', ?) ON CONFLICT(key) DO UPDATE SET value = ?").bind(today, today).run();
          await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('req_today', ?) ON CONFLICT(key) DO UPDATE SET value = ?").bind(String(countToSave), String(countToSave)).run();
        } else {
          await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('req_today', ?) ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ?").bind(String(countToSave), String(countToSave)).run();
        }
      } catch (e) {}
    };
    ctx.waitUntil(task());
  }
}

// ============================================================
// Database Service
// ============================================================
let schemaEnsured = false;
let cachedPanelPassword = null;

const DbService = {
  async ensureSchema(db) {
    if (schemaEnsured) return;
    try {
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE,
          uuid TEXT,
          limit_gb REAL,
          expiry_days INTEGER,
          ips TEXT,
          connection_type TEXT,
          tls TEXT,
          port INTEGER,
          used_gb REAL DEFAULT 0,
          is_active INTEGER DEFAULT 1,
          last_active INTEGER,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `).run();
    } catch (e) {}
    for (const col of [
      'is_active INTEGER DEFAULT 1',
      'last_active INTEGER',
      "fingerprint TEXT DEFAULT 'chrome'",
      'max_connections INTEGER',
      'limit_req INTEGER',
      'used_req INTEGER DEFAULT 0',
    ]) {
      try { await db.prepare(`ALTER TABLE users ADD COLUMN ${col}`).run(); } catch (e) {}
    }
    try { await db.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)').run(); } catch (e) {}
    schemaEnsured = true;
  },

  async getPanelPassword(db) {
    if (cachedPanelPassword !== null) return cachedPanelPassword;
    try {
      const row = await db.prepare("SELECT value FROM settings WHERE key = 'panel_password'").first();
      cachedPanelPassword = row ? row.value : '';
      return cachedPanelPassword || null;
    } catch (e) {
      return null;
    }
  },

  async setPanelPassword(db, password) {
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('panel_password', ?)").bind(password).run();
    cachedPanelPassword = password;
  },

  async verifyApiAuth(request, env) {
    const storedPasswordHash = await this.getPanelPassword(env.DB);
    if (!storedPasswordHash) return true;
    const cookies = request.headers.get('Cookie') || '';
    const sessionCookie = cookies.split(';').find(c => c.trim().startsWith('panel_session='));
    if (!sessionCookie) return false;
    return sessionCookie.split('=')[1].trim() === storedPasswordHash;
  },

  async sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  },
};

// ============================================================
// VLESS Core Engine — uses WASM for parsing
// ============================================================
async function handleVLESS(env, storedData, ctx) {
  const socketPair = new WebSocketPair();
  const [clientSock, serverSock] = Object.values(socketPair);
  serverSock.accept();
  serverSock.binaryType = 'arraybuffer';

  let username = null;
  let tickCount = 0;
  let validUUID = null;

  function addBytes(bytes) {
    if (bytes <= 0 || !username) return;
    let current = GLOBAL_TRAFFIC_CACHE.get(username) || 0;
    GLOBAL_TRAFFIC_CACHE.set(username, current + bytes);
    GLOBAL_LAST_ACTIVE_WRITE.set(username, Date.now());
    if (GLOBAL_WRITE_LOCK.get(username)) return;

    let lastDbWrite = GLOBAL_LAST_DB_WRITE.get(username) || 0;
    const now = Date.now();
    const thresholdBytes = 10 * 1024 * 1024;

    if (current >= thresholdBytes || (current > 0 && now - lastDbWrite > 60000)) {
      GLOBAL_WRITE_LOCK.set(username, true);
      let toCommit = GLOBAL_TRAFFIC_CACHE.get(username) || 0;
      let toCommitReq = USER_REQ_CACHE.get(username) || 0;
      if (toCommit <= 0 && toCommitReq <= 0) {
        GLOBAL_WRITE_LOCK.set(username, false);
        return;
      }
      GLOBAL_TRAFFIC_CACHE.set(username, 0);
      USER_REQ_CACHE.set(username, 0);
      GLOBAL_LAST_DB_WRITE.set(username, now);
      const deltaGb = toCommit / (1024 * 1024 * 1024);
      const writeTask = async () => {
        try {
          await env.DB.prepare('UPDATE users SET used_gb = used_gb + ?, used_req = used_req + ? WHERE username = ?')
            .bind(deltaGb, toCommitReq, username).run();
        } catch (e) {}
        finally { GLOBAL_WRITE_LOCK.set(username, false); }
      };
      ctx.waitUntil(writeTask());
    }
  }

  let isOfflineSet = false;
  const setOffline = () => {
    if (isOfflineSet) return;
    isOfflineSet = true;
    const uname = username;
    if (!uname) return;
    let activeCount = ACTIVE_CONNECTIONS_COUNT.get(uname) || 1;
    activeCount -= 1;
    if (activeCount <= 0) {
      ACTIVE_CONNECTIONS_COUNT.delete(uname);
      let cachedBytes = GLOBAL_TRAFFIC_CACHE.get(uname) || 0;
      let cachedReqs = USER_REQ_CACHE.get(uname) || 0;
      if ((cachedBytes > 0 || cachedReqs > 0) && !GLOBAL_WRITE_LOCK.get(uname)) {
        GLOBAL_WRITE_LOCK.set(uname, true);
        GLOBAL_TRAFFIC_CACHE.set(uname, 0);
        USER_REQ_CACHE.set(uname, 0);
        const deltaGb = cachedBytes / (1024 * 1024 * 1024);
        const writeTask = async () => {
          try {
            await env.DB.prepare('UPDATE users SET used_gb = used_gb + ?, used_req = used_req + ? WHERE username = ?')
              .bind(deltaGb, cachedReqs, uname).run();
          } catch (e) {}
          finally { GLOBAL_WRITE_LOCK.set(uname, false); }
        };
        ctx.waitUntil(writeTask());
      }
    } else {
      ACTIVE_CONNECTIONS_COUNT.set(uname, activeCount);
    }
  };

  const heartbeat = setInterval(async () => {
    if (serverSock.readyState !== WebSocket.OPEN) { clearInterval(heartbeat); return; }
    try {
      serverSock.send(new Uint8Array(0));
      if (!validUUID) return;
      tickCount++;
      if (tickCount >= 1) {
        tickCount = 0;
        const user = await env.DB.prepare(
          'SELECT is_active, limit_gb, used_gb, limit_req, used_req, expiry_days, created_at FROM users WHERE uuid = ?'
        ).bind(validUUID).first();

        let isExpired = false;
        if (!user || user.is_active === 0) {
          isExpired = true;
        } else {
          if (user.limit_gb && user.used_gb >= user.limit_gb) isExpired = true;
          if (user.limit_req && (user.used_req + (USER_REQ_CACHE.get(username) || 0)) >= user.limit_req) isExpired = true;
          if (user.expiry_days && user.created_at) {
            const created = new Date(user.created_at);
            const expiryDate = new Date(created.getTime() + user.expiry_days * 86400000);
            if (new Date() > expiryDate) isExpired = true;
          }
        }

        if (isExpired) {
          await env.DB.prepare('UPDATE users SET is_active = 0, last_active = 0 WHERE uuid = ?').bind(validUUID).run();
          clearInterval(heartbeat);
          closeQuietly(serverSock);
          return;
        }

        const now = Date.now();
        const lastRecorded = GLOBAL_LAST_ACTIVE_WRITE.get(username) || 0;
        if (now - lastRecorded > 15000) {
          GLOBAL_LAST_ACTIVE_WRITE.set(username, now);
          await env.DB.prepare('UPDATE users SET last_active = ? WHERE username = ?').bind(now, username).run();
        }
      }
    } catch (e) {}
  }, 15000);

  let remoteConnWrapper = { socket: null, connectingPromise: null, retryConnect: null };
  let reqUUID = null;
  let isHeaderParsed = false;
  let isDnsQuery = false;
  let chunkBuffer = new Uint8Array(0);
  const proxyIP = storedData?.proxy_ip || 'proxyip.cmliussss.net';

  let wsChain = Promise.resolve();
  let wsStopped = false, wsFailed = false, wsFinished = false;
  let wsQueueBytes = 0, wsQueueItems = 0;
  let currentSocketWriter = null, activeRemoteWriter = null;

  const releaseRemoteWriter = () => {
    if (activeRemoteWriter) { try { activeRemoteWriter.releaseLock(); } catch (e) {} activeRemoteWriter = null; }
    currentSocketWriter = null;
  };

  const getRemoteWriter = () => {
    const s = remoteConnWrapper.socket;
    if (!s) return null;
    if (s !== currentSocketWriter) { releaseRemoteWriter(); currentSocketWriter = s; activeRemoteWriter = s.writable.getWriter(); }
    return activeRemoteWriter;
  };

  const upstreamQueue = createUpstreamQueue({
    getWriter: getRemoteWriter,
    releaseWriter: releaseRemoteWriter,
    retryConnect: async () => { if (typeof remoteConnWrapper.retryConnect === 'function') await remoteConnWrapper.retryConnect(); },
    closeConnection: () => { try { remoteConnWrapper.socket?.close(); } catch (e) {} closeQuietly(serverSock); },
    name: 'VlessWSQueue',
  });

  const writeToRemote = async (chunk, allowRetry = true) => upstreamQueue.writeAndAwait(chunk, allowRetry);

  const processWsMessage = async (chunk) => {
    const bytes = chunk.byteLength || 0;
    addBytes(bytes);

    if (isDnsQuery) {
      await forwardVlessUDP(chunk, serverSock, null, addBytes);
      return;
    }

    if (await writeToRemote(chunk)) return;

    if (!isHeaderParsed) {
      chunkBuffer = concatBytes(chunkBuffer, chunk);
      if (chunkBuffer.byteLength < 24) return;

      // === WASM-accelerated UUID extraction ===
      reqUUID = extract_uuid(chunkBuffer);
      if (!reqUUID) { serverSock.close(); return; }

      let user = null;
      try { user = await env.DB.prepare('SELECT * FROM users WHERE uuid = ?').bind(reqUUID).first(); } catch (e) {}
      if (!user || user.is_active === 0) { serverSock.close(); return; }
      if (user.limit_gb && user.used_gb >= user.limit_gb) { serverSock.close(); return; }
      if (user.limit_req && (user.used_req + (USER_REQ_CACHE.get(user.username) || 0)) >= user.limit_req) { serverSock.close(); return; }
      if (user.expiry_days && user.created_at) {
        const created = new Date(user.created_at);
        if (new Date() > new Date(created.getTime() + user.expiry_days * 86400000)) {
          try { await env.DB.prepare('UPDATE users SET is_active = 0, last_active = 0 WHERE uuid = ?').bind(reqUUID).run(); } catch (e) {}
          serverSock.close();
          return;
        }
      }

      validUUID = reqUUID;
      username = user.username;
      isHeaderParsed = true;

      USER_REQ_CACHE.set(username, (USER_REQ_CACHE.get(username) || 0) + 1);
      let activeCount = ACTIVE_CONNECTIONS_COUNT.get(username) || 0;
      if (user.max_connections && user.max_connections > 0 && activeCount >= user.max_connections) { serverSock.close(); return; }
      ACTIVE_CONNECTIONS_COUNT.set(username, activeCount + 1);

      if (activeCount === 0) {
        const setOnlineTask = async () => {
          try {
            const now = Date.now();
            GLOBAL_LAST_ACTIVE_WRITE.set(username, now);
            await env.DB.prepare('UPDATE users SET last_active = ? WHERE username = ?').bind(now, username).run();
          } catch (e) {}
        };
        ctx.waitUntil(setOnlineTask());
      }

      // === WASM-accelerated VLESS header parsing ===
      try {
        const header = parse_vless_header(chunkBuffer);
        if (!header) { serverSock.close(); return; }

        const rawData = chunkBuffer.slice(header.raw_data_offset);
        const respHeader = build_vless_response(header.version, 0);

        if (header.command === 2) {
          if (header.port === 53) {
            isDnsQuery = true;
            await forwardVlessUDP(rawData, serverSock, respHeader, addBytes);
          } else {
            serverSock.close();
          }
          return;
        }

        const addr = header.addr;
        const port = header.port;

        const connectTCP = async (dataPayload = null, useFallback = true) => {
          if (remoteConnWrapper.connectingPromise) { await remoteConnWrapper.connectingPromise; return; }
          const task = (async () => {
            let s = null;
            try { s = await connectDirect(addr, port, dataPayload); }
            catch (err) { if (useFallback && proxyIP) s = await connectDirect(proxyIP, port, dataPayload); else throw err; }
            remoteConnWrapper.socket = s;
            s.closed.catch(() => {}).finally(() => closeQuietly(serverSock));
            connectStreams(s, serverSock, respHeader, null, (b) => addBytes(b));
          })();
          remoteConnWrapper.connectingPromise = task;
          try { await task; } finally { if (remoteConnWrapper.connectingPromise === task) remoteConnWrapper.connectingPromise = null; }
        };

        remoteConnWrapper.retryConnect = async () => connectTCP(null, false);
        await connectTCP(rawData, true);
      } catch (e) { serverSock.close(); }
    }
  };

  const handleWsError = (err) => {
    if (wsFailed) return;
    wsFailed = true; wsStopped = true; wsQueueBytes = 0; wsQueueItems = 0;
    upstreamQueue.clear(); releaseRemoteWriter(); closeQuietly(serverSock); setOffline();
  };

  const pushToChain = (task) => { wsChain = wsChain.then(task).catch(handleWsError); };

  serverSock.addEventListener('message', (event) => {
    if (wsStopped || wsFailed) return;
    const size = event.data.byteLength || 0;
    const nextBytes = wsQueueBytes + size;
    const nextItems = wsQueueItems + 1;
    if (nextBytes > UPSTREAM_QUEUE_MAX_BYTES || nextItems > UPSTREAM_QUEUE_MAX_ITEMS) { handleWsError(new Error('ws queue overflow')); return; }
    wsQueueBytes = nextBytes; wsQueueItems = nextItems;
    pushToChain(async () => {
      wsQueueBytes = Math.max(0, wsQueueBytes - size);
      wsQueueItems = Math.max(0, wsQueueItems - 1);
      if (wsFailed) return;
      await processWsMessage(event.data);
    });
  });

  serverSock.addEventListener('close', () => {
    clearInterval(heartbeat); closeQuietly(serverSock); setOffline();
    if (wsFinished) return;
    wsFinished = true; wsStopped = true;
    pushToChain(async () => { if (wsFailed) return; await upstreamQueue.awaitEmpty(); releaseRemoteWriter(); });
  });

  serverSock.addEventListener('error', () => handleWsError(new Error('ws error')));

  return new Response(null, { status: 101, webSocket: clientSock });
}

// ============================================================
// Subscription handler — uses WASM for link generation
// ============================================================
async function handleSubscription(url, env) {
  const isSubPath = url.pathname.startsWith('/sub/');
  const offset = isSubPath ? 5 : 6;
  let subUser = decodeURIComponent(url.pathname.slice(offset));
  const host = url.hostname;
  const isJson = !isSubPath && subUser.startsWith('json/');
  if (isJson) subUser = subUser.slice(5);

  try {
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? OR uuid = ?').bind(subUser, subUser).first();
    if (!user || user.connection_type !== 'vless') return new Response('Not Found', { status: 404 });

    if (isJson) return await generateJsonSub(user, host, env);
    return await generateTextSub(user, host, env);
  } catch (err) {
    return new Response('Error: ' + err.message, { status: 500 });
  }
}

async function generateJsonSub(user, host, env) {
  let ips = [host];
  if (user.ips) {
    const parsed = user.ips.split('\n').map(s => s.trim()).filter(s => s.length > 0);
    if (parsed.length > 0) ips = parsed;
  }
  const ports = String(user.port || '443').split(',').map(s => s.trim()).filter(s => s.length > 0);
  const fp = user.fingerprint || 'chrome';

  let fragLen = '20-30', fragInt = '1-2';
  try {
    const rowLen = await env.DB.prepare("SELECT value FROM settings WHERE key = 'frag_len'").first();
    if (rowLen?.value) fragLen = rowLen.value;
    const rowInt = await env.DB.prepare("SELECT value FROM settings WHERE key = 'frag_int'").first();
    if (rowInt?.value) fragInt = rowInt.value;
  } catch (e) {}

  const configArray = [];

  // Fake decoy configs
  for (const remark of [
    decodeURIComponent('%E2%9A%A0%EF%B8%8F%D8%A7%DB%8C%D9%86%20%D9%BE%D9%86%D9%84%20%D8%B1%D8%A7%DB%8C%DA%AF%D8%A7%D9%86%20%D9%88%20%D8%BA%DB%8C%D8%B1%20%D9%82%D8%A7%D8%A8%D9%84%20%D9%81%D8%B1%D9%88%D8%B4%20%D8%A7%D8%B3%D8%AA%E2%9A%A0%EF%B8%8F'),
    decodeURIComponent('%E2%99%A8%EF%B8%8F%20%40IR_NETLIFY%20%D8%B3%D8%A7%D8%AE%D8%AA%20%D8%B1%D8%A7%DB%8C%DA%AF%D8%A7%D9%86%20%E2%99%A8%EF%B8%8F'),
  ]) {
    configArray.push(buildVlessConfig(remark, user.uuid, '0.0.0.0', 1, host, 'none', fp, ''));
  }

  // Real configs
  for (const ip of ips) {
    for (const portStr of ports) {
      const isTlsPort = ['443', '2053', '2083', '2087', '2096', '8443'].includes(portStr);
      const tlsVal = isTlsPort ? 'tls' : 'none';
      const remark = `${user.username} | ${ip} | ${portStr}`;
      configArray.push(buildVlessConfig(remark, user.uuid, ip, parseInt(portStr), host, tlsVal, fp, fragLen, fragInt));
    }
  }

  const subInfo = generate_sub_userinfo(user.used_gb || 0, user.limit_gb || 0, user.expiry_days || 0, user.created_at || '');

  return new Response(JSON.stringify(configArray, null, 2), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Subscription-Userinfo': subInfo,
    },
  });
}

async function generateTextSub(user, host, env) {
  let ips = [host];
  if (user.ips) {
    const parsed = user.ips.split('\n').map(s => s.trim()).filter(s => s.length > 0);
    if (parsed.length > 0) ips = parsed;
  }
  const ports = String(user.port || '443').split(',').map(s => s.trim()).filter(s => s.length > 0);
  const fp = user.fingerprint || 'chrome';

  const links = [];

  // WASM-generated links
  for (const remark of [
    decodeURIComponent('%E2%9A%A0%EF%B8%8F%D8%A7%DB%8C%D9%86%20%D9%BE%D9%86%D9%84%20%D8%B1%D8%A7%DB%8C%DA%AF%D8%A7%D9%86%20%D9%88%20%D8%BA%DB%8C%D8%B1%20%D9%82%D8%A7%D8%A8%D9%84%20%D9%81%D8%B1%D9%88%D8%B4%20%D8%A7%D8%B3%D8%AA%E2%9A%A0%EF%B8%8F'),
    decodeURIComponent('%E2%99%A8%EF%B8%8F%20%40IR_NETLIFY%20%D8%B3%D8%A7%D8%AE%D8%AA%20%D8%B1%D8%A7%DB%8C%DA%AF%D8%A7%D9%86%20%E2%99%A8%EF%B8%8F'),
  ]) {
    links.push(generate_vless_link(user.uuid, '0.0.0.0', 1, host, WS_PATH, 'none', 'none', remark));
  }

  for (const ip of ips) {
    for (const portStr of ports) {
      const isTlsPort = ['443', '2053', '2083', '2087', '2096', '8443'].includes(portStr);
      const tlsVal = isTlsPort ? 'tls' : 'none';
      const remark = `${user.username} | ${ip} | ${portStr}`;
      links.push(generate_vless_link(user.uuid, ip, parseInt(portStr), host, WS_PATH, tlsVal, fp, remark));
    }
  }

  const noise = [
    '# System Update Feed: OK',
    '# Sync Code: ' + Math.random().toString(36).slice(2, 10),
    '# Version: 2.10.1',
    '# Description: Secure Node Configurations',
    '',
  ].join('\n');

  const plainContent = noise + links.join('\n');
  const subContent = btoa(unescape(encodeURIComponent(plainContent)));
  const subInfo = generate_sub_userinfo(user.used_gb || 0, user.limit_gb || 0, user.expiry_days || 0, user.created_at || '');

  return new Response(subContent, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Subscription-Userinfo': subInfo,
    },
  });
}

function buildVlessConfig(remark, uuid, address, port, host, security, fp, fragLen, fragInt) {
  const isTls = security === 'tls';
  const out = {
    protocol: 'vless',
    settings: { vnext: [{ address, port, users: [{ id: uuid, encryption: 'none' }] }] },
    streamSettings: {
      network: 'ws',
      wsSettings: { host, path: WS_PATH },
      security,
    },
    tag: 'proxy',
  };
  if (isTls) {
    out.streamSettings.tlsSettings = { serverName: host, fingerprint: fp, alpn: ['http/1.1'], allowInsecure: false };
    out.streamSettings.sockopt = { dialerProxy: 'fragment' };
  }

  const config = {
    remarks: remark,
    version: { min: '25.10.15' },
    log: { loglevel: 'none' },
    dns: {
      servers: [
        { address: 'https://8.8.8.8/dns-query', tag: 'remote-dns' },
        { address: '8.8.8.8', domains: ['full:' + host], skipFallback: true },
      ],
      queryStrategy: 'UseIP',
      tag: 'dns',
    },
    inbounds: [
      { listen: '127.0.0.1', port: 10808, protocol: 'socks', settings: { auth: 'noauth', udp: true }, sniffing: { destOverride: ['http', 'tls'], enabled: true, routeOnly: true }, tag: 'mixed-in' },
      { listen: '127.0.0.1', port: 10853, protocol: 'dokodemo-door', settings: { address: '1.1.1.1', network: 'tcp,udp', port: 53 }, tag: 'dns-in' },
    ],
    outbounds: [
      out,
      { protocol: 'dns', settings: { nonIPQuery: 'reject' }, tag: 'dns-out' },
      { protocol: 'freedom', settings: { domainStrategy: 'UseIP' }, tag: 'direct' },
      { protocol: 'blackhole', settings: { response: { type: 'http' } }, tag: 'block' },
    ],
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [
        { inboundTag: ['mixed-in'], port: 53, outboundTag: 'dns-out', type: 'field' },
        { inboundTag: ['dns-in'], outboundTag: 'dns-out', type: 'field' },
        { domain: ['geosite:private'], outboundTag: 'direct', type: 'field' },
        { ip: ['geoip:private'], outboundTag: 'direct', type: 'field' },
        { network: 'udp', outboundTag: 'block', type: 'field' },
        { network: 'tcp', outboundTag: 'proxy', type: 'field' },
      ],
    },
  };

  if (isTls && fragLen) {
    config.outbounds.push({
      protocol: 'freedom',
      settings: { fragment: { packets: 'tlshello', length: fragLen, interval: fragInt } },
      streamSettings: { sockopt: { domainStrategy: 'UseIP' } },
      tag: 'fragment',
    });
  }

  return config;
}

// ============================================================
// API handlers
// ============================================================
async function handlePanel(request, env) {
  const hasPassword = await DbService.getPanelPassword(env.DB);
  if (!hasPassword) return new Response(HTML_TEMPLATES.setup, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (!(await DbService.verifyApiAuth(request, env))) return new Response(HTML_TEMPLATES.login, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  return new Response(HTML_TEMPLATES.panel, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleUserStatus(url, env) {
  const username = decodeURIComponent(url.pathname.slice(8));
  if (!username) return new Response('Username required', { status: 400 });
  try {
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? OR uuid = ?').bind(username, username).first();
    if (!user) return new Response('Not found', { status: 404 });
    const userJson = JSON.stringify({
      username: user.username, uuid: user.uuid, limit_gb: user.limit_gb, expiry_days: user.expiry_days,
      used_gb: user.used_gb, limit_req: user.limit_req, used_req: user.used_req, is_active: user.is_active,
      online_count: ACTIVE_CONNECTIONS_COUNT.get(user.username) || 0, max_connections: user.max_connections,
      created_at: user.created_at, tls: user.tls, port: user.port, ips: user.ips, fingerprint: user.fingerprint || 'chrome',
    });
    const html = HTML_TEMPLATES.status.replace('/* {{USER_DATA_PLACEHOLDER}} */', `window.statusUser = ${userJson};`);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } catch (err) {
    return new Response('Error: ' + err.message, { status: 500 });
  }
}

async function handleApi(request, url, env, ctx) {
  const hasPassword = await DbService.getPanelPassword(env.DB);

  if (url.pathname === '/api/setup-password' && request.method === 'POST') {
    if (hasPassword) return jsonResponse({ error: 'Already set' }, 400);
    const { password } = await request.json();
    if (!password || password.length < 4) return jsonResponse({ error: 'Min 4 chars' }, 400);
    const hashed = await DbService.sha256(password);
    await DbService.setPanelPassword(env.DB, hashed);
    return jsonResponse({ success: true }, 200, ['panel_session=' + hashed + '; Path=/; HttpOnly; Secure; SameSite=Lax']);
  }

  if (url.pathname === '/api/login' && request.method === 'POST') {
    const { password } = await request.json();
    const hashed = await DbService.sha256(password);
    const stored = await DbService.getPanelPassword(env.DB);
    if (stored === hashed) return jsonResponse({ success: true }, 200, ['panel_session=' + stored + '; Path=/; HttpOnly; Secure; SameSite=Lax']);
    return jsonResponse({ error: 'Wrong password' }, 401);
  }

  if (url.pathname === '/api/logout' && request.method === 'POST') {
    return jsonResponse({ success: true }, 200, ['panel_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax']);
  }

  const authorized = await DbService.verifyApiAuth(request, env);
  if (!authorized) return jsonResponse({ error: 'Unauthorized' }, 401);

  // User management API
  if (url.pathname.startsWith('/api/users')) {
    return await handleUsersApi(request, url, env, ctx);
  }

  // Proxy IP settings
  if (url.pathname === '/api/proxy-ip') {
    if (request.method === 'POST') {
      const { proxy_ip, iata, frag_len, frag_int } = await request.json();
      if (proxy_ip) await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('proxy_ip', ?)").bind(proxy_ip).run();
      if (iata !== undefined) await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('proxy_location_iata', ?)").bind(iata).run();
      if (frag_len !== undefined) await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('frag_len', ?)").bind(frag_len).run();
      if (frag_int !== undefined) await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('frag_int', ?)").bind(frag_int).run();
      return jsonResponse({ success: true });
    }
    if (request.method === 'GET') {
      const rowIp = await env.DB.prepare("SELECT value FROM settings WHERE key = 'proxy_ip'").first();
      const rowIata = await env.DB.prepare("SELECT value FROM settings WHERE key = 'proxy_location_iata'").first();
      const rowLen = await env.DB.prepare("SELECT value FROM settings WHERE key = 'frag_len'").first();
      const rowInt = await env.DB.prepare("SELECT value FROM settings WHERE key = 'frag_int'").first();
      return jsonResponse({
        proxy_ip: rowIp?.value || 'proxyip.cmliussss.net',
        iata: rowIata?.value || '',
        frag_len: rowLen?.value || '20-30',
        frag_int: rowInt?.value || '1-2',
      });
    }
  }

  // Locations
  if (url.pathname === '/locations') {
    try {
      const response = await fetch('https://speed.cloudflare.com/locations', { headers: { Referer: 'https://speed.cloudflare.com/' } });
      return new Response(await response.text(), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  return jsonResponse({ error: 'Not Found' }, 404);
}

async function handleUsersApi(request, url, env, ctx) {
  const pathParts = url.pathname.split('/');
  const isUserAction = pathParts.length > 3;

  if (isUserAction) {
    const username = decodeURIComponent(pathParts.pop());

    if (request.method === 'PUT') {
      const body = await request.json();
      if (body.toggle_only !== undefined) {
        await env.DB.prepare('UPDATE users SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE username = ?').bind(username).run();
        return jsonResponse({ success: true });
      }
      if (body.reset_action !== undefined) {
        if (body.reset_action === 'volume') { await env.DB.prepare('UPDATE users SET used_gb = 0 WHERE username = ?').bind(username).run(); GLOBAL_TRAFFIC_CACHE.set(username, 0); }
        else if (body.reset_action === 'req') { await env.DB.prepare('UPDATE users SET used_req = 0 WHERE username = ?').bind(username).run(); USER_REQ_CACHE.set(username, 0); }
        else if (body.reset_action === 'time') { await env.DB.prepare('UPDATE users SET created_at = CURRENT_TIMESTAMP WHERE username = ?').bind(username).run(); }
        return jsonResponse({ success: true });
      }
      const { username: new_username, limit_gb, expiry_days, limit_req, ips, tls, port, fingerprint, max_connections } = body;
      if (new_username && new_username !== username) {
        const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(new_username).first();
        if (existing) return jsonResponse({ error: 'Username exists' }, 400);
        // Migrate caches
        for (const cache of [GLOBAL_TRAFFIC_CACHE, USER_REQ_CACHE, ACTIVE_CONNECTIONS_COUNT, GLOBAL_LAST_ACTIVE_WRITE]) {
          if (cache.has(username)) { cache.set(new_username, cache.get(username)); cache.delete(username); }
        }
      }
      await env.DB.prepare(
        'UPDATE users SET username = ?, limit_gb = ?, expiry_days = ?, limit_req = ?, ips = ?, tls = ?, port = ?, fingerprint = ?, max_connections = ? WHERE username = ?'
      ).bind(new_username || username, limit_gb ? parseFloat(limit_gb) : null, expiry_days ? parseInt(expiry_days) : null, limit_req ? parseInt(limit_req) : null, ips || null, tls, port, fingerprint || 'chrome', max_connections ? parseInt(max_connections) : null, username).run();
      return jsonResponse({ success: true });
    }

    if (request.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM users WHERE username = ?').bind(username).run();
      return jsonResponse({ success: true });
    }
  } else {
    if (request.method === 'GET') {
      try { await flushExpiredTraffic(env); } catch (e) {}
      const { results } = await env.DB.prepare('SELECT * FROM users ORDER BY id DESC').all();
      const now = Date.now();
      const enrichedUsers = (results || []).map(u => ({
        ...u,
        is_online: u.last_active && now - u.last_active < 65000 ? 1 : 0,
        online_count: ACTIVE_CONNECTIONS_COUNT.get(u.username) || 0,
      }));
      return jsonResponse({ users: enrichedUsers, serverTime: now });
    }

    if (request.method === 'POST') {
      const { username, limit_gb, expiry_days, limit_req, ips, tls, port, fingerprint, max_connections } = await request.json();
      if (!username) return jsonResponse({ error: 'Username required' }, 400);
      const uuid = crypto.randomUUID();
      try {
        await env.DB.prepare(
          'INSERT INTO users (username, uuid, limit_gb, expiry_days, limit_req, ips, connection_type, tls, port, fingerprint, max_connections) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(username, uuid, limit_gb ? parseFloat(limit_gb) : null, expiry_days ? parseInt(expiry_days) : null, limit_req ? parseInt(limit_req) : null, ips || null, 'vless', tls, port, fingerprint || 'chrome', max_connections ? parseInt(max_connections) : null).run();
        return jsonResponse({ success: true });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }
  }
  return jsonResponse({ error: 'Not Found' }, 404);
}

function jsonResponse(data, status = 200, extraHeaders = []) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  const resp = new Response(JSON.stringify(data), { status, headers });
  for (const h of extraHeaders) resp.headers.append('Set-Cookie', h);
  return resp;
}

// ============================================================
// Traffic flush
// ============================================================
async function flushExpiredTraffic(env) {
  const now = Date.now();
  for (const [uname, cachedBytes] of GLOBAL_TRAFFIC_CACHE.entries()) {
    const cachedReqs = USER_REQ_CACHE.get(uname) || 0;
    if (cachedBytes <= 0 && cachedReqs <= 0) continue;
    if (GLOBAL_WRITE_LOCK.get(uname)) continue;
    const lastActive = GLOBAL_LAST_ACTIVE_WRITE.get(uname) || 0;
    const activeCount = ACTIVE_CONNECTIONS_COUNT.get(uname) || 0;
    if (activeCount <= 0 || now - lastActive > 65000) {
      GLOBAL_WRITE_LOCK.set(uname, true);
      GLOBAL_TRAFFIC_CACHE.set(uname, 0);
      USER_REQ_CACHE.set(uname, 0);
      const deltaGb = cachedBytes / (1024 * 1024 * 1024);
      try { await env.DB.prepare('UPDATE users SET used_gb = used_gb + ?, used_req = used_req + ? WHERE username = ?').bind(deltaGb, cachedReqs, uname).run(); } catch (e) {}
      finally { GLOBAL_WRITE_LOCK.set(uname, false); }
    }
  }
}

// ============================================================
// Network utilities
// ============================================================
function isIPv4(value) {
  const parts = String(value || '').split('.');
  return parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && +p >= 0 && +p <= 255);
}

function isIPHostname(hostname = '') {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname.trim();
  if (isIPv4(host)) return true;
  if (!host.includes(':')) return false;
  try { new URL(`http://[${host}]/`); return true; } catch (e) { return false; }
}

function convertToUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data || 0);
}

function concatBytes(...chunks) {
  const arrs = chunks.map(convertToUint8Array);
  const total = arrs.reduce((s, c) => s + c.byteLength, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const c of arrs) { result.set(c, off); off += c.byteLength; }
  return result;
}

function closeQuietly(socket) {
  try { if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) socket.close(); } catch (e) {}
}

async function dohQuery(domain, recordType) {
  const cacheKey = `${domain}:${recordType}`;
  const cached = DNS_CACHE.get(cacheKey);
  if (cached && Date.now() < cached.expires) return cached.data;
  DNS_CACHE.delete(cacheKey);

  try {
    const typeMap = { A: 1, AAAA: 28 };
    const qtype = typeMap[recordType.toUpperCase()] || 1;

    // === WASM-accelerated DNS query encoding ===
    const query = encode_dns_query(domain, qtype);

    const response = await fetch(DOH_RESOLVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/dns-message', Accept: 'application/dns-message' },
      body: new Uint8Array(query),
    });
    if (!response.ok) return [];

    const buf = new Uint8Array(await response.arrayBuffer());

    // === WASM-accelerated DNS response parsing ===
    const ipsJson = parse_dns_response(buf, qtype);
    const ips = JSON.parse(ipsJson);

    const answers = ips.map(ip => ({ name: domain, type: qtype, TTL: 300, data: ip }));
    DNS_CACHE.set(cacheKey, { data: answers, expires: Date.now() + DNS_CACHE_TTL });
    return answers;
  } catch (e) {
    return [];
  }
}

async function buildRaceCandidates(address, port) {
  if (!isIPHostname(address)) {
    const [aRecords, aaaaRecords] = await Promise.all([dohQuery(address, 'A'), dohQuery(address, 'AAAA')]);
    const ipv4 = [...new Set(aRecords.flatMap(r => (r.type === 1 && isIPv4(r.data) ? [r.data] : [])))];
    const ipv6 = [...new Set(aaaaRecords.flatMap(r => (r.type === 28 ? [r.data] : [])))];
    const limit = Math.max(1, TCP_CONCURRENCY);
    const ipList = ipv4.length >= limit ? ipv4.slice(0, limit) : ipv4.concat(ipv6.slice(0, limit - ipv4.length));
    if (ipList.length > 0) return ipList.map((hostname, attempt) => ({ hostname, port, attempt }));
  }
  return null;
}

async function connectDirect(address, port, initialData = null) {
  const raceCandidates = await buildRaceCandidates(address, port);
  const candidates = raceCandidates || Array.from({ length: TCP_CONCURRENCY }, () => ({ hostname: address, port }));

  const openConnection = async (host, prt) => {
    const socket = connect({ hostname: host, port: prt });
    await Promise.race([socket.opened, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1000))]);
    return socket;
  };

  if (candidates.length === 1) {
    const s = await openConnection(candidates[0].hostname, candidates[0].port);
    if (initialData?.byteLength > 0) { const w = s.writable.getWriter(); await w.write(convertToUint8Array(initialData)); w.releaseLock(); }
    return s;
  }

  const attempts = candidates.map(c => openConnection(c.hostname, c.port).then(socket => ({ socket, candidate: c })));
  let winner = null;
  try {
    winner = await Promise.any(attempts);
    if (initialData?.byteLength > 0) { const w = winner.socket.writable.getWriter(); await w.write(convertToUint8Array(initialData)); w.releaseLock(); }
    return winner.socket;
  } finally {
    if (winner) {
      for (const a of attempts) a.then(({ socket }) => { if (socket !== winner.socket) try { socket.close(); } catch (e) {} }).catch(() => {});
    }
  }
}

async function forwardVlessUDP(udpChunk, webSocket, respHeader, onBytes) {
  const requestData = convertToUint8Array(udpChunk);
  try {
    const tcpSocket = connect({ hostname: '8.8.4.4', port: 53 });
    let vlessHeader = respHeader;
    const writer = tcpSocket.writable.getWriter();
    await writer.write(requestData);
    writer.releaseLock();

    await tcpSocket.readable.pipeTo(new WritableStream({
      async write(chunk) {
        const response = convertToUint8Array(chunk);
        if (typeof onBytes === 'function') onBytes(response.byteLength);
        if (webSocket.readyState !== WebSocket.OPEN) return;
        if (vlessHeader) {
          const merged = new Uint8Array(vlessHeader.length + response.byteLength);
          merged.set(vlessHeader, 0);
          merged.set(response, vlessHeader.length);
          webSocket.send(merged.buffer);
          vlessHeader = null;
        } else {
          webSocket.send(response);
        }
      },
    }));
  } catch (e) {}
}

// ============================================================
// Stream connection & upstream queue (unchanged logic)
// ============================================================
function createUpstreamQueue({ getWriter, releaseWriter, retryConnect, closeConnection, name }) {
  let chunks = [], head = 0, queuedBytes = 0, draining = false, closed = false;
  let bundleBuffer = null, idleResolvers = [], activeCompletions = null;

  const settle = (comps, err = null) => { if (comps) for (const c of comps) { if (c) err ? c.reject(err) : c.resolve(); } };
  const rejectQueued = (err) => { for (let i = head; i < chunks.length; i++) if (chunks[i]?.completions) settle(chunks[i].completions, err); };
  const compact = () => { if (head > 32 && head * 2 >= chunks.length) { chunks = chunks.slice(head); head = 0; } };
  const resolveIdle = () => { if (!queuedBytes && !draining && idleResolvers.length) { const r = idleResolvers; idleResolvers = []; for (const fn of r) fn(); } };
  const clear = (err = null) => { const e = err || (closed ? new Error(`${name} closed`) : null); if (e) { rejectQueued(e); settle(activeCompletions, e); activeCompletions = null; } chunks = []; head = 0; queuedBytes = 0; resolveIdle(); };
  const shift = () => { if (head >= chunks.length) return null; const item = chunks[head]; chunks[head++] = undefined; queuedBytes -= item.chunk.byteLength; compact(); return item; };

  const bundle = () => {
    const first = shift(); if (!first) return null;
    if (head >= chunks.length || first.chunk.byteLength >= UPSTREAM_BUNDLE_TARGET_BYTES) return first;
    let byteLength = first.chunk.byteLength, end = head, allowRetry = first.allowRetry, completions = first.completions || null;
    while (end < chunks.length) {
      const next = chunks[end]; const nextLen = byteLength + next.chunk.byteLength;
      if (nextLen > UPSTREAM_BUNDLE_TARGET_BYTES) break;
      byteLength = nextLen; allowRetry = allowRetry && next.allowRetry;
      if (next.completions) completions = completions ? completions.concat(next.completions) : next.completions;
      end++;
    }
    if (end === head) return first;
    const output = (bundleBuffer ||= new Uint8Array(UPSTREAM_BUNDLE_TARGET_BYTES));
    output.set(first.chunk); let offset = first.chunk.byteLength;
    while (head < end) { const next = chunks[head]; chunks[head++] = undefined; queuedBytes -= next.chunk.byteLength; output.set(next.chunk, offset); offset += next.chunk.byteLength; }
    compact();
    return { chunk: output.subarray(0, byteLength), allowRetry, completions };
  };

  const drain = async () => {
    if (draining || closed) return; draining = true;
    try {
      for (;;) {
        if (closed) break; const item = bundle(); if (!item) break;
        let writer = getWriter(); if (!writer) throw new Error(`${name}: no writer`);
        const completions = item.completions || null; activeCompletions = completions;
        try {
          try { await writer.write(item.chunk); } catch (err) {
            releaseWriter?.();
            if (!item.allowRetry || typeof retryConnect !== 'function') throw err;
            await retryConnect(); writer = getWriter(); if (!writer) throw err;
            await writer.write(item.chunk);
          }
          settle(completions);
        } catch (err) { settle(completions, err); throw err; }
        finally { if (activeCompletions === completions) activeCompletions = null; }
      }
    } catch (err) { closed = true; clear(err); try { closeConnection?.(err); } catch (_) {} }
    finally { draining = false; if (!closed && head < chunks.length) queueMicrotask(drain); else resolveIdle(); }
  };

  const enqueue = (data, allowRetry = true, waitForFlush = false) => {
    if (closed || !getWriter()) return false;
    const chunk = convertToUint8Array(data); if (!chunk.byteLength) return true;
    const nextBytes = queuedBytes + chunk.byteLength, nextItems = chunks.length - head + 1;
    if (nextBytes > UPSTREAM_QUEUE_MAX_BYTES || nextItems > UPSTREAM_QUEUE_MAX_ITEMS) {
      closed = true; const err = Object.assign(new Error(`${name}: overflow`), { isQueueOverflow: true });
      clear(err); try { closeConnection?.(err); } catch (_) {} throw err;
    }
    let completionPromise = null, completions = null;
    if (waitForFlush) { completions = []; completionPromise = new Promise((res, rej) => completions.push({ resolve: res, reject: rej })); }
    chunks.push({ chunk, allowRetry, completions }); queuedBytes = nextBytes;
    if (!draining) queueMicrotask(drain);
    return waitForFlush ? completionPromise.then(() => true) : true;
  };

  return { writeAndAwait(d, ar = true) { return enqueue(d, ar, true); }, async awaitEmpty() { if (!queuedBytes && !draining) return; await new Promise(r => idleResolvers.push(r)); }, clear() { closed = true; clear(); } };
}

function createDownstreamSender(webSocket, headerData = null) {
  const packetCap = DOWNSTREAM_GRAIN_BYTES, tailBytes = DOWNSTREAM_GRAIN_TAIL_THRESHOLD;
  const lowWaterBytes = Math.max(4096, tailBytes << 3);
  let header = headerData, pendingBuffer = new Uint8Array(packetCap), pendingBytes = 0;
  let flushTimer = null, microtaskQueued = false, generation = 0, scheduledGeneration = 0, waitRounds = 0, flushPromise = null;

  const sendRaw = async (chunk) => { if (webSocket.readyState !== WebSocket.OPEN) throw new Error('ws closed'); webSocket.send(chunk); };
  const attachHeader = (chunk) => { if (!header) return chunk; const m = new Uint8Array(header.length + chunk.byteLength); m.set(header, 0); m.set(chunk, header.length); header = null; return m; };

  const flush = async () => {
    while (flushPromise) await flushPromise;
    if (flushTimer) clearTimeout(flushTimer); flushTimer = null; microtaskQueued = false;
    if (!pendingBytes) return;
    const output = pendingBuffer.subarray(0, pendingBytes).slice();
    pendingBuffer = new Uint8Array(packetCap); pendingBytes = 0; waitRounds = 0;
    flushPromise = sendRaw(output).finally(() => { flushPromise = null; });
    return flushPromise;
  };

  const scheduleFlush = () => {
    if (flushTimer || microtaskQueued) return; microtaskQueued = true; scheduledGeneration = generation;
    queueMicrotask(() => {
      microtaskQueued = false; if (!pendingBytes || flushTimer) return;
      if (packetCap - pendingBytes < tailBytes) { flush().catch(() => closeQuietly(webSocket)); return; }
      flushTimer = setTimeout(() => {
        flushTimer = null; if (!pendingBytes) return;
        if (packetCap - pendingBytes < tailBytes) { flush().catch(() => closeQuietly(webSocket)); return; }
        if (waitRounds < 2 && (generation !== scheduledGeneration || pendingBytes < lowWaterBytes)) { waitRounds++; scheduledGeneration = generation; scheduleFlush(); return; }
        flush().catch(() => closeQuietly(webSocket));
      }, Math.max(DOWNSTREAM_GRAIN_SILENT_MS, 1));
    });
  };

  return {
    async sendDirect(data) { let chunk = convertToUint8Array(data); if (!chunk.byteLength) return; chunk = attachHeader(chunk); await sendRaw(chunk); },
    async send(data) {
      let chunk = convertToUint8Array(data); if (!chunk.byteLength) return; chunk = attachHeader(chunk);
      let offset = 0; const total = chunk.byteLength;
      while (offset < total) {
        if (!pendingBytes && total - offset >= packetCap) { const n = Math.min(packetCap, total - offset); await sendRaw(offset || n !== total ? chunk.subarray(offset, offset + n) : chunk); offset += n; continue; }
        const copy = Math.min(packetCap - pendingBytes, total - offset);
        pendingBuffer.set(chunk.subarray(offset, offset + copy), pendingBytes); pendingBytes += copy; offset += copy; generation++;
        if (pendingBytes === packetCap || packetCap - pendingBytes < tailBytes) await flush(); else scheduleFlush();
      }
    },
    flush,
  };
}

async function connectStreams(remoteSocket, webSocket, headerData, retryFunc, onBytes) {
  let header = headerData, hasData = false, reader, useBYOB = false;
  const BYOB_LIMIT = 64 * 1024;
  const sender = createDownstreamSender(webSocket, header); header = null;
  try { reader = remoteSocket.readable.getReader({ mode: 'byob' }); useBYOB = true; } catch (e) { reader = remoteSocket.readable.getReader(); }
  try {
    if (!useBYOB) {
      while (true) {
        await waitForBackpressure(webSocket);
        const { done, value } = await reader.read();
        if (done) break; if (!value?.byteLength) continue;
        hasData = true; if (typeof onBytes === 'function') onBytes(value.byteLength);
        await sender.send(value);
      }
    } else {
      let readBuffer = new ArrayBuffer(BYOB_LIMIT);
      while (true) {
        await waitForBackpressure(webSocket);
        const { done, value } = await reader.read(new Uint8Array(readBuffer, 0, BYOB_LIMIT));
        if (done) break; if (!value?.byteLength) continue;
        hasData = true; if (typeof onBytes === 'function') onBytes(value.byteLength);
        if (value.byteLength >= DOWNSTREAM_GRAIN_BYTES) { await sender.flush(); await sender.sendDirect(value); readBuffer = new ArrayBuffer(BYOB_LIMIT); }
        else { await sender.send(value); readBuffer = value.buffer.byteLength >= BYOB_LIMIT ? value.buffer : new ArrayBuffer(BYOB_LIMIT); }
      }
    }
    await sender.flush();
  } catch (err) { closeQuietly(webSocket); }
  finally { try { reader.cancel(); } catch (e) {} try { reader.releaseLock(); } catch (e) {} }
  if (!hasData && retryFunc) await retryFunc();
}

async function waitForBackpressure(ws) {
  if (typeof ws.bufferedAmount === 'number') {
    while (ws.bufferedAmount > 256 * 1024) await new Promise(r => setTimeout(r, 100));
  }
}

// ============================================================
// HTML Templates (minimal placeholders — full UI unchanged)
// ============================================================
const HTML_TEMPLATES = {
  nginx: `<!DOCTYPE html><html><body><p>Visit <a href="/panel">/panel</a></p></body></html>`,
  setup: `<!DOCTYPE html><html><body><h2>Setup</h2></body></html>`,
  login: `<!DOCTYPE html><html><body><h2>Login</h2></body></html>`,
  panel: `<!DOCTYPE html><html><body><h2>Panel</h2></body></html>`,
  status: `<!DOCTYPE html><html><body><h2>Status</h2><script>/* {{USER_DATA_PLACEHOLDER}} */</script></body></html>`,
};
