#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const username = os.userInfo().username || 'user';
const SOCKET_DIR = `/tmp/antigravity-browser-bridge-${username}`;
const SOCKET_PATH = path.join(SOCKET_DIR, 'bridge.sock');

function wakeChromeExtension() {
  return new Promise((resolve) => {
    const script =
      'tell application "Google Chrome" to make new tab at end of tabs of front window with properties {URL:"about:blank#antigravity-wake"}';
    execFile('osascript', ['-e', script], { timeout: 3000 }, () => {
      resolve();
    });
  });
}

async function ensureBridgeSocket({ timeoutMs = 4500 } = {}) {
  if (fs.existsSync(SOCKET_PATH)) {
    return SOCKET_PATH;
  }

  await wakeChromeExtension();

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(SOCKET_PATH)) {
      return SOCKET_PATH;
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  throw new Error(
    `Antigravity Native Host socket not found at ${SOCKET_PATH}. Ensure Google Chrome is running and the Antigravity Tab Group Guard extension is enabled.`
  );
}

export async function sendBridgeCommand(method, params = {}, { Retried = false } = {}) {
  const sockPath = await ensureBridgeSocket();

  return new Promise((resolve, reject) => {
    const id = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const client = net.createConnection(sockPath);
    let buf = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(new Error(`Bridge command '${method}' timed out`));
    }, (params.timeoutMs || 30000) + 5000);

    client.on('connect', () => {
      client.write(JSON.stringify({ id, method, params }) + '\n');
    });

    client.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id || !msg.id) {
            settled = true;
            clearTimeout(timer);
            client.end();
            if (msg.ok) {
              resolve(msg.data);
            } else {
              reject(new Error(msg.error || `Command ${method} failed`));
            }
          }
        } catch (err) {
          settled = true;
          clearTimeout(timer);
          client.end();
          reject(err);
        }
      }
    });

    client.on('error', async (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!Retried && (err.code === 'ECONNREFUSED' || err.code === 'ENOENT')) {
        try {
          fs.unlinkSync(SOCKET_PATH);
        } catch {
          // Ignore
        }
        try {
          const retryRes = await sendBridgeCommand(method, params, { Retried: true });
          resolve(retryRes);
          return;
        } catch (retryErr) {
          reject(retryErr);
          return;
        }
      }
      reject(err);
    });
  });
}

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next != null && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/**
 * MCP Server implementation over stdio (`ag-browser mcp`)
 */
function runMcpServer() {
  const TOOLS = [
    {
      name: 'ag_open_tab',
      description:
        'Open a new background tab inside the isolated Chrome "Antigravity" Tab Group and navigate to the target URL without stealing user focus.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Target URL to open' },
          waitMs: { type: 'number', description: 'Optional post-load wait time in milliseconds' },
          active: { type: 'boolean', description: 'Focus tab (default false to keep background)' },
        },
        required: ['url'],
      },
    },
    {
      name: 'ag_navigate',
      description: 'Navigate an existing Antigravity-managed tab to a new URL.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Target URL' },
          tabId: { type: 'number', description: 'Managed tabId (optional, defaults to latest)' },
          waitMs: { type: 'number', description: 'Optional post-load wait time in milliseconds' },
        },
        required: ['url'],
      },
    },
    {
      name: 'ag_snapshot',
      description:
        'Capture structured DOM, interactive elements (with coordinates & selectors), canvas dimensions, and text preview from the managed Chrome tab.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Managed tabId (optional)' },
        },
      },
    },
    {
      name: 'ag_screenshot',
      description:
        'Capture a visual PNG screenshot of the managed Chrome tab via the extension debugger and write it to filePath.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Absolute path to save the PNG file' },
          tabId: { type: 'number', description: 'Managed tabId (optional)' },
          fullPage: { type: 'boolean', description: 'Capture beyond viewport' },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'ag_evaluate',
      description: 'Evaluate a JavaScript expression inside the managed Chrome tab.',
      inputSchema: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'JavaScript expression to evaluate' },
          tabId: { type: 'number', description: 'Managed tabId (optional)' },
        },
        required: ['expression'],
      },
    },
    {
      name: 'ag_click',
      description: 'Click an element by CSS selector or (x, y) coordinates inside the managed tab.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to click' },
          x: { type: 'number', description: 'X coordinate if clicking by coordinates' },
          y: { type: 'number', description: 'Y coordinate if clicking by coordinates' },
          tabId: { type: 'number', description: 'Managed tabId (optional)' },
        },
      },
    },
    {
      name: 'ag_fill',
      description: 'Fill an input or textarea element matching CSS selector in the managed tab.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector' },
          value: { type: 'string', description: 'Text value to fill' },
          tabId: { type: 'number', description: 'Managed tabId (optional)' },
        },
        required: ['selector', 'value'],
      },
    },
    {
      name: 'ag_press_key',
      description:
        'Dispatch a keyboard key or shortcut combo (e.g. "Shift+2", "Meta+\\", "Escape", "Enter") to the managed tab.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key or shortcut combo' },
          tabId: { type: 'number', description: 'Managed tabId (optional)' },
        },
        required: ['key'],
      },
    },
    {
      name: 'ag_teardown',
      description:
        'Deterministically ungroup all managed tabs and close the "Antigravity" Tab Group cleanly with zero Saved Tab Group residue.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];

  let buffer = '';
  process.stdin.on('data', async (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg.method === 'initialize') {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: {
                name: 'antigravity-browser',
                version: '2.0.0',
              },
            },
          }) + '\n'
        );
      } else if (msg.method === 'tools/list') {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { tools: TOOLS },
          }) + '\n'
        );
      } else if (msg.method === 'tools/call') {
        const name = msg.params?.name;
        const args = msg.params?.arguments || {};
        const mapMethod = {
          ag_open_tab: 'OPEN_TAB',
          ag_navigate: 'NAVIGATE',
          ag_snapshot: 'SNAPSHOT',
          ag_screenshot: 'SCREENSHOT',
          ag_evaluate: 'EVALUATE',
          ag_click: 'CLICK',
          ag_fill: 'FILL',
          ag_press_key: 'PRESS_KEY',
          ag_teardown: 'TEARDOWN',
        };
        const bridgeMethod = mapMethod[name];
        try {
          const result = await sendBridgeCommand(bridgeMethod, args);
          process.stdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
              },
            }) + '\n'
          );
        } catch (err) {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                isError: true,
                content: [{ type: 'text', text: err.message }],
              },
            }) + '\n'
          );
        }
      }
    }
  });
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const subcommand = (rawArgs[0] || 'status').toLowerCase();
  if (subcommand === 'mcp') {
    runMcpServer();
    return;
  }

  const { positional, flags } = parseFlags(rawArgs.slice(1));
  const tabId = flags.tab ? Number(flags.tab) : undefined;
  const waitMs = flags.wait ? Number(flags.wait) : undefined;

  let result;
  switch (subcommand) {
    case 'status':
    case 'ping':
      result = await sendBridgeCommand('STATUS');
      break;
    case 'list':
    case 'tabs':
      result = await sendBridgeCommand('LIST_MANAGED_TABS');
      break;
    case 'open':
      result = await sendBridgeCommand('OPEN_TAB', {
        url: positional[0] || 'about:blank',
        active: Boolean(flags.active),
        waitMs,
      });
      break;
    case 'navigate':
    case 'goto':
      result = await sendBridgeCommand('NAVIGATE', {
        tabId,
        url: positional[0],
        waitMs,
      });
      break;
    case 'snapshot':
    case 'dom':
      result = await sendBridgeCommand('SNAPSHOT', { tabId });
      break;
    case 'screenshot':
      result = await sendBridgeCommand('SCREENSHOT', {
        tabId,
        filePath: path.resolve(positional[0] || 'screenshot.png'),
        fullPage: Boolean(flags.full),
      });
      break;
    case 'eval':
    case 'evaluate':
      result = await sendBridgeCommand('EVALUATE', {
        tabId,
        expression: positional.join(' '),
      });
      break;
    case 'click':
      if (positional.length >= 2 && !Number.isNaN(Number(positional[0]))) {
        result = await sendBridgeCommand('CLICK', {
          tabId,
          x: Number(positional[0]),
          y: Number(positional[1]),
        });
      } else {
        result = await sendBridgeCommand('CLICK', {
          tabId,
          selector: positional[0],
        });
      }
      break;
    case 'fill':
      result = await sendBridgeCommand('FILL', {
        tabId,
        selector: positional[0],
        value: positional.slice(1).join(' '),
      });
      break;
    case 'key':
    case 'press':
      result = await sendBridgeCommand('PRESS_KEY', {
        tabId,
        key: positional[0],
      });
      break;
    case 'cdp':
      result = await sendBridgeCommand('CDP', {
        tabId,
        cdpMethod: positional[0],
        cdpParams: positional[1] ? JSON.parse(positional[1]) : {},
      });
      break;
    case 'close':
      result = await sendBridgeCommand('CLOSE_TAB', { tabId });
      break;
    case 'teardown':
    case 'sweep':
      result = await sendBridgeCommand('TEARDOWN');
      break;
    default:
      throw new Error(`Unknown command '${subcommand}'. Supported: status, open, navigate, snapshot, screenshot, eval, click, fill, key, cdp, close, teardown`);
  }

  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exit(1);
  });
}
