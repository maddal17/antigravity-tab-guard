#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const username = os.userInfo().username || 'user';
export const SOCKET_DIR = `/tmp/antigravity-browser-bridge-${username}`;
export const SOCKET_PATH = path.join(SOCKET_DIR, 'bridge.sock');
const LOG_PATH = path.join(SOCKET_DIR, 'native-host.log');

function ensureSocketDir() {
  if (!fs.existsSync(SOCKET_DIR)) {
    fs.mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
  } else {
    try {
      fs.chmodSync(SOCKET_DIR, 0o700);
    } catch {
      // Ignore
    }
  }
}

function log(msg) {
  try {
    ensureSocketDir();
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_PATH, `[${ts}] [PID ${process.pid}] ${msg}\n`);
  } catch {
    // Ignore logging errors
  }
}

/**
 * Writes a 4-byte UInt32LE length-prefixed JSON message to Chrome Native Messaging stdout.
 */
function sendToExtension(obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([header, buf]));
}

export function startNativeHost() {
  ensureSocketDir();
  log('Antigravity Native Host starting (v2.0.0)');

  // Pending client requests: requestId -> { socket, params, timer, chunks: Map, totalChunks }
  const pendingRequests = new Map();
  let extensionInfo = {
    connected: true,
    extensionId: null,
    version: '2.0.0',
    lastSeen: Date.now(),
  };

  // 1. Parse length-prefixed Native Messaging frames from process.stdin
  let inputBuffer = Buffer.alloc(0);

  process.stdin.on('data', (chunk) => {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    while (inputBuffer.length >= 4) {
      const msgLen = inputBuffer.readUInt32LE(0);
      if (inputBuffer.length < 4 + msgLen) {
        break;
      }
      const rawJson = inputBuffer.subarray(4, 4 + msgLen).toString('utf8');
      inputBuffer = inputBuffer.subarray(4 + msgLen);

      try {
        const msg = JSON.parse(rawJson);
        handleExtensionMessage(msg);
      } catch (err) {
        log(`Failed to parse extension message: ${err.message}`);
      }
    }
  });

  function handleExtensionMessage(msg) {
    extensionInfo.lastSeen = Date.now();

    if (msg.type === 'hello') {
      extensionInfo.extensionId = msg.extensionId;
      extensionInfo.version = msg.version || '2.0.0';
      log(`Handshake received from extension ${msg.extensionId} (v${extensionInfo.version})`);
      return;
    }

    if (msg.type === 'keepalive_pong') {
      return;
    }

    if (msg.type === 'response_chunk') {
      const entry = pendingRequests.get(msg.id);
      if (!entry) return;
      entry.chunks.set(msg.index, msg.chunk);
      entry.totalChunks = msg.total;

      if (entry.chunks.size === entry.totalChunks) {
        let joined = '';
        for (let i = 0; i < entry.totalChunks; i++) {
          joined += entry.chunks.get(i) || '';
        }
        try {
          const fullResp = JSON.parse(joined);
          finalizeClientResponse(msg.id, fullResp);
        } catch (err) {
          finalizeClientResponse(msg.id, {
            ok: false,
            error: `Chunk reassembly parse error: ${err.message}`,
          });
        }
      }
      return;
    }

    if (msg.type === 'response' && msg.id) {
      finalizeClientResponse(msg.id, {
        ok: msg.ok,
        data: msg.data,
        error: msg.error,
      });
    }
  }

  function finalizeClientResponse(id, responsePayload) {
    const entry = pendingRequests.get(id);
    if (!entry) return;
    pendingRequests.delete(id);
    clearTimeout(entry.timer);

    // If SCREENSHOT includes filePath, write the binary PNG/JPEG directly on the host side
    if (
      responsePayload.ok &&
      responsePayload.data?.base64Data &&
      entry.params?.filePath
    ) {
      try {
        const outPath = path.resolve(entry.params.filePath);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        const imgBuf = Buffer.from(responsePayload.data.base64Data, 'base64');
        fs.writeFileSync(outPath, imgBuf);
        const { base64Data: _omit, ...rest } = responsePayload.data;
        responsePayload.data = {
          ...rest,
          filePath: outPath,
          byteLength: imgBuf.length,
        };
      } catch (err) {
        responsePayload = {
          ok: false,
          error: `Failed writing screenshot to ${entry.params.filePath}: ${err.message}`,
        };
      }
    }

    try {
      entry.socket.write(JSON.stringify({ id, ...responsePayload }) + '\n');
    } catch {
      // Client socket already closed
    }
  }

  // 2. Keepalive heartbeat every 20s to prevent Chrome MV3 service worker 30s idle termination
  const keepaliveTimer = setInterval(() => {
    try {
      sendToExtension({ type: 'keepalive_ping', timestamp: Date.now() });
    } catch {
      // Ignore
    }
  }, 20000);

  // 3. Remove stale socket file if present and start Unix Domain Socket server
  if (fs.existsSync(SOCKET_PATH)) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // Ignore
    }
  }

  const server = net.createServer((clientSocket) => {
    let clientBuf = '';
    clientSocket.on('data', (chunk) => {
      clientBuf += chunk.toString('utf8');
      let newlineIdx;
      while ((newlineIdx = clientBuf.indexOf('\n')) !== -1) {
        const line = clientBuf.slice(0, newlineIdx).trim();
        clientBuf = clientBuf.slice(newlineIdx + 1);
        if (!line) continue;

        try {
          const req = JSON.parse(line);
          const id = req.id || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const method = req.method || 'STATUS';
          const params = req.params || {};
          const timeoutMs = params.timeoutMs || 35000;

          const timer = setTimeout(() => {
            pendingRequests.delete(id);
            try {
              clientSocket.write(
                JSON.stringify({
                  id,
                  ok: false,
                  error: `Extension command '${method}' timed out after ${timeoutMs}ms`,
                }) + '\n'
              );
            } catch {
              // Ignore
            }
          }, timeoutMs);

          pendingRequests.set(id, {
            socket: clientSocket,
            params,
            timer,
            chunks: new Map(),
            totalChunks: 0,
          });

          sendToExtension({ id, method, params });
        } catch (err) {
          clientSocket.write(
            JSON.stringify({ ok: false, error: `Invalid request JSON: ${err.message}` }) + '\n'
          );
        }
      }
    });
  });

  server.listen(SOCKET_PATH, () => {
    try {
      fs.chmodSync(SOCKET_PATH, 0o600);
    } catch {
      // Ignore
    }
    log(`Unix socket listening at ${SOCKET_PATH}`);
  });

  function shutdown() {
    log('Chrome disconnected (EOF) — shutting down Native Host');
    clearInterval(keepaliveTimer);
    try {
      server.close();
    } catch {
      // Ignore
    }
    try {
      if (fs.existsSync(SOCKET_PATH)) {
        fs.unlinkSync(SOCKET_PATH);
      }
    } catch {
      // Ignore
    }
    process.exit(0);
  }

  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const isMain =
  process.argv[1] &&
  import.meta.url === `file://${fs.realpathSync(process.argv[1])}`;

if (isMain) {
  startNativeHost();
}
