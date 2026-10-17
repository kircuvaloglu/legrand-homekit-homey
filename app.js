const Homey = require('homey');
// Import the IP transport directly instead of the package root:
// require('hap-controller') eagerly loads its BLE discovery -> @abandonware/noble ->
// native bluetooth bindings, which crashes on hosts without a compiled binding.
// The deep path keeps this app 100% IP-only and removes the noble dependency at runtime.
const HttpClient = require('hap-controller/lib/transport/ip/http-client').default;

let appInstance = null;

// Verbose HAP diagnostics — toggled from the app settings page ("debugLogs").
let HAP_DEBUG = false;
function dbg(...args) {
  if (HAP_DEBUG) console.log(...args);
}
function setHapDebug(enabled) {
  HAP_DEBUG = !!enabled;
}

// In-memory ring buffer of recent HAP traffic decisions (events, subscriptions, connection state).
// Readable via the app API (GET /api/app/com.legrand.homekit.local/diagnostics) — app installs that
// don't stream logs (store / devkit install) can still be diagnosed.
const DIAG_MAX = 1000;
const diagLog = [];
function diag(line) {
  diagLog.push(`${new Date().toISOString()} ${line}`);
  if (diagLog.length > DIAG_MAX) diagLog.shift();
}
function preview(buf, max = 300) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  return (s.length > max ? `${s.slice(0, max)}…` : s).replace(/\r\n/g, '\\r\\n');
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const norm = (v) => {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const lower = v.toLowerCase().trim();
      if (lower === '') return `str:${v}`; // Number('') === 0; empty string must never equal 0/false
      if (lower === 'true' || lower === 'yes' || lower === 'on') return 1;
      if (lower === 'false' || lower === 'no' || lower === 'off') return 0;
      const num = Number(lower);
      if (!isNaN(num)) return num;
    }
    return v;
  };
  return norm(a) === norm(b);
}

function getConnByIp(ip) {
  if (!appInstance || !appInstance.gateways) return null;
  for (const conn of appInstance.gateways.values()) {
    if (conn.ip === ip) {
      return conn;
    }
  }
  return null;
}

function parseCharacteristicsFromRequest(requestBuffer) {
  const str = requestBuffer.toString('utf8');
  const jsonStartIndex = str.indexOf('{');
  if (jsonStartIndex >= 0) {
    try {
      const bodyObj = JSON.parse(str.slice(jsonStartIndex));
      if (bodyObj && Array.isArray(bodyObj.characteristics)) {
        return bodyObj.characteristics;
      }
    } catch (err) {
      console.error('[HAP Parse Request] Failed to parse characteristics from JSON:', err.message);
    }
  }
  return [];
}

// HAP status -70402: "unable to communicate with the requested service". On Legrand gateways this is
// usually a transient radio hiccup towards the end device; the write layer retries those once.
const HAP_STATUS_COMMUNICATION_FAILURE = -70402;

async function performHAPRecovery(conn, aid, iid) {
  if (!conn) return;
  const key = `${aid}.${iid}`;
  console.warn(`[HAP Recovery] Detected write failure/timeout for ${conn.gatewayId} - ${key}. Clearing anti-bounce and fetching physical state...`);

  if (conn.lastWrites) {
    delete conn.lastWrites[key];
  }

  // Without a live session there is nothing to fetch; the next (re)connect does a full state sync.
  if (!conn.client || !conn.isConnected) return;

  try {
    const response = await conn.client.getCharacteristics([key]);
    if (response && Array.isArray(response.characteristics)) {
      console.log(`[HAP Recovery] Fetched actual state for ${key}:`, JSON.stringify(response.characteristics));
      if (appInstance) {
        appInstance.onHAPEvent(conn.gatewayId, response);
      }
    }
  } catch (err) {
    console.error(`[HAP Recovery] Failed to fetch characteristics for recovery:`, err.message);
  }
}

function handleRealWriteResponse(address, requestBuffer, response) {
  const conn = getConnByIp(address);
  if (!conn) {
    console.warn(`[HAP Recovery] No active connection found for IP ${address}`);
    return;
  }
  
  const requestedChars = parseCharacteristicsFromRequest(requestBuffer);
  if (requestedChars.length === 0) return;
  
  const statusCode = response.statusCode;
  let failedChars = [];
  
  if (statusCode !== 204 && statusCode !== 207) {
    console.warn(`[HAP Recovery] Write failed with status ${statusCode} for connection ${conn.gatewayId}. Recovering all...`);
    failedChars = requestedChars;
  } else if (statusCode === 207) {
    let respBody;
    try {
      respBody = JSON.parse(response.body.toString('utf8'));
    } catch (e) {
      console.error(`[HAP Recovery] Failed to parse response body:`, e.message);
    }
    
    if (respBody && Array.isArray(respBody.characteristics)) {
      for (const charStatus of respBody.characteristics) {
        // -70402 is retried by flushWriteQueue(); recovering here would flip the UI back mid-retry.
        if (charStatus.status === HAP_STATUS_COMMUNICATION_FAILURE) continue;
        if (charStatus.status !== undefined && charStatus.status !== 0) {
          console.warn(`[HAP Recovery] Characteristic ${charStatus.aid}.${charStatus.iid} write failed with status ${charStatus.status}`);
          failedChars.push(charStatus);
        }
      }
    }
  }
  
  for (const char of failedChars) {
    performHAPRecovery(conn, char.aid, char.iid).catch(err => {
      console.error(`[HAP Recovery] Error in performHAPRecovery:`, err.message);
    });
  }
}

function handleWriteTimeout(address, requestBuffer) {
  const conn = getConnByIp(address);
  if (!conn || !conn.lastWrites) return;

  // A timed-out request kills its session (see sendRequest), so a state fetch is impossible here.
  // Just drop the anti-bounce entries; the reconnect performs a full state sync.
  for (const char of parseCharacteristicsFromRequest(requestBuffer)) {
    delete conn.lastWrites[`${char.aid}.${char.iid}`];
  }
}

// Global HAP HttpConnection patches for robust event parsing & diagnostics
global.hapPutLogs = [];
try {
  // These patches reach into hap-controller internals and are only verified against 0.7.x.
  // Refuse to apply them to another version instead of silently corrupting traffic.
  const hcVersion = require('hap-controller/package.json').version;
  if (!/^0\.7\./.test(hcVersion)) {
    console.error(`[HAP Patch] hap-controller ${hcVersion} detected — patches are only verified against 0.7.x, not applying them.`);
    throw new Error(`Unsupported hap-controller version ${hcVersion} for internal patches`);
  }

  const libsodium = require('libsodium-wrappers');
  const HttpEventParser = require('hap-controller/lib/transport/ip/http-event-parser').default;
  const HttpConnection = require('hap-controller/lib/transport/ip/http-connection').default;
  const net = require('net');

  // Warm up libsodium once at startup so the hot request path never waits for WASM init
  libsodium.ready.catch(() => {});

  const REQUEST_TIMEOUT_MS = 10000;

  // Rejects every request still waiting on this connection. Without this, a gateway that resets the
  // socket (ECONNRESET) left the pending request hanging until its 10s timeout.
  function failPendingRequests(connection, err) {
    const pending = connection._pendingRequests;
    if (!pending || pending.size === 0) return;
    connection._pendingRequests = new Set();
    for (const entry of pending) entry.fail(err);
  }

  function destroySocket(connection) {
    if (connection.socket) {
      try { connection.socket.destroy(); } catch (e) {}
    }
  }

  // Shared request path for clear (pair-verify) and encrypted traffic.
  function sendRequest(connection, data, encrypted) {
    const isWrite = data.toString('binary', 0, 25).includes('PUT /characteristics') && data.toString('binary').includes('"value"');
    return new Promise((resolve, reject) => {
      if (!connection.socket) {
        return reject(new Error('Socket is not initialized'));
      }
      if (!connection._responseParsersQueue) connection._responseParsersQueue = [];
      if (!connection._pendingRequests) connection._pendingRequests = new Set();

      let settled = false;
      let parser = null;
      const entry = {};

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        connection._pendingRequests.delete(entry);
        const idx = connection._responseParsersQueue.indexOf(parser);
        if (idx >= 0) connection._responseParsersQueue.splice(idx, 1);
      };

      entry.fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        entry.fail(new Error(`HAP ${encrypted ? 'encrypted' : 'clear'} request timeout (${REQUEST_TIMEOUT_MS}ms)`));
        // A late response would be routed to the NEXT request's parser (FIFO queue) and the
        // session is in an unknown state anyway: drop it so the owner reconnects with a fresh one.
        destroySocket(connection);
        if (isWrite) {
          try {
            handleWriteTimeout(connection.address, data);
          } catch (e) {
            console.error('[HAP] Error handling write timeout:', e.message);
          }
        }
      }, REQUEST_TIMEOUT_MS);

      parser = connection._buildHttpResponseParser((response) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (isWrite && response) {
          try {
            handleRealWriteResponse(connection.address, data, response);
          } catch (e) {
            console.error('[HAP] Error handling real write response:', e.message);
          }
        }
        resolve(response);
      });

      connection._responseParsersQueue.push(parser);
      connection._pendingRequests.add(entry);

      try {
        connection.socket.write(encrypted ? connection._encryptData(data) : data);
      } catch (err) {
        entry.fail(err);
      }
    });
  }

  // Intercept put requests to /characteristics for pairing audit
  const originalPut = HttpConnection.prototype.put;
  HttpConnection.prototype.put = async function(path, body, contentType, readEvents) {
    const response = await originalPut.call(this, path, body, contentType, readEvents);
    if (HAP_DEBUG && path === '/characteristics') {
      let bodyStr = '';
      if (response && response.body) {
        bodyStr = response.body.toString();
      }
      const logMsg = `[${new Date().toISOString()}] [HAP HTTP PUT /characteristics] Request: ${body ? body.toString() : ''} -> Status: ${response.statusCode}, Body: ${bodyStr}`;
      if (global.hapPutLogs) {
        global.hapPutLogs.push(logMsg);
      }
      console.log(logMsg);
    }
    return response;
  };

  // Override _open with connection timeout support and single permanent data listener
  HttpConnection.prototype._open = async function() {
    if (this.state === 2) { // READY
      return;
    } else if (this.state !== 0 && this.socket) { // not CLOSED
      try { this.socket.destroy(); } catch(e) {}
    }

    return new Promise((resolve, reject) => {
      this.state = 0; // CLOSED
      let connectTimeout = setTimeout(() => {
        if (this.socket) {
          try { this.socket.destroy(); } catch(e) {}
        }
        reject(new Error(`TCP connection timeout to ${this.address}:${this.port}`));
      }, 5000); // 5s connection timeout

      try {
        // Capture the socket in a closure: when this connection is re-opened, late 'close'/'end'/
        // 'timeout' events of the old socket must not touch the state of the new one.
        const sock = net.createConnection(this.port, this.address);
        this.socket = sock;
        sock.setKeepAlive(true);
        sock.setNoDelay(true);

        this._decryptedBuffer = Buffer.alloc(0);
        this._encryptedBuffer = Buffer.alloc(0);
        this._lastSocketError = null;

        if (!this._eventParser) {
          this._eventParser = new HttpEventParser();
          this._eventParser.on('event', (ev) => {
            dbg(`[HAP Event Interceptor] Parsed Event body:`, ev.toString());
            this.emit('event', ev);
          });
        }

        sock.on('data', (chunk) => {
          if (this.socket !== sock) return; // stale socket
          if (this.sessionKeys) {
            this._decryptAndAppend(chunk);
          } else {
            this._decryptedBuffer = Buffer.concat([this._decryptedBuffer, chunk]);
          }
          this.processDecryptedBuffer();
        });

        sock.on('close', () => {
          if (this.socket !== sock) return; // stale socket — ignore late close
          this.socket = null;
          this.state = 0; // CLOSED
          this._responseParsersQueue = [];
          const reason = this._lastSocketError ? ` (${this._lastSocketError})` : '';
          failPendingRequests(this, new Error(`Connection closed by ${this.address}:${this.port}${reason}`));
          this.emit('disconnect', {});
        });

        sock.on('end', () => {
          if (this.socket !== sock) return;
          this.state = 3; // CLOSING
          try { sock.end(); } catch(e) {}
        });

        sock.on('timeout', () => {
          if (this.socket !== sock) return;
          this.state = 3; // CLOSING
          try { sock.end(); } catch(e) {}
        });

        sock.on('error', (err) => {
          console.error(`[HAP Socket Error ${this.address}:${this.port}]`, err.message);
          if (this.socket === sock) this._lastSocketError = err.code || err.message;
          clearTimeout(connectTimeout);
          reject(err);
        });

        sock.on('connect', () => {
          clearTimeout(connectTimeout);
          if (this.socket !== sock) { try { sock.destroy(); } catch(e) {} return; }
          this.state = 2; // READY
          resolve();
        });
      } catch (err) {
        clearTimeout(connectTimeout);
        reject(err);
      }
    });
  };

  // Split and route decrypted buffer to the correct response/event parser
  HttpConnection.prototype.processDecryptedBuffer = function() {
    while (this._decryptedBuffer && this._decryptedBuffer.length > 0) {
      const str = this._decryptedBuffer.toString('binary', 0, 10);
      const isEvent = str.startsWith('EVENT/');
      const isHttp = str.startsWith('HTTP/');

      if (!isEvent && !isHttp) {
        const indexEvent = this._decryptedBuffer.indexOf('EVENT/');
        const indexHttp = this._decryptedBuffer.indexOf('HTTP/');
        let index = -1;
        if (indexEvent >= 0 && indexHttp >= 0) {
          index = Math.min(indexEvent, indexHttp);
        } else if (indexEvent >= 0) {
          index = indexEvent;
        } else if (indexHttp >= 0) {
          index = indexHttp;
        }

        if (index > 0) {
          console.warn(`[HAP] Plaintext out of sync. Discarding ${index} bytes of junk.`);
          diag(`[ROUTER ${this.address}] discarded ${index} bytes: ${preview(this._decryptedBuffer.slice(0, index))}`);
          this._decryptedBuffer = this._decryptedBuffer.slice(index);
          continue;
        } else {
          if (this._decryptedBuffer.length > 20) {
            console.warn(`[HAP] Clearing ${this._decryptedBuffer.length} bytes of unknown data.`);
            diag(`[ROUTER ${this.address}] cleared ${this._decryptedBuffer.length} unknown bytes: ${preview(this._decryptedBuffer)}`);
            this._decryptedBuffer = Buffer.alloc(0);
          }
          break;
        }
      }

      const headerEnd = this._decryptedBuffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        break; // headers incomplete
      }

      const headersStr = this._decryptedBuffer.toString('utf8', 0, headerEnd);
      let contentLength = 0;
      const contentLengthMatch = headersStr.match(/content-length:\s*(\d+)/i);
      if (contentLengthMatch) {
        contentLength = parseInt(contentLengthMatch[1], 10);
      }

      const totalMessageLength = headerEnd + 4 + contentLength;
      if (this._decryptedBuffer.length < totalMessageLength) {
        break; // body incomplete
      }

      const message = this._decryptedBuffer.slice(0, totalMessageLength);
      this._decryptedBuffer = this._decryptedBuffer.slice(totalMessageLength);

      if (isEvent) {
        diag(`[EVENT ${this.address}] ${contentLengthMatch ? `len=${contentLength}` : 'NO content-length'} ${preview(message.slice(headerEnd + 4))}${contentLengthMatch ? '' : ` headers=${preview(headersStr)}`}`);
        if (this._eventParser) {
          try {
            this._eventParser.execute(message);
          } catch (err) {
            console.error('[HAP Router] Event parser error:', err.message);
          }
        }
      } else if (isHttp) {
        if (this._responseParsersQueue && this._responseParsersQueue.length > 0) {
          const parser = this._responseParsersQueue[0];
          try {
            parser.execute(message);
          } catch (err) {
            console.error('[HAP Router] Response parser error:', err.message);
          }
        } else {
          console.warn('[HAP Router] Received HTTP response but no active request parser in queue');
        }
      }
    }
  };

  // Decrypt incoming encrypted frames
  HttpConnection.prototype._decryptAndAppend = function(chunk) {
    if (!this._encryptedBuffer) {
      this._encryptedBuffer = Buffer.alloc(0);
    }
    this._encryptedBuffer = Buffer.concat([this._encryptedBuffer, chunk]);

    while (this._encryptedBuffer.length >= 18) {
      const frameLength = this._encryptedBuffer.readUInt16LE(0);
      if (this._encryptedBuffer.length < frameLength + 18) {
        return;
      }
      const aad = this._encryptedBuffer.slice(0, 2);
      const frameData = this._encryptedBuffer.slice(2, 18 + frameLength);
      const readNonce = Buffer.alloc(12);
      readNonce.writeUInt32LE(this.a2cCounter, 4);

      try {
        const decrypted = Buffer.from(libsodium.crypto_aead_chacha20poly1305_ietf_decrypt(
          null,
          frameData,
          aad,
          readNonce,
          this.sessionKeys.AccessoryToControllerKey
        ));
        this._decryptedBuffer = Buffer.concat([this._decryptedBuffer, decrypted]);
        ++this.a2cCounter;
      } catch (e) {
        console.error(`[HAP Connection Decryption Error] Failed to decrypt frame: ${e.message} at a2cCounter=${this.a2cCounter}`);
        ++this.a2cCounter;
      }
      this._encryptedBuffer = this._encryptedBuffer.slice(18 + frameLength);
    }
  };

  // Override _requestClear / _requestEncrypted: timeout, fail-fast on socket close, shared parser queue
  HttpConnection.prototype._requestClear = async function(data, readEvents = false) {
    await this._open();
    return sendRequest(this, data, false);
  };

  HttpConnection.prototype._requestEncrypted = async function(data, readEvents = false) {
    await libsodium.ready; // already resolved after startup warm-up; costs one microtask
    await this._open();
    return sendRequest(this, data, true);
  };

  // Reset decryption counters and buffers when session keys are updated
  const originalSetSessionKeys = HttpConnection.prototype.setSessionKeys;
  HttpConnection.prototype.setSessionKeys = function(keys) {
    originalSetSessionKeys.call(this, keys);
    this.a2cCounter = 0;
    this.c2aCounter = 0;
    this._decryptedBuffer = Buffer.alloc(0);
    this._encryptedBuffer = Buffer.alloc(0);
    console.log(`[HAP Connection] Session keys set, decryption state reset.`);
  };

  // Force socket destruction upon connection close to release accessory slots instantly
  HttpConnection.prototype.close = function() {
    this.state = 0; // CLOSED
    this._responseParsersQueue = [];
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch (err) {
        console.error('[HAP Connection] Error destroying socket during close:', err.message);
      }
      this.socket = null;
    }
    // The socket's own 'close' event is ignored once this.socket is cleared, so fail waiters here.
    failPendingRequests(this, new Error(`Connection to ${this.address}:${this.port} was closed`));
  };

  // HttpClient patches: one verified session per gateway carries both requests and events, and a
  // failed pair-verify closes its socket. Legrand gateways only have a few HAP session slots; once
  // they are full the gateway resets every new pair-verify (ECONNRESET) until it is power-cycled.
  try {
    const HttpClientModule = require('hap-controller/lib/transport/ip/http-client').default;

    // Close the socket of a failed pair-verify instead of leaving it half-open on the gateway.
    const originalPairVerify = HttpClientModule.prototype._pairVerify;
    HttpClientModule.prototype._pairVerify = async function(connection) {
      try {
        return await originalPairVerify.call(this, connection);
      } catch (err) {
        try { connection.close(); } catch (e) {}
        const wrapped = new Error(`Pair-verify failed: ${err && err.message ? err.message : err}`);
        wrapped.isPairVerifyError = true;
        wrapped.statusCode = err && err.statusCode;
        throw wrapped;
      }
    };

    HttpClientModule.prototype.getDefaultVerifiedConnection = async function() {
      if (this.subscriptionConnection && this.subscriptionConnection.isConnected()) {
        dbg(`[HAP Client] Reusing active subscription connection for request to ${this.address}:${this.port}`);
        return this.subscriptionConnection;
      }
      if (this._defaultConnection) {
        if (this._defaultConnection.isConnected()) return this._defaultConnection;
        delete this._defaultConnection;
      }
      // Concurrent callers (getAccessories, subscribe, heartbeat, writes) share one pair-verify
      if (this._pendingVerifiedConnection) return this._pendingVerifiedConnection;

      this._pendingVerifiedConnection = (async () => {
        const connection = new HttpConnection(this.address, this.port);
        const keys = await this._pairVerify(connection);
        connection.setSessionKeys(keys);
        connection.on('disconnect', () => {
          if (this._defaultConnection === connection) {
            console.log(`[HAP Client] Persistent connection to ${this.address}:${this.port} disconnected. Clearing reference.`);
            delete this._defaultConnection;
          }
        });
        if (this.usePersistentConnections) {
          this._defaultConnection = connection;
        }
        return connection;
      })();

      try {
        return await this._pendingVerifiedConnection;
      } finally {
        this._pendingVerifiedConnection = null;
      }
    };

    // Subscribe on the shared session instead of opening a second one.
    HttpClientModule.prototype.subscribeCharacteristics = async function(characteristics) {
      const connection = (this.subscriptionConnection && this.subscriptionConnection.isConnected())
        ? this.subscriptionConnection
        : await this.getDefaultVerifiedConnection();

      if (this.subscriptionConnection !== connection) {
        // Fresh session: subscriptions never carry over between sessions
        this.subscriptionConnection = connection;
        this.subscribedCharacteristics = [];

        if (!connection._subscriptionHandlersAttached) {
          connection._subscriptionHandlersAttached = true;
          connection.on('event', (ev) => {
            let parsed;
            try {
              parsed = JSON.parse(ev.toString());
            } catch (err) {
              console.error('[HAP Client] Failed to parse event body:', err.message);
              return;
            }
            this.emit('event', parsed);
          });
          connection.on('disconnect', () => {
            if (this.subscriptionConnection !== connection) return;
            delete this.subscriptionConnection;
            const lost = this.subscribedCharacteristics;
            this.subscribedCharacteristics = [];
            // Always signal (even with nothing subscribed yet) so the owner reconnects and
            // re-subscribes instead of silently continuing without events.
            this.emit('event-disconnect', lost);
          });
        }
      }

      const newSubscriptions = characteristics.filter(cid => !this.subscribedCharacteristics.includes(cid));
      if (newSubscriptions.length === 0) return;

      const data = {
        characteristics: newSubscriptions.map((cid) => {
          const parts = cid.split('.');
          return { aid: parseInt(parts[0].trim(), 10), iid: parseInt(parts[1].trim(), 10), ev: true };
        }),
      };
      const response = await connection.put('/characteristics', Buffer.from(JSON.stringify(data)), 'application/hap+json', true);
      diag(`[SUBSCRIBE ${this.address}] ${newSubscriptions.length} chars -> ${response.statusCode}${response.body && response.body.length ? ` ${preview(response.body, 1500)}` : ''}`);
      if (response.statusCode !== 204 && response.statusCode !== 207) {
        throw new Error(`Subscribe failed with status ${response.statusCode}`);
      }
      this.subscribedCharacteristics = this.subscribedCharacteristics.concat(newSubscriptions);
    };

    const originalCloseMaybePersistentConnection = HttpClientModule.prototype.closeMaybePersistentConnection;
    HttpClientModule.prototype.closeMaybePersistentConnection = function(connection, forceClose = false) {
      // 3. Never close the subscription connection during normal requests
      if (connection === this.subscriptionConnection) {
        if (!forceClose) {
          dbg(`[${new Date().toISOString()}] [HAP Client] Preserving subscription connection.`);
          return;
        }
      }
      originalCloseMaybePersistentConnection.call(this, connection, forceClose);
    };

    console.log('[HAP Patch] HttpClient patches applied.');
  } catch (err) {
    console.error('Failed to monkeypatch HAP HttpClient:', err.message);
  }

  console.log('[HAP Patch] HttpConnection patches applied.');
} catch (err) {
  console.error('Failed to monkeypatch HAP HttpConnection:', err.message);
}


/**
 * Manages a single, persistent TCP connection to a HomeKit/HAP gateway.
 * Prevents exceeding the accessory connection limits and ensures real-time updates.
 */
class HAPGatewayConnection {
  constructor(app, gatewayId, ip, port, pairingData) {
    this.app = app;
    this.gatewayId = gatewayId.toLowerCase();
    this.ip = ip;
    this.port = port;
    this.pairingData = pairingData;

    // HAP device id (TXT record "id", e.g. "aa:bb:cc:dd:ee:ff") derived from the pairing keys.
    // Used to re-match this connection when mDNS discovery reports a new IP address (DHCP change).
    this.hapId = null;
    if (pairingData && pairingData.AccessoryPairingID) {
      try {
        this.hapId = Buffer.from(pairingData.AccessoryPairingID, 'hex').toString('utf8').toLowerCase();
      } catch (e) { /* best effort */ }
    }

    this.client = null;
    this.subscribedCharacteristics = new Set(); // Set of "aid.iid" strings
    this.isConnected = false;
    this.isConnecting = false;
    this.stopped = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.consecutiveFailures = 0;
    this.connectedAt = 0;
    this.unavailableMessage = null;
    this.syncTimeout = null;
    this.heartbeatTimer = null;

    this.writeQueue = [];
    this.writeTimeout = null;
    this.lastWrites = {};
  }

  async connect() {
    if (this.stopped || this.isConnecting || this.isConnected) return;
    this.isConnecting = true;
    this.app.log(`[HAP Connection ${this.gatewayId}] Connecting to ${this.ip}:${this.port}...`);

    // Every listener checks `this.client === client`: a superseded client (address change,
    // failed attempt) must never tear down or feed events into its replacement.
    const client = new HttpClient(this.gatewayId, this.ip, this.port, this.pairingData, { usePersistentConnections: true });
    this.client = client;

    // Event listener for push notifications from Legrand Gateway
    client.on('event', (eventData) => {
      if (this.client !== client) return;
      this.app.log(`[HAP Event ${this.gatewayId}] Received event:`, eventData);
      // eventData contains: { characteristics: [{ aid, iid, value }] }
      this.app.onHAPEvent(this.gatewayId, eventData);
    });

    // The shared session dropped (gateway closed it, timeout, ...)
    client.on('event-disconnect', (subscribedList) => {
      if (this.client !== client) return;
      this.app.log(`[HAP Connection ${this.gatewayId}] Session closed by gateway (${subscribedList.length} subscriptions lost).`);
      this.handleDisconnect(new Error('Session closed by gateway'));
    });

    try {
      // Warm up session and verify encryption keys
      const accessoriesResponse = await client.getAccessories();
      if (this.client !== client || this.stopped) {
        this.isConnecting = false;
        return; // superseded while connecting
      }
      const accessories = accessoriesResponse.accessories || accessoriesResponse;

      if (HAP_DEBUG) {
        try {
          const statelessAccessories = accessories.filter(acc =>
            acc.services && acc.services.some(s => s.type.toUpperCase().includes('00000089'))
          );
          this.app.log('=== STATELESS ACC DUMP ===');
          this.app.log(JSON.stringify(statelessAccessories, null, 2));
          this.app.log('==========================');
        } catch (err) {
          this.app.error('Failed to log stateless accessories:', err.message);
        }
      }

      this.isConnected = true;
      this.isConnecting = false;
      this.reconnectAttempts = 0; // successful connect resets the backoff
      this.consecutiveFailures = 0;
      this.connectedAt = Date.now();
      this.accessories = accessories; // Cache accessories for immediate device-level initial sync
      this.app.log(`[HAP Connection ${this.gatewayId}] Connected, ${accessories?.length || 0} accessories.`);
      diag(`[CONN ${this.gatewayId}] connected to ${this.ip}:${this.port}, ${accessories?.length || 0} accessories, ${this.subscribedCharacteristics.size} subscriptions wanted`);

      // Start ping heartbeat
      this.startHeartbeat();

      // Sync active subscriptions for registered devices
      await this.syncSubscriptions();
      if (this.client !== client || !this.isConnected) return; // dropped during subscribe

      // Perform initial state sync for all devices + mark them available again
      if (Array.isArray(accessories)) {
        this.app.updateDevicesFromAccessories(this.gatewayId, accessories);
      }
      this.unavailableMessage = null;
      this.app.setGatewayDevicesAvailable(this.gatewayId);
    } catch (err) {
      if (this.client !== client) {
        this.isConnecting = false;
        return; // superseded; the replacement owns reconnection
      }
      this.isConnecting = false;
      this.app.error(`[HAP Connection ${this.gatewayId}] Connection failed:`, err.message);
      diag(`[CONN ${this.gatewayId}] connect failed: ${err.message}`);
      this.handleDisconnect(err);
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      const client = this.client;
      if (!this.isConnected || !client) return;
      try {
        await client.getCharacteristics(['1.3']);
      } catch (err) {
        if (this.client !== client) return; // already handled by the disconnect path
        this.app.error(`[HAP Heartbeat ${this.gatewayId}] Ping failed:`, err.message);
        this.handleDisconnect(err);
      }
    }, 30000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  closeClient() {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      Promise.resolve(client.close()).catch(() => {});
    } catch (err) {
      this.app.error(`[HAP Connection ${this.gatewayId}] Error closing client:`, err.message);
    }
  }

  /**
   * Human readable reason shown on the Homey devices while the gateway is unreachable.
   */
  describeFailure(err) {
    const msg = (err && err.message) || '';
    if (err && err.isPairVerifyError && /M[24]: Error: 2\b|Wrong accessory pairing ID|Signature verification failed/.test(msg)) {
      return 'The gateway no longer accepts this Homey pairing (HomeKit was probably reset on the gateway). Remove the devices and pair again with the HomeKit code.';
    }
    if (this.consecutiveFailures >= 3) {
      return 'The gateway refuses HomeKit connections. Retrying automatically — if this persists, power-cycle the Legrand/BTicino gateway (unplug it for 10 seconds).';
    }
    return 'Gateway connection lost. Reconnecting...';
  }

  markUnavailable(message) {
    if (this.unavailableMessage === message) return; // don't spam setUnavailable on every retry
    this.unavailableMessage = message;
    this.app.setGatewayDevicesUnavailable(this.gatewayId, message);
  }

  handleDisconnect(err) {
    const wasConnected = this.isConnected;
    this.isConnected = false;
    this.isConnecting = false;
    this.stopHeartbeat();
    this.closeClient();

    if (this.stopped) return;
    if (wasConnected) diag(`[CONN ${this.gatewayId}] disconnected: ${(err && err.message) || 'unknown'}`);

    this.consecutiveFailures = wasConnected ? 0 : this.consecutiveFailures + 1;
    if (this.consecutiveFailures >= 3 && this.consecutiveFailures % 3 === 0) {
      this.app.error(`[HAP Connection ${this.gatewayId}] ${this.consecutiveFailures} consecutive connection failures. Last error: ${err && err.message}`);
    }

    // Show the reason in the Homey app instead of letting commands fail silently, including when
    // the first connect after an app start fails.
    this.markUnavailable(this.describeFailure(err));

    if (this.reconnectTimer) return;

    // A session that was healthy for a while gets a quick retry (brief gateway hiccup).
    // Otherwise exponential backoff with jitter: 10s, 20s, 40s ... capped at 5 min.
    let delay;
    if (wasConnected && Date.now() - this.connectedAt > 60000) {
      delay = 2000 + Math.floor(Math.random() * 2000);
    } else {
      delay = Math.min(10000 * Math.pow(2, this.reconnectAttempts), 300000)
        + Math.floor(Math.random() * 3000);
      this.reconnectAttempts++;
    }

    this.app.log(`[HAP Connection ${this.gatewayId}] Scheduling reconnection attempt in ${Math.round(delay / 1000)}s...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        this.app.error(`[HAP Connection ${this.gatewayId}] Reconnection attempt failed:`, err.message);
      }
    }, delay);
  }

  /**
   * Stops all activity for good (app shutdown).
   */
  destroy() {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
    this.closeClient();
  }

  updateAddress(ip, port) {
    if (this.ip !== ip || this.port !== port) {
      this.app.log(`[HAP Connection ${this.gatewayId}] IP/Port updated from ${this.ip}:${this.port} to ${ip}:${port}. Reconnecting...`);
      this.ip = ip;
      this.port = port;
      this.reconnectAttempts = 0; // fresh address — retry eagerly again
      this.consecutiveFailures = 0;

      // Persist the new address into every paired device's store so the app
      // reconnects to the right IP after a restart (DHCP change survival).
      this.app.persistGatewayAddress(this.gatewayId, ip, port);

      // Abandon the current session / in-flight attempt (its listeners are ignored from now on)
      this.isConnected = false;
      this.isConnecting = false;
      this.stopHeartbeat();
      this.closeClient();

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      this.connect().catch(err => {
        this.app.error(`[HAP Connection ${this.gatewayId}] Connect to new address failed:`, err.message);
      });
    }
  }

  addSubscription(aid, iid) {
    const key = `${aid}.${iid}`;
    if (!this.subscribedCharacteristics.has(key)) {
      this.subscribedCharacteristics.add(key);
      // While disconnected, connect() performs one authoritative syncSubscriptions().
      // Triggering here too caused duplicate subscribe PUTs at startup.
      if (this.isConnected) {
        this.triggerSubscriptionSync();
      }
    }
  }

  removeSubscription(aid, iid) {
    const key = `${aid}.${iid}`;
    if (this.subscribedCharacteristics.has(key)) {
      this.subscribedCharacteristics.delete(key);
      this.triggerSubscriptionSync();
    }
  }

  triggerSubscriptionSync() {
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(() => {
      this.syncTimeout = null;
      this.syncSubscriptions().catch(err => {
        this.app.error(`[HAP Connection ${this.gatewayId}] Debounced sync failed:`, err.message);
      });
    }, 1000); // debounce so device inits at startup end up in one subscribe request
  }

  async syncSubscriptions() {
    if (!this.isConnected || !this.client) return;

    const list = Array.from(this.subscribedCharacteristics);
    if (list.length === 0) return;

    this.app.log(`[HAP Connection ${this.gatewayId}] Syncing ${list.length} HAP subscriptions.`);
    dbg(`[HAP Connection ${this.gatewayId}] Subscriptions:`, list);
    try {
      await this.client.subscribeCharacteristics(list);
    } catch (err) {
      this.app.error(`[HAP Connection ${this.gatewayId}] Subscription synchronization failed:`, err.message);
    }
  }

  async getAccessories() {
    // Wait up to 10 seconds for the connection to be ready
    if (!this.isConnected) {
      this.app.log(`[HAP Connection ${this.gatewayId}] Waiting for connection to be ready before getting accessories...`);
      for (let i = 0; i < 100; i++) { // 10 seconds
        if (this.isConnected && this.client) break;
        await new Promise(r => setTimeout(r, 100));
      }
    }

    if (!this.isConnected || !this.client) {
      throw new Error(this.unavailableMessage || 'Not connected to HAP Gateway. Please check if the gateway is online.');
    }
    return this.client.getAccessories();
  }

  async setCharacteristic(aid, iid, value) {
    // Wait up to 5 seconds for the connection
    if (!this.isConnected || !this.client) {
      this.app.log(`[HAP Connection ${this.gatewayId}] Write queued for ${aid}.${iid}=${value}, waiting for connection...`);
      for (let i = 0; i < 50; i++) {
        if (this.isConnected && this.client) break;
        await new Promise(r => setTimeout(r, 100));
      }
    }

    if (!this.isConnected || !this.client) {
      throw new Error(this.unavailableMessage || `Not connected to HAP Gateway ${this.gatewayId}`);
    }

    this.app.log(`[HAP Write] ${this.gatewayId} -> aid=${aid} iid=${iid} value=${JSON.stringify(value)}`);

    return new Promise((resolve, reject) => {
      this.enqueueWrite({ aid: Number(aid), iid: Number(iid), value, resolve, reject, retried: false });
    });
  }

  enqueueWrite(item) {
    this.lastWrites[`${item.aid}.${item.iid}`] = { value: item.value, time: Date.now() };

    // 1. If an item with the same aid and iid is already queued, the newer write wins
    const existingIdx = this.writeQueue.findIndex(x => x.aid === item.aid && x.iid === item.iid);
    if (existingIdx >= 0) {
      this.writeQueue[existingIdx].resolve(); // Superseded write resolves immediately
      this.writeQueue[existingIdx] = item;
    } else {
      this.writeQueue.push(item);
    }

    // 2. Schedule flushing the queue at the end of the current microtask loop
    if (!this.writeTimeout) {
      this.writeTimeout = true;
      process.nextTick(() => {
        this.writeTimeout = false;
        this.flushWriteQueue();
      });
    }
  }

  async flushWriteQueue() {
    const queueToProcess = this.writeQueue;
    this.writeQueue = [];
    this.writeTimeout = false;

    if (queueToProcess.length === 0) return;

    // Guard: a disconnect may land between queueing (nextTick) and this flush
    if (!this.client || !this.isConnected) {
      const err = new Error(this.unavailableMessage || `Not connected to HAP Gateway ${this.gatewayId}`);
      for (const item of queueToProcess) item.reject(err);
      return;
    }

    this.app.log(`[${new Date().toISOString()}] [HAP Connection ${this.gatewayId}] Flushing write queue with ${queueToProcess.length} commands`);

    const characteristicsObj = {};
    for (const item of queueToProcess) {
      characteristicsObj[`${item.aid}.${item.iid}`] = item.value;
    }

    try {
      const response = await this.client.setCharacteristics(characteristicsObj);
      const statuses = response && Array.isArray(response.characteristics) ? response.characteristics : [];
      const retryItems = [];

      for (const item of queueToProcess) {
        const charStatus = statuses.find(x => x.aid === item.aid && x.iid === item.iid);
        // Items not mentioned in the response (or 204 No Content) succeeded
        if (!charStatus || charStatus.status === 0 || charStatus.status === undefined) {
          item.resolve();
        } else if (charStatus.status === HAP_STATUS_COMMUNICATION_FAILURE && !item.retried) {
          retryItems.push(item);
        } else {
          item.reject(new Error(`HAP write failed with status ${charStatus.status}`));
          if (charStatus.status === HAP_STATUS_COMMUNICATION_FAILURE) {
            // Final failure: re-read the real state so Homey doesn't show a value that never applied
            performHAPRecovery(this, item.aid, item.iid).catch(() => {});
          }
        }
      }

      if (retryItems.length > 0) {
        this.app.log(`[HAP Connection ${this.gatewayId}] Retrying ${retryItems.length} write(s) after status ${HAP_STATUS_COMMUNICATION_FAILURE}...`);
        const scheduledAt = Date.now();
        setTimeout(() => {
          for (const item of retryItems) {
            item.retried = true;
            const last = this.lastWrites[`${item.aid}.${item.iid}`];
            if (last && last.time > scheduledAt) {
              item.resolve(); // a newer write for this characteristic was sent meanwhile — it wins
              continue;
            }
            if (!this.client || !this.isConnected) {
              item.reject(new Error(this.unavailableMessage || `Not connected to HAP Gateway ${this.gatewayId}`));
              continue;
            }
            this.enqueueWrite(item);
          }
        }, 750);
      }
    } catch (err) {
      this.app.error(`[${new Date().toISOString()}] [HAP Connection ${this.gatewayId}] Batched write failed:`, err.message);
      for (const item of queueToProcess) {
        item.reject(err);
      }
    }
  }
}

class LegrandHomeKitApp extends Homey.App {
  log(...args) {
    super.log(...args);
  }

  error(...args) {
    super.error(...args);
  }

  async onInit() {
    appInstance = this;
    this.log('=== Legrand HomeKit Local App initializing... ===');
    this.gateways = new Map();
    this.registerFlowCards();

    // Verbose HAP diagnostics toggle (app settings page)
    setHapDebug(this.homey.settings.get('debugLogs'));
    this.homey.settings.on('set', (key) => {
      if (key === 'debugLogs') {
        setHapDebug(this.homey.settings.get('debugLogs'));
        this.log(`HAP debug logging ${this.homey.settings.get('debugLogs') ? 'enabled' : 'disabled'}.`);
      }
    });

    // Setup network discovery strategy to dynamically resolve gateway IPs
    try {
      const discoveryStrategy = this.homey.discovery.getStrategy('legrand_gateway');
      
      // Fetch currently discovered items
      const currentResults = discoveryStrategy.getDiscoveryResults();
      Object.keys(currentResults).forEach((key) => {
        const result = currentResults[key];
        this.log('[Discovery] Cache hit:', result.id, result.address, result.port);
        this.onGatewayDiscovered(result.id, result.address, result.port);
      });

      // Listen for real-time discovery events
      discoveryStrategy.on('result', (result) => {
        this.log('[Discovery] Gateway found/updated:', result.id, result.address, result.port);
        this.onGatewayDiscovered(result.id, result.address, result.port);
      });
    } catch (err) {
      this.error('Failed to setup discovery strategy:', err.message);
    }

    // Auto-connect gateways for existing Homey devices after startup
    setTimeout(() => {
      this.initializeExistingDevices().catch(err => {
        this.error('Failed to initialize existing devices:', err.message);
      });
    }, 2000);

    // Delayed diagnostic dump of all global HAP PUT requests to prevent log truncation
    setTimeout(() => {
      if (HAP_DEBUG) {
        this.log('=== GLOBAL HAP PUT LOGS ===');
        if (global.hapPutLogs && global.hapPutLogs.length > 0) {
          global.hapPutLogs.forEach(l => this.log(l));
        } else {
          this.log('No HAP HTTP PUT characteristics subscription requests captured.');
        }
        this.log('=== END GLOBAL HAP PUT LOGS ===');
      }
      global.hapPutLogs = null; // Free memory and prevent memory leak
    }, 15000);
  }

  /**
   * Cleanly tear down all HAP connections when the app stops or is updated.
   * Legrand gateways have a limited number of concurrent HAP controller sessions;
   * without this, stale sessions occupy slots until TCP timeout and block reconnection.
   */
  async onUninit() {
    this.log('App shutting down — closing all HAP connections...');
    for (const conn of this.gateways.values()) {
      try {
        conn.destroy();
      } catch (err) {
        this.error(`Error closing connection ${conn.gatewayId}:`, err.message);
      }
    }
    this.gateways.clear();
  }

  /**
   * Diagnostics snapshot served by api.js (GET /diagnostics).
   */
  getDiagnostics() {
    return {
      version: this.homey.manifest.version,
      time: new Date().toISOString(),
      gateways: Array.from(this.gateways.values()).map(conn => ({
        gatewayId: conn.gatewayId,
        address: `${conn.ip}:${conn.port}`,
        connected: conn.isConnected,
        connecting: conn.isConnecting,
        consecutiveFailures: conn.consecutiveFailures,
        unavailableMessage: conn.unavailableMessage,
        subscriptionsWanted: conn.subscribedCharacteristics.size,
        subscriptionsActive: conn.client && Array.isArray(conn.client.subscribedCharacteristics)
          ? conn.client.subscribedCharacteristics.length : 0,
      })),
      log: diagLog.slice(),
    };
  }

  recordDiag(line) {
    diag(line);
  }

  registerFlowCards() {
    this.buttonPressedTrigger = this.homey.flow.getDeviceTriggerCard('button_pressed');
    this.buttonPressedTrigger.registerRunListener(async (args, state) => {
      const selectedButton = this.getFlowArgId(args.button);
      const selectedAction = this.getFlowArgId(args.action);

      return String(selectedButton) === String(state.button)
        && String(selectedAction) === String(state.action);
    });
    this.log('button_pressed flow card registered.');
  }

  getFlowArgId(value) {
    if (value && typeof value === 'object' && value.id !== undefined) {
      return value.id;
    }
    return value;
  }

  /**
   * Scans existing devices in Homey and opens HAP connections for them.
   */
  async initializeExistingDevices() {
    this.log('Scanning existing devices to warm up HAP connections...');
    try {
      const driver = this.homey.drivers.getDriver('legrand_device');
      const devices = driver.getDevices();
      this.log(`Found ${devices.length} existing devices.`);

      for (const device of devices) {
        const store = device.getStore();
        if (store && store.gatewayId && store.ip && store.port && store.pairingData) {
          this.getGatewayConnection(
            store.gatewayId,
            store.ip,
            store.port,
            store.pairingData
          );
        }
      }
    } catch (err) {
      // Driver might have 0 devices or not be fully initialized yet
      this.log('No existing devices mapped yet.');
    }
  }

  /**
   * Triggered when a Legrand HAP service is resolved or changes on the network.
   *
   * NOTE: Homey's mdns-sd discovery reports `result.id` as the HAP TXT record id
   * (a MAC-like string), while connections are keyed by `mdns:IP:port`. Matching
   * is therefore done via the hapId derived from the pairing keys — this is what
   * makes DHCP IP changes survivable without re-pairing.
   */
  onGatewayDiscovered(id, address, port) {
    if (!id || !address) return;
    const idLower = String(id).toLowerCase();
    for (const conn of this.gateways.values()) {
      if ((conn.hapId && conn.hapId === idLower) || conn.gatewayId === idLower) {
        conn.updateAddress(address, port);
        return;
      }
    }
    dbg(`[Discovery] No active connection matches HAP id ${idLower} (${address}:${port})`);
  }

  /**
   * Retrieves or instantiates a persistent HAP connection.
   */
  getGatewayConnection(gatewayId, ip, port, pairingData) {
    const key = gatewayId.toLowerCase();
    let conn = this.gateways.get(key);

    if (!conn && pairingData) {
      let parsedData = pairingData;
      if (typeof parsedData === 'string') {
        try { parsedData = JSON.parse(parsedData); } catch(e) {}
      }
      conn = new HAPGatewayConnection(this, key, ip, port, parsedData);
      this.gateways.set(key, conn);
      conn.connect().catch(err => {
        this.error(`Failed to initiate HAP connection for ${key}:`, err.message);
      });
    }

    return conn;
  }

  /**
   * Returns all Homey devices paired to the given gateway (null-safe).
   */
  getGatewayDevices(gatewayId) {
    try {
      const driver = this.homey.drivers.getDriver('legrand_device');
      const idLower = String(gatewayId).toLowerCase();
      return driver.getDevices().filter(d => {
        const store = d.getStore();
        return store && store.gatewayId && String(store.gatewayId).toLowerCase() === idLower;
      });
    } catch (err) {
      return [];
    }
  }

  /**
   * Persists a changed gateway IP/port into every paired device's store,
   * so restarts reconnect to the current address.
   */
  persistGatewayAddress(gatewayId, ip, port) {
    for (const device of this.getGatewayDevices(gatewayId)) {
      device.setStoreValue('ip', ip).catch(this.error);
      device.setStoreValue('port', port).catch(this.error);
    }
  }

  setGatewayDevicesUnavailable(gatewayId, message) {
    for (const device of this.getGatewayDevices(gatewayId)) {
      device.setUnavailable(message).catch(this.error);
    }
  }

  setGatewayDevicesAvailable(gatewayId) {
    for (const device of this.getGatewayDevices(gatewayId)) {
      device.setAvailable().catch(this.error);
    }
  }

  /**
   * Performs an initial sync of all devices from the fetched HAP accessories list
   */
  updateDevicesFromAccessories(gatewayId, accessories) {
    try {
      const driver = this.homey.drivers.getDriver('legrand_device');
      const devices = driver.getDevices();
      this.log(`[Initial Sync] Starting sync for gateway ${gatewayId} with ${devices.length} devices...`);

      for (const acc of accessories) {
        const targetDevice = devices.find(d => {
          const store = d.getStore();
          return store && store.gatewayId &&
                 String(store.gatewayId).toLowerCase() === gatewayId.toLowerCase() &&
                 Number(store.aid) === Number(acc.aid);
        });

        if (targetDevice && acc.services) {
          this.log(`[Initial Sync] Syncing state for ${targetDevice.getName()} (AID: ${acc.aid})`);
          for (const service of acc.services) {
            if (service.characteristics) {
              for (const c of service.characteristics) {
                targetDevice.onHAPEvent(c.iid, c.value);
              }
            }
          }
        }
      }
    } catch (err) {
      this.error('[Initial Sync] Failed to perform initial sync from accessories:', err.message);
    }
  }

  /**
   * Relays physical event notifications from the Legrand Gateway to the Homey devices.
   */
  onHAPEvent(gatewayId, eventData) {
    try {
      if (!eventData || !Array.isArray(eventData.characteristics)) return;

      const conn = this.gateways.get(gatewayId.toLowerCase());

      const driver = this.homey.drivers.getDriver('legrand_device');
      const devices = driver.getDevices();

      for (const charUpdate of eventData.characteristics) {
        if (conn && conn.lastWrites) {
          const key = `${charUpdate.aid}.${charUpdate.iid}`;
          const lastWrite = conn.lastWrites[key];
          if (lastWrite) {
            const timeDiff = Date.now() - lastWrite.time;
            if (timeDiff < 2000) {
              if (!valuesEqual(lastWrite.value, charUpdate.value)) {
                this.log(`[Anti-Bounce] Ignored event for ${key} (${charUpdate.value}) conflicting with recent write (${lastWrite.value}) sent ${timeDiff}ms ago`);
                diag(`[DISPATCH ${gatewayId}] ${key}=${JSON.stringify(charUpdate.value)} IGNORED (anti-bounce, write ${JSON.stringify(lastWrite.value)} ${timeDiff}ms ago)`);
                continue;
              }
            } else {
              delete conn.lastWrites[key];
            }
          }
        }

        // Find the specific Homey device representing this physical accessory
        const targetDevice = devices.find(d => {
          const store = d.getStore();
          return store && store.gatewayId &&
                 String(store.gatewayId).toLowerCase() === gatewayId.toLowerCase() &&
                 Number(store.aid) === Number(charUpdate.aid);
        });

        if (targetDevice) {
          this.log(`[HAP Dispatcher] Dispatching event to ${targetDevice.getName()} (AID: ${charUpdate.aid}, IID: ${charUpdate.iid}) -> ${charUpdate.value}`);
          diag(`[DISPATCH ${gatewayId}] ${charUpdate.aid}.${charUpdate.iid}=${JSON.stringify(charUpdate.value)} -> ${targetDevice.getName()}`);
          targetDevice.onHAPEvent(charUpdate.iid, charUpdate.value, true);
        } else {
          diag(`[DISPATCH ${gatewayId}] ${charUpdate.aid}.${charUpdate.iid}=${JSON.stringify(charUpdate.value)} NO DEVICE for aid ${charUpdate.aid}`);
        }
      }
    } catch (err) {
      this.error('Error dispatching HAP event to device:', err.message);
    }
  }
}

module.exports = LegrandHomeKitApp;
module.exports.HAPGatewayConnection = HAPGatewayConnection;
