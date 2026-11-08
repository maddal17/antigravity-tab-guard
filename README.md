# Antigravity Tab Group Guard

[![CI & Security Audit](https://github.com/maddal17/antigravity-tab-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/maddal17/antigravity-tab-guard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-7C3AED.svg)](./LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4F46E5.svg)](./manifest.json)

Zero-trust Chrome Extension (Manifest V3) that isolates AI coding agent browser sessions (**Google Antigravity**, **`chrome-devtools-mcp`**, **Cursor**, **Claude Code**) into a dedicated, color-coded **"Antigravity"** Chrome Tab Group and performs deterministic cleanup upon task completion—without stealing focus, touching personal tabs, or leaving ghost Saved Tab Groups on your Bookmarks Bar.

---

## Why This Exists

The **Chrome DevTools Protocol (CDP)** operates at Chromium's engine/target layer (`Target`, `Page`, `DOM`) and intentionally exposes **no API for Chrome UI Tab Groups** (`chrome.tabGroups` exists exclusively inside the Chrome Extensions layer). As a result, CDP-based agents scatter debug tabs across your active window or leave orphan targets behind.

Existing agent browser extensions typically bridge this gap by opening localhost WebSocket servers, requesting `<all_urls>` host permissions, or injecting content scripts—introducing serious attack surfaces.

**Antigravity Tab Group Guard** solves this with a **zero-network, zero-host-permission, out-of-band birth-URI handshake**.

---

## Architecture

```
[AI Agent / chrome-devtools-mcp]
       │
       ├── 1. Bootstrap (Background): open new tab at `about:blank#antigravity`
       │         └──► [Antigravity Tab Group Guard (MV3 Service Worker)]
       │                 ├─ Verifies clean openerless birth (blocks webpage spoofing)
       │                 ├─ Moves tab to right edge & groups under "Antigravity"
       │                 └─ Auto-captures child popups opened by the session
       │
       ├── 2. Execute: navigate to target URL, inspect DOM, capture screenshots
       │         └──► (Dragging a tab out of the group transfers ownership to you)
       │
       └── 3. Teardown: navigate to `about:blank#antigravity-done` & close tab
                 └──► [Antigravity Tab Group Guard]
                         ├─ Explicitly ungroups before close (zero Saved Tab Group residue)
                         ├─ Cascade-closes any child popups
                         └─ User tabs remain permanently locked & untouched
```

---

## Security Design & Threat Model

Built after reviewing public vulnerabilities and failure modes across commercial and open-source browser agent extensions:

| Threat / Failure Mode | Root Cause in Typical Extensions | Mitigation in `antigravity-tab-guard` |
| :--- | :--- | :--- |
| **Webpage Prompt/Command Injection** *(e.g. ShadowPrompt / ClaudeBleed)* | Wildcard `externally_connectable` origins, injected `content_scripts`, or trusting message origin over sender context. | **Zero `content_scripts`**, **zero `externally_connectable`**, **zero `web_accessible_resources`**, and strict internal sender verification. |
| **Local Bridge Hijacking (SSRF / CSWSH)** | Listening on `ws://127.0.0.1:<port>` without mutual authentication. | **Zero network listeners** and browser-enforced offline CSP (`connect-src 'none'`). |
| **The "Lethal Trifecta" (Data Exfiltration)** | Combining `<all_urls>`, `scripting`/`debugger`/`cookies`, and network access. | **Zero `host_permissions`**, no `scripting`/`debugger`/`cookies` permissions, and zero runtime npm dependencies. |
| **MV3 Service Worker Idle Amnesia** | Storing managed tab IDs only in volatile JS memory wiped after 30s idle. | Serialized async mutex backed by `chrome.storage.session` surviving worker suspension and restarts. |
| **Saved Tab Groups Ghost Clutter** | Calling `tabs.remove` directly causes Chrome Sync to archive closed groups onto the Bookmarks Bar. | Explicitly ungroups managed tabs right before removal so Chrome deletes the group cleanly. |
| **Collapsed Group Screenshot Freezes** | Collapsing a Tab Group freezes Chromium's compositor/WebGL frame loop. | Keeps active group expanded (`collapsed: false`) at the right edge while opening tabs in background mode (`background: true`). |

---

## Installation (30 Seconds)

1. Clone this repository:
   ```bash
   git clone https://github.com/maddal17/antigravity-tab-guard.git
   ```
2. Open Google Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the cloned `antigravity-tab-guard` folder.
5. *(Optional)* Click the **Antigravity Guard** toolbar icon and press **"Test Group Lifecycle (3s Demo)"** to see the purple **Antigravity** group appear and cleanly dissolve.

---

## Agent Rule / Skill Snippet

Add the following rule to your AI coding assistant (Google Antigravity `~/.gemini/config/rules/`, Cursor Rules, or `CLAUDE.md`) so every `chrome-devtools-mcp` / browser session uses the group automatically:

```markdown
# Chrome Debug Mode Tab Group Policy

Whenever opening Chrome tabs via browser automation / DevTools MCP:
1. Never reuse, navigate, or close pre-existing user tabs.
2. Open a new background tab (`background: true`) initialized at exact URI `about:blank#antigravity` first so the Antigravity Tab Group Guard extension isolates it inside the "Antigravity" Tab Group, then navigate that tab to the target URL.
3. Upon completion, navigate the session tab to `about:blank#antigravity-done` right before closing the tab so child popups are swept and no Saved Tab Group ghost pill remains.
```

---

## Running Tests

Zero external dependencies required (uses Node.js built-in test runner, Node 20+):

```bash
npm test
```

---

## License

[MIT](./LICENSE)
