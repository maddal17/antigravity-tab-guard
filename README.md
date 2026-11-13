# Antigravity Tab Group Guard (`v2.0` — Native Messaging Bridge)

[![CI & Security Audit](https://github.com/maddal17/antigravity-tab-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/maddal17/antigravity-tab-guard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-7C3AED.svg)](./LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4F46E5.svg)](./manifest.json)

In-browser Chrome Extension (Manifest V3) and **Native Messaging Bridge** (modeled after the Claude Extension architecture) that drives **Google Antigravity** browser sessions inside a dedicated, color-coded **"Antigravity"** Chrome Tab Group—with **zero *"Allow remote debugging?"* modal prompts**, **zero network sockets**, **background screenshot capture**, and **deterministic teardown**.

---

## Why v2.0 Uses the Native Messaging Bridge (Claude Model)

Connecting external tools (`chrome-devtools-mcp`, Puppeteer) to Chrome's external TCP port (`9222` / `DevToolsActivePort`) triggers Chrome's blocking modal security prompt (*"Allow remote debugging?"*) on every new connection.

**Antigravity Tab Group Guard v2.0** eliminates external TCP debugging ports entirely:
1. **OS Native Messaging Pipe (`com.antigravity.tab_guard`)**: Chrome spawns the local Native Host (`native-host/run-host.sh`) over standard I/O (`stdin`/`stdout`) and exposes a user-only (`0600`) Unix Domain Socket (`/tmp/antigravity-browser-bridge-<user>/bridge.sock`).
2. **In-Browser Extension Debugger (`chrome.debugger`)**: The extension itself executes navigation, DOM snapshots, input dispatch, and Retina screenshot capture strictly on tabs inside the **"Antigravity"** Tab Group—with **zero modal prompts**.
3. **Strict User-Tab Firewall**: Pre-existing personal and corporate tabs are permanently disqualified (`disqualifiedTabIds`). Any command targeting a non-managed tab is rejected at the extension boundary.

---

## Architecture

```
[Antigravity Agent / CLI (`ag-browser`) / MCP (`antigravity-browser`)]
       │
       │  1. Local Unix Domain Socket (`/tmp/antigravity-browser-bridge-<user>/bridge.sock`, mode 0600)
       ▼
[Native Messaging Host (`com.antigravity.tab_guard` -> `native-host/host.js`)]
       │
       │  2. Chrome Native Messaging Pipe (4-byte length-prefixed JSON, 512 KB chunked streaming)
       ▼
[Antigravity Tab Group Guard (MV3 Service Worker)]
       │
       ├── Tab Group Isolation (`chrome.tabs` + `chrome.tabGroups`)
       │     ├─ Opens tabs in background (`active: false`) at right edge (`index: -1`)
       │     ├─ Groups session & child popups under purple "Antigravity" group (`collapsed: false`)
       │     └─ Explicitly ungroups BEFORE closing on teardown (zero Saved Tab Groups ghost pills)
       │
       └── In-Browser Automation Engine (`chrome.debugger` + `chrome.scripting`)
             ├─ Captures background screenshots via `Page.captureScreenshot`
             ├─ Extracts DOM / Accessibility / Canvas snapshots
             └─ Dispatches clicks, form fills, and keyboard shortcuts (`Shift+2`, `Meta+\`)
```

---

## Restraints & Mitigations

| Boundary / Failure Mode | Root Cause | Mitigation in `antigravity-tab-guard v2.0` |
| :--- | :--- | :--- |
| **Modal Security Gate (`Allow remote debugging?`)** | External connections to TCP port `9222` / `DevToolsActivePort` require manual confirmation on every session. | **Zero external CDP port**. All automation runs inside the extension via `nativeMessaging` + `debugger` permissions. |
| **Native Messaging 1 MB Limit** | Chrome disconnects `connectNative` ports if an extension sends >1 MB in a single `postMessage` (e.g. Retina PNG screenshots). | Automatic **512 KB chunked streaming** (`response_chunk`) reassembled by the Native Host and written directly to disk. |
| **MV3 Service Worker 30s Idle Suspension** | Chrome suspends MV3 background workers after 30s of inactivity. | Native Host sends a 20s heartbeat (`keepalive_ping`) over stdio, plus `ag-browser` auto-wakes cold workers via `about:blank#antigravity-wake`. |
| **Saved Tab Groups Ghost Clutter** | Calling `tabs.remove` directly causes Chrome Sync to archive closed groups onto the Bookmarks Bar. | Explicitly calls `tabs.ungroup` before `tabs.remove` on teardown. |
| **Webpage / Localhost Attack Surface** | Opening localhost WebSocket servers or injecting `content_scripts` exposes SSRF / prompt injection vectors. | **Zero `content_scripts`**, **zero `externally_connectable`**, offline CSP (`connect-src 'none'`), and filesystem-permissioned (`0600`) Unix Domain Socket. |

---

## CLI & MCP Usage (`ag-browser`)

```bash
# Check Native Bridge & Extension status
ag-browser status

# Open URL inside the isolated purple "Antigravity" Tab Group (background mode)
ag-browser open "https://example.com" --wait 1000

# Inspect structured DOM, interactive elements, and canvas dimensions
ag-browser snapshot

# Capture Retina PNG screenshot directly to disk (without stealing focus)
ag-browser screenshot /tmp/capture.png

# Dispatch keyboard shortcut (e.g. Figma zoom-to-fit) or click
ag-browser key "Shift+2"
ag-browser click "button.submit"

# Deterministically ungroup and close all Antigravity tabs
ag-browser teardown
```

---

## Running Tests

```bash
npm test
```

---

## License

[MIT](./LICENSE)
