import { NATIVE_CHUNK_SIZE, NATIVE_HOST_NAME } from './constants.js';

const KEY_DEFINITIONS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
};

function parseKeyCombo(combo) {
  const parts = String(combo || '')
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  let modifiers = 0; // 1=Alt, 2=Ctrl, 4=Meta/Cmd, 8=Shift
  let mainKey = 'Enter';

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'alt' || lower === 'option') modifiers |= 1;
    else if (lower === 'ctrl' || lower === 'control') modifiers |= 2;
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command') modifiers |= 4;
    else if (lower === 'shift') modifiers |= 8;
    else mainKey = part;
  }

  if (KEY_DEFINITIONS[mainKey]) {
    return { ...KEY_DEFINITIONS[mainKey], modifiers };
  }

  const upper = mainKey.toUpperCase();
  const isDigit = /^[0-9]$/.test(mainKey);
  const isLetter = /^[a-zA-Z]$/.test(mainKey);
  const keyCode = mainKey.length === 1 ? upper.charCodeAt(0) : 0;
  const code = isLetter
    ? `Key${upper}`
    : isDigit
      ? `Digit${mainKey}`
      : mainKey === '\\'
        ? 'Backslash'
        : mainKey;

  return {
    key: mainKey,
    code,
    keyCode,
    modifiers,
  };
}

/**
 * In-Browser Native Messaging & Debugger Bridge (Claude Extension Model).
 * Connects to the local Native Messaging Host over stdio and executes browser
 * automation inside the isolated "Antigravity" Tab Group without external CDP ports.
 */
export class NativeBridge {
  constructor({
    controller,
    chromeApi = globalThis.chrome,
    hostName = NATIVE_HOST_NAME,
  } = {}) {
    this.controller = controller;
    this.chrome = chromeApi;
    this.hostName = hostName;
    this.port = null;
    this.connected = false;
    this.attachedTabs = new Set();
    this._reconnectTimer = null;

    if (this.chrome?.debugger?.onDetach) {
      this.chrome.debugger.onDetach.addListener((source) => {
        if (source?.tabId != null) {
          this.attachedTabs.delete(source.tabId);
        }
      });
    }
  }

  connect() {
    if (this.port || !this.chrome?.runtime?.connectNative) {
      return false;
    }

    try {
      const port = this.chrome.runtime.connectNative(this.hostName);
      this.port = port;
      this.connected = true;

      port.onMessage.addListener((msg) => {
        this._onNativeMessage(msg);
      });

      port.onDisconnect.addListener(() => {
        const _err = this.chrome.runtime.lastError?.message;
        this.port = null;
        this.connected = false;
        this._scheduleReconnect(3000);
      });

      // Announce readiness to the Native Host
      this._postRaw({
        type: 'hello',
        extensionId: this.chrome.runtime.id,
        version: this.chrome.runtime.getManifest?.()?.version || '2.0.0',
        timestamp: Date.now(),
      });
      return true;
    } catch {
      this.port = null;
      this.connected = false;
      this._scheduleReconnect(5000);
      return false;
    }
  }

  _scheduleReconnect(delayMs = 3000) {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  _postRaw(payload) {
    if (!this.port) return false;
    try {
      this.port.postMessage(payload);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sends a response back to the Native Host, automatically chunking payloads
   * larger than 512 KB so Chrome's 1 MB Native Messaging limit is never exceeded.
   */
  sendResponse(id, responseObj) {
    if (!this.port) return;
    const serialized = JSON.stringify(responseObj);
    if (serialized.length <= NATIVE_CHUNK_SIZE) {
      this._postRaw({
        type: 'response',
        id,
        ...responseObj,
      });
      return;
    }

    const total = Math.ceil(serialized.length / NATIVE_CHUNK_SIZE);
    for (let i = 0; i < total; i++) {
      const slice = serialized.slice(i * NATIVE_CHUNK_SIZE, (i + 1) * NATIVE_CHUNK_SIZE);
      this._postRaw({
        type: 'response_chunk',
        id,
        index: i,
        total,
        chunk: slice,
      });
    }
  }

  async _onNativeMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'keepalive_ping' || msg.method === 'KEEPALIVE_PING') {
      this._postRaw({ type: 'keepalive_pong', timestamp: Date.now() });
      return;
    }

    const { id, method, params = {} } = msg;
    if (!id || !method) return;

    try {
      const data = await this.executeCommand(method, params);
      this.sendResponse(id, { ok: true, data });
    } catch (err) {
      this.sendResponse(id, {
        ok: false,
        error: err?.message || String(err),
      });
    }
  }

  async _resolveManagedTabId(requestedTabId) {
    if (requestedTabId != null) {
      const numId = Number(requestedTabId);
      const isManaged = await this.controller.isManagedTab(numId);
      if (!isManaged) {
        throw new Error(
          `Security Policy Violation: Tab ${numId} is not an Antigravity-managed tab. Touching user tabs is strictly forbidden.`
        );
      }
      return numId;
    }

    const managed = await this.controller.getManagedTabs();
    if (managed.length === 0) {
      throw new Error('No active Antigravity-managed tabs found. Open a tab first.');
    }
    return managed[managed.length - 1].tabId;
  }

  async _waitForTabLoad(tabId, { timeoutMs = 25000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const tab = await this.chrome.tabs.get(tabId);
        if (tab && tab.status === 'complete' && tab.url && !tab.url.startsWith('about:blank#antigravity')) {
          return tab;
        }
        if (tab && tab.status === 'complete' && Date.now() - start > 400) {
          return tab;
        }
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    try {
      return await this.chrome.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  async _withDebugger(tabId, keepAttached, fn) {
    const target = { tabId };
    let freshlyAttached = false;
    if (!this.attachedTabs.has(tabId)) {
      try {
        await this.chrome.debugger.attach(target, '1.3');
        this.attachedTabs.add(tabId);
        freshlyAttached = true;
      } catch (err) {
        const msg = err?.message || String(err);
        if (!msg.includes('Already attached')) {
          throw err;
        }
        this.attachedTabs.add(tabId);
      }
    }

    try {
      return await fn(target);
    } finally {
      if (!keepAttached && (freshlyAttached || this.attachedTabs.has(tabId))) {
        await this._detachDebuggerSafely(tabId);
      }
    }
  }

  async _detachDebuggerSafely(tabId) {
    this.attachedTabs.delete(tabId);
    try {
      await this.chrome.debugger.detach({ tabId });
    } catch {
      // Ignore if already detached or tab closed
    }
  }

  async executeCommand(method, params = {}) {
    const cmd = String(method).toUpperCase();

    switch (cmd) {
      case 'PING':
      case 'STATUS':
      case 'GET_STATUS': {
        const status = await this.controller.getStatus();
        const managedTabs = await this.controller.getManagedTabs();
        return {
          ...status,
          nativeConnected: this.connected,
          extensionId: this.chrome.runtime.id,
          managedTabs,
        };
      }

      case 'LIST_TABS':
      case 'LIST_MANAGED_TABS': {
        const managedTabs = await this.controller.getManagedTabs();
        return { managedTabs };
      }

      case 'OPEN_TAB': {
        const {
          url = 'about:blank',
          active = false,
          waitMs = 0,
          timeoutMs = 25000,
        } = params;
        const created = await this.controller.createManagedTab({
          url,
          active: Boolean(active),
        });
        const liveTab = await this._waitForTabLoad(created.tabId, { timeoutMs });
        if (waitMs > 0) {
          await new Promise((r) => setTimeout(r, Math.min(waitMs, 15000)));
        }
        return {
          tabId: created.tabId,
          windowId: created.windowId,
          groupId: created.groupId,
          url: liveTab?.url || url,
          title: liveTab?.title || '',
        };
      }

      case 'NAVIGATE': {
        const tabId = await this._resolveManagedTabId(params.tabId);
        const { url, active, waitMs = 0, timeoutMs = 25000 } = params;
        if (!url) throw new Error('NAVIGATE requires a target url');

        const updateProps = { url };
        if (typeof active === 'boolean') updateProps.active = active;
        await this.chrome.tabs.update(tabId, updateProps);

        const liveTab = await this._waitForTabLoad(tabId, { timeoutMs });
        if (waitMs > 0) {
          await new Promise((r) => setTimeout(r, Math.min(waitMs, 15000)));
        }
        return {
          tabId,
          url: liveTab?.url || url,
          title: liveTab?.title || '',
        };
      }

      case 'SCREENSHOT': {
        const tabId = await this._resolveManagedTabId(params.tabId);
        const {
          format = 'png',
          quality,
          fullPage = false,
          clip = null,
          keepDebuggerAttached = false,
        } = params;

        return this._withDebugger(tabId, keepDebuggerAttached, async (target) => {
          await this.chrome.debugger.sendCommand(target, 'Page.enable');
          try {
            await this.chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', {
              enabled: true,
            });
          } catch {
            // Optional on some Chrome builds
          }

          const captureParams = {
            format: format === 'jpeg' ? 'jpeg' : 'png',
            fromSurface: true,
            captureBeyondViewport: Boolean(fullPage),
          };
          if (format === 'jpeg' && typeof quality === 'number') {
            captureParams.quality = quality;
          }
          if (clip && typeof clip === 'object') {
            captureParams.clip = { scale: 1, ...clip };
          }

          const res = await this.chrome.debugger.sendCommand(
            target,
            'Page.captureScreenshot',
            captureParams
          );
          const tab = await this.chrome.tabs.get(tabId).catch(() => null);
          return {
            tabId,
            url: tab?.url || '',
            title: tab?.title || '',
            format: captureParams.format,
            base64Data: res.data,
          };
        });
      }

      case 'EVALUATE': {
        const tabId = await this._resolveManagedTabId(params.tabId);
        const {
          expression,
          awaitPromise = true,
          keepDebuggerAttached = false,
        } = params;
        if (!expression) throw new Error('EVALUATE requires an expression string');

        return this._withDebugger(tabId, keepDebuggerAttached, async (target) => {
          const evalRes = await this.chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: Boolean(awaitPromise),
            userGesture: true,
          });
          if (evalRes?.exceptionDetails) {
            throw new Error(
              evalRes.exceptionDetails.exception?.description ||
                evalRes.exceptionDetails.text ||
                'Runtime evaluation exception'
            );
          }
          return {
            tabId,
            value: evalRes?.result?.value,
            type: evalRes?.result?.type,
          };
        });
      }

      case 'SNAPSHOT': {
        const tabId = await this._resolveManagedTabId(params.tabId);
        const snapshotExpr = `(() => {
          const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          };
          const interactive = [];
          const nodes = document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="tab"], [role="treeitem"], [role="menuitem"], h1, h2, h3');
          let idx = 1;
          for (const el of nodes) {
            if (!isVisible(el)) continue;
            const rect = el.getBoundingClientRect();
            const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.value || el.placeholder || '').trim().slice(0, 140);
            if (!text && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') continue;
            interactive.push({
              uid: idx++,
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute('role') || undefined,
              text,
              id: el.id || undefined,
              testId: el.getAttribute('data-testid') || undefined,
              href: el.getAttribute('href') || undefined,
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            });
            if (interactive.length >= 200) break;
          }
          const canvases = Array.from(document.querySelectorAll('canvas')).map((c) => {
            const r = c.getBoundingClientRect();
            return { width: Math.round(r.width), height: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) };
          });
          return {
            url: location.href,
            title: document.title,
            viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
            canvases,
            interactiveCount: interactive.length,
            elements: interactive,
            bodyTextPreview: (document.body?.innerText || '').trim().slice(0, 2000),
          };
        })()`;

        const res = await this.executeCommand('EVALUATE', {
          tabId,
          expression: snapshotExpr,
          keepDebuggerAttached: params.keepDebuggerAttached,
        });
        return {
          tabId,
          ...res.value,
        };
      }

      case 'CLICK': {
        const tabId = await this._resolveManagedTabId(params.tabId);
        const { selector, x, y, keepDebuggerAttached = false } = params;

        return this._withDebugger(tabId, keepDebuggerAttached, async (target) => {
          let clickX = x;
          let clickY = y;

          if (selector) {
            const evalRes = await this.chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
              expression: `(() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return null;
                el.scrollIntoView({ block: 'center', inline: 'center' });
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (el.innerText || '').trim().slice(0, 80) };
              })()`,
              returnByValue: true,
            });
            const coords = evalRes?.result?.value;
            if (!coords) {
              throw new Error(`Selector not found in managed tab: ${selector}`);
            }
            clickX = coords.x;
            clickY = coords.y;
          }

          if (typeof clickX !== 'number' || typeof clickY !== 'number') {
            throw new Error('CLICK requires either a selector or numeric x, y coordinates');
          }

          await this.chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: clickX,
            y: clickY,
          });
          await this.chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: clickX,
            y: clickY,
            button: 'left',
            clickCount: 1,
          });
          await this.chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: clickX,
            y: clickY,
            button: 'left',
            clickCount: 1,
          });

          return { tabId, clicked: { x: clickX, y: clickY, selector: selector || null } };
        });
      }

      case 'FILL': {
        const tabId = await this._resolveManagedTabId(params.tabId);
        const { selector, value = '', keepDebuggerAttached = false } = params;
        if (!selector) throw new Error('FILL requires a selector');

        const res = await this.executeCommand('EVALUATE', {
          tabId,
          keepDebuggerAttached,
          expression: `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
            el.focus();
            el.value = ${JSON.stringify(String(value))};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { filled: true, tag: el.tagName.toLowerCase() };
          })()`,
        });
        return { tabId, selector, ...res.value };
      }

      case 'PRESS_KEY': {
        const tabId = await this._resolveManagedTabId(params.tabId);
        const { key, keepDebuggerAttached = false } = params;
        if (!key) throw new Error('PRESS_KEY requires a key or shortcut combo (e.g. "Shift+2")');

        const parsed = parseKeyCombo(key);
        return this._withDebugger(tabId, keepDebuggerAttached, async (target) => {
          await this.chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'rawKeyDown',
            key: parsed.key,
            code: parsed.code,
            windowsVirtualKeyCode: parsed.keyCode,
            nativeVirtualKeyCode: parsed.keyCode,
            modifiers: parsed.modifiers,
          });
          await this.chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: parsed.key,
            code: parsed.code,
            windowsVirtualKeyCode: parsed.keyCode,
            nativeVirtualKeyCode: parsed.keyCode,
            modifiers: parsed.modifiers,
          });
          return { tabId, key, parsed };
        });
      }

      case 'CDP': {
        const tabId = await this._resolveManagedTabId(params.tabId);
        const { cdpMethod, cdpParams = {}, keepDebuggerAttached = false } = params;
        if (!cdpMethod) throw new Error('CDP command requires cdpMethod');

        return this._withDebugger(tabId, keepDebuggerAttached, async (target) => {
          const result = await this.chrome.debugger.sendCommand(target, cdpMethod, cdpParams);
          return { tabId, cdpMethod, result };
        });
      }

      case 'CLOSE_TAB': {
        const tabId = await this._resolveManagedTabId(params.tabId);
        await this._detachDebuggerSafely(tabId);
        return this.controller.closeManagedTab(tabId);
      }

      case 'TEARDOWN':
      case 'SWEEP_ALL': {
        for (const tabId of [...this.attachedTabs]) {
          await this._detachDebuggerSafely(tabId);
        }
        return this.controller.sweepAllManagedTabs();
      }

      default:
        throw new Error(`Unsupported native bridge command: ${method}`);
    }
  }
}
