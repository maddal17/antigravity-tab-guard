import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GroupController } from '../src/group-controller.js';
import { NativeBridge } from '../src/native-bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

/**
 * In-memory mock of Chrome MV3 Extension APIs (tabs, tabGroups, storage, action, runtime).
 */
function createChromeMock({ initialTabs = [] } = {}) {
  let nextTabId = 100;
  let nextGroupId = 500;
  const sessionStore = {};
  const localStore = {};
  const tabs = new Map();
  const groups = new Map();
  const callLog = [];
  let badgeText = '';

  for (const t of initialTabs) {
    tabs.set(t.id, {
      windowId: 1,
      groupId: -1,
      url: '',
      pendingUrl: '',
      openerTabId: undefined,
      index: tabs.size,
      ...t,
    });
  }

  const chromeApi = {
    runtime: { id: 'ag-guard-extension-id' },
    action: {
      async setBadgeText({ text }) {
        badgeText = text;
      },
      async setBadgeBackgroundColor() {},
    },
    storage: {
      session: {
        async get(key) {
          return key in sessionStore
            ? { [key]: structuredClone(sessionStore[key]) }
            : {};
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) {
            sessionStore[k] = structuredClone(v);
          }
        },
      },
      local: {
        async get(key) {
          return key in localStore
            ? { [key]: structuredClone(localStore[key]) }
            : {};
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) {
            localStore[k] = structuredClone(v);
          }
        },
      },
    },
    tabs: {
      async query(filter = {}) {
        let list = [...tabs.values()];
        if (filter.windowId != null) {
          list = list.filter((t) => t.windowId === filter.windowId);
        }
        if (filter.groupId != null) {
          list = list.filter((t) => t.groupId === filter.groupId);
        }
        return structuredClone(list);
      },
      async create({ windowId = 1, url = 'chrome://newtab/', active = true }) {
        const id = nextTabId++;
        const newTab = {
          id,
          windowId,
          url,
          pendingUrl: url,
          active,
          groupId: -1,
          openerTabId: undefined,
        };
        tabs.set(id, newTab);
        callLog.push({ op: 'tabs.create', id, url, windowId });
        return structuredClone(newTab);
      },
      async move(tabId, { index }) {
        callLog.push({ op: 'tabs.move', tabId, index });
        const t = tabs.get(tabId);
        if (!t) throw new Error('No tab');
        return structuredClone(t);
      },
      async group({ groupId, createProperties, tabIds }) {
        let targetGroupId = groupId;
        if (targetGroupId == null) {
          targetGroupId = nextGroupId++;
          groups.set(targetGroupId, {
            id: targetGroupId,
            windowId: createProperties?.windowId ?? 1,
            title: '',
            color: 'grey',
            collapsed: false,
          });
          callLog.push({ op: 'tabs.group.create', groupId: targetGroupId, tabIds: [...tabIds] });
        } else {
          callLog.push({ op: 'tabs.group.append', groupId: targetGroupId, tabIds: [...tabIds] });
        }
        for (const id of tabIds) {
          const t = tabs.get(id);
          if (t) t.groupId = targetGroupId;
        }
        return targetGroupId;
      },
      async ungroup(tabIds) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        callLog.push({ op: 'tabs.ungroup', tabIds: [...ids] });
        for (const id of ids) {
          const t = tabs.get(id);
          if (t) t.groupId = -1;
        }
      },
      async remove(tabIds) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        callLog.push({ op: 'tabs.remove', tabIds: [...ids] });
        for (const id of ids) {
          tabs.delete(id);
        }
        // Reconcile empty groups
        for (const [gid] of groups) {
          const hasAny = [...tabs.values()].some((t) => t.groupId === gid);
          if (!hasAny) groups.delete(gid);
        }
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      async get(groupId) {
        const g = groups.get(groupId);
        if (!g) throw new Error(`Group ${groupId} not found`);
        return structuredClone(g);
      },
      async update(groupId, props) {
        const g = groups.get(groupId);
        if (!g) throw new Error(`Group ${groupId} not found`);
        Object.assign(g, props);
        callLog.push({ op: 'tabGroups.update', groupId, props: { ...props } });
        return structuredClone(g);
      },
    },
  };

  return {
    chromeApi,
    tabs,
    groups,
    callLog,
    getBadgeText: () => badgeText,
  };
}

test('Security Audit: manifest.json & popup.html adhere to strict Native Messaging + Offline CSP boundaries', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf8')
  );
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_scripts, undefined, 'Must declare ZERO content_scripts');
  assert.equal(manifest.externally_connectable, undefined, 'Must forbid external webpage/extension messaging');
  assert.equal(manifest.web_accessible_resources, undefined, 'Must forbid web fingerprinting');

  const requiredPerms = ['tabs', 'tabGroups', 'storage', 'alarms', 'debugger', 'scripting', 'nativeMessaging'];
  for (const perm of requiredPerms) {
    assert.ok(manifest.permissions.includes(perm), `Required permission missing: ${perm}`);
  }

  const csp = manifest.content_security_policy?.extension_pages || '';
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(csp.includes("connect-src 'none'"), 'Must block all network egress via CSP');
  assert.ok(csp.includes("script-src 'self'"));
  assert.ok(csp.includes("object-src 'none'"));

  const popupHtml = fs.readFileSync(path.join(projectRoot, 'src/popup.html'), 'utf8');
  assert.ok(!/\son\w+\s*=/i.test(popupHtml), 'Popup HTML must not use inline event handlers');
  assert.ok(!/\sstyle\s*=/i.test(popupHtml), 'Popup HTML must not use inline styles');
});

test('NativeBridge: opens managed tabs in Antigravity group, captures screenshots via chrome.debugger, and blocks touching user tabs', async () => {
  const mock = createChromeMock({
    initialTabs: [{ id: 4, windowId: 1, url: 'https://bank.internal/' }],
  });

  // Add tabs.get, tabs.update, and debugger mock
  mock.chromeApi.tabs.get = async (tabId) => {
    const t = mock.tabs.get(tabId);
    if (!t) throw new Error('Tab not found');
    return { ...t, status: 'complete', title: 'Mock Page' };
  };
  mock.chromeApi.tabs.update = async (tabId, props) => {
    const t = mock.tabs.get(tabId);
    if (!t) throw new Error('Tab not found');
    Object.assign(t, props);
    return { ...t };
  };
  mock.chromeApi.debugger = {
    onDetach: { addListener() {} },
    async attach({ tabId }) {
      mock.callLog.push({ op: 'debugger.attach', tabId });
    },
    async detach({ tabId }) {
      mock.callLog.push({ op: 'debugger.detach', tabId });
    },
    async sendCommand({ tabId }, method) {
      mock.callLog.push({ op: 'debugger.sendCommand', tabId, method });
      if (method === 'Page.captureScreenshot') {
        return { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' };
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: { ok: true }, type: 'object' } };
      }
      return {};
    },
  };

  const controller = new GroupController({ chromeApi: mock.chromeApi });
  await controller.initialize();
  const bridge = new NativeBridge({ controller, chromeApi: mock.chromeApi });

  // 1. Refuse to navigate or debug pre-existing user tab #4
  await assert.rejects(
    () => bridge.executeCommand('NAVIGATE', { tabId: 4, url: 'https://evil.example/' }),
    /Security Policy Violation/
  );
  await assert.rejects(
    () => bridge.executeCommand('SCREENSHOT', { tabId: 4 }),
    /Security Policy Violation/
  );

  // 2. Open managed tab via NativeBridge
  const opened = await bridge.executeCommand('OPEN_TAB', {
    url: 'https://www.figma.com/design/abc/test',
    active: false,
  });
  assert.ok(opened.tabId >= 100);
  assert.equal(mock.groups.size, 1, 'Antigravity Tab Group created');

  // 3. Capture screenshot via internal chrome.debugger and verify clean detach
  const shot = await bridge.executeCommand('SCREENSHOT', { tabId: opened.tabId });
  assert.ok(shot.base64Data.length > 10);
  assert.ok(mock.callLog.some((c) => c.op === 'debugger.attach' && c.tabId === opened.tabId));
  assert.ok(mock.callLog.some((c) => c.op === 'debugger.detach' && c.tabId === opened.tabId));

  // 4. Deterministic teardown ungroups before closing
  const closed = await bridge.executeCommand('TEARDOWN');
  assert.equal(closed.closedCount, 1);
  assert.equal(mock.tabs.has(opened.tabId), false);
  assert.equal(mock.tabs.has(4), true, 'User tab #4 remains untouched');
});

test('Standard CDP Lifecycle: encapsulates bootstrap tab into Antigravity group and ungroups before closing', async () => {
  const scheduled = [];
  const mock = createChromeMock({
    initialTabs: [
      { id: 4, windowId: 1, url: 'https://docs.example.com/' },
      { id: 6, windowId: 1, url: 'https://issues.example.com/' },
    ],
  });
  const controller = new GroupController({
    chromeApi: mock.chromeApi,
    scheduleTimeout: (fn, ms) => scheduled.push({ fn, ms }),
  });
  await controller.initialize();

  // 1. CDP Target.createTarget('about:blank')
  const agentTab = { id: 8, windowId: 1, url: 'about:blank', pendingUrl: 'about:blank' };
  mock.tabs.set(8, agentTab);
  await controller.onTabCreated(agentTab);

  // 2. CDP goto('about:blank#antigravity')
  agentTab.url = 'about:blank#antigravity';
  await controller.onTabUpdated(8, { url: 'about:blank#antigravity' }, agentTab);

  assert.equal(mock.groups.size, 1, 'Antigravity group must be created');
  const [group] = [...mock.groups.values()];
  assert.equal(group.title, 'Antigravity');
  assert.equal(group.color, 'purple');
  assert.equal(group.collapsed, false, 'Must keep group expanded while active so screenshots do not freeze');
  assert.equal(mock.getBadgeText(), '1');

  // 3. Navigate to Google Search
  agentTab.url = 'https://www.google.com/search?q=weather';
  await controller.onTabUpdated(8, { url: agentTab.url }, agentTab);
  assert.equal(mock.tabs.get(8).groupId, group.id);

  // 4. Teardown signal: about:blank#antigravity-done
  agentTab.url = 'about:blank#antigravity-done';
  await controller.onTabUpdated(8, { url: 'about:blank#antigravity-done' }, agentTab);

  // Verify ungroup happened immediately BEFORE close to prevent Saved Tab Group residue
  const ungroupIdx = mock.callLog.findIndex((c) => c.op === 'tabs.ungroup');
  assert.ok(ungroupIdx >= 0, 'Must ungroup tabs before removal');

  // Execute fallback timer
  assert.equal(scheduled.length, 1);
  scheduled[0].fn();
  await controller.enqueue(async () => {});

  assert.equal(mock.tabs.has(8), false, 'Agent tab must be closed');
  assert.equal(mock.tabs.has(4), true, 'User docs tab must remain untouched');
  assert.equal(mock.tabs.has(6), true, 'User issues tab must remain untouched');
  assert.equal(mock.getBadgeText(), '');
});

test('Security Defense: blocks URL spoofing from pre-existing tabs, Cmd+T tabs, and malicious window.open popups', async () => {
  const mock = createChromeMock({
    initialTabs: [{ id: 4, windowId: 1, url: 'https://docs.example.com/' }],
  });
  const controller = new GroupController({ chromeApi: mock.chromeApi });
  await controller.initialize();

  // Attack 1: Pre-existing tab navigates to about:blank#antigravity
  await controller.onTabUpdated(
    4,
    { url: 'about:blank#antigravity' },
    { id: 4, windowId: 1, url: 'about:blank#antigravity' }
  );
  assert.equal(mock.groups.size, 0, 'Pre-existing user tab must never be claimed');

  // Attack 2: Human opens Cmd+T (chrome://newtab/), visits evil.com, which redirects to about:blank#antigravity
  const humanTab = { id: 12, windowId: 1, pendingUrl: 'chrome://newtab/', url: '' };
  mock.tabs.set(12, humanTab);
  await controller.onTabCreated(humanTab);
  await controller.onTabUpdated(12, { url: 'https://evil.example/' }, { ...humanTab, url: 'https://evil.example/' });
  await controller.onTabUpdated(12, { url: 'about:blank#antigravity' }, { ...humanTab, url: 'about:blank#antigravity' });
  assert.equal(mock.groups.size, 0, 'External website redirect must never claim tab');

  // Attack 3: evil.example calls window.open('about:blank#antigravity') -> has openerTabId = 12
  const popupAttack = {
    id: 13,
    windowId: 1,
    openerTabId: 12,
    pendingUrl: 'about:blank#antigravity',
    url: 'about:blank#antigravity',
  };
  mock.tabs.set(13, popupAttack);
  await controller.onTabCreated(popupAttack);
  await controller.onTabUpdated(13, { url: 'about:blank#antigravity' }, popupAttack);
  assert.equal(mock.groups.size, 0, 'Malicious popup with user openerTabId must never be claimed');
});

test('Security Defense (ClaudeBleed mitigation): rejects runtime messages from web tabs or external extensions', async () => {
  const mock = createChromeMock();
  const controller = new GroupController({ chromeApi: mock.chromeApi });
  await controller.initialize();

  await assert.rejects(
    () => controller.handleInternalMessage({ type: 'SWEEP_ALL' }, { id: 'rogue-extension-id' }),
    /Unauthorized message sender context/
  );
  await assert.rejects(
    () =>
      controller.handleInternalMessage(
        { type: 'SWEEP_ALL' },
        { id: 'ag-guard-extension-id', tab: { id: 4 } }
      ),
    /Unauthorized message sender context/
  );
  const okStatus = await controller.handleInternalMessage(
    { type: 'GET_STATUS' },
    { id: 'ag-guard-extension-id' }
  );
  assert.equal(okStatus.managedCount, 0);
});

test('Child Popup Containment & MV3 Service Worker Cold Restart Survival', async () => {
  const mock = createChromeMock({
    initialTabs: [{ id: 1, windowId: 1, url: 'https://issues.example.com/' }],
  });

  // Worker Instance #1 creates root tab + child popup
  const worker1 = new GroupController({ chromeApi: mock.chromeApi });
  await worker1.initialize();

  const rootTab = { id: 20, windowId: 1, url: 'about:blank#antigravity', pendingUrl: 'about:blank#antigravity' };
  mock.tabs.set(20, rootTab);
  await worker1.onTabCreated(rootTab);

  const childPopup = { id: 21, windowId: 1, openerTabId: 20, url: 'https://oauth.example.com/' };
  mock.tabs.set(21, childPopup);
  await worker1.onTabCreated(childPopup);

  assert.equal(mock.tabs.get(20).groupId, mock.tabs.get(21).groupId, 'Child popup must join Antigravity group');
  assert.equal(mock.getBadgeText(), '2');

  // Simulate MV3 Service Worker killed after 30s idle -> fresh Worker Instance #2 wakes on tabs.onRemoved(20)
  const worker2 = new GroupController({ chromeApi: mock.chromeApi });
  mock.tabs.delete(20);
  await worker2.onTabRemoved(20, { windowId: 1, isWindowClosing: false });

  assert.equal(mock.tabs.has(21), false, 'Orphan child popup must be cascade-closed when root tab closes');
  assert.equal(mock.tabs.has(1), true, 'User tab remains intact');
  assert.equal(mock.getBadgeText(), '');
});

test('Human Drag-Out Override & Last-Tab Window Protection & Concurrent Race Serialization', async () => {
  // 1. Concurrent race: 2 root tabs created in parallel in an otherwise empty window
  const mock = createChromeMock({ initialTabs: [] });
  const controller = new GroupController({ chromeApi: mock.chromeApi });
  await controller.initialize();

  const t1 = { id: 31, windowId: 1, url: 'about:blank#antigravity' };
  const t2 = { id: 32, windowId: 1, url: 'about:blank#antigravity' };
  mock.tabs.set(31, t1);
  mock.tabs.set(32, t2);

  await Promise.all([controller.onTabCreated(t1), controller.onTabCreated(t2)]);

  const groupCreations = mock.callLog.filter((c) => c.op === 'tabs.group.create');
  assert.equal(groupCreations.length, 1, 'Mutex must prevent creating duplicate Antigravity groups');
  assert.equal(mock.tabs.get(31).groupId, mock.tabs.get(32).groupId);

  // 2. Human drags t1 out of the group (groupId becomes -1)
  t1.groupId = -1;
  await controller.onTabUpdated(31, { groupId: -1 }, t1);

  // Move t1 out conceptually; now simulate closing only remaining managed tab t2 when t1 was also closed by user
  mock.tabs.delete(31);
  await controller.onTabRemoved(31, { windowId: 1, isWindowClosing: false });

  // Now t2 is the ONLY tab left in window 1! Sweep all -> must spawn chrome://newtab/ before removing t2!
  await controller.sweepAllManagedTabs();

  assert.equal(mock.tabs.has(32), false, 'Managed tab t2 closed');
  const remainingTabs = [...mock.tabs.values()];
  assert.equal(remainingTabs.length, 1, 'Replacement New Tab created so Chrome window does not close');
  assert.equal(remainingTabs[0].url, 'chrome://newtab/');
});

test('Cold Browser Restart Race: initialize() + onTabCreated(about:blank) waking simultaneously still groups tab', async () => {
  // Simulate Chrome cold wake where tab 80 (about:blank) already exists in tabs.query({}) BEFORE initialize() runs
  const agentTab = { id: 80, windowId: 1, url: 'about:blank', pendingUrl: 'about:blank' };
  const mock = createChromeMock({
    initialTabs: [
      { id: 2, windowId: 1, url: 'https://docs.example.com/' },
      agentTab,
    ],
  });
  const controller = new GroupController({ chromeApi: mock.chromeApi });

  // Top-level initialize() runs right before onTabCreated(agentTab)
  const pInit = controller.initialize();
  const pCreate = controller.onTabCreated(agentTab);
  await Promise.all([pInit, pCreate]);

  // 5ms later CDP navigates tab 80 to about:blank#antigravity
  agentTab.url = 'about:blank#antigravity';
  mock.tabs.get(80).url = 'about:blank#antigravity';
  await controller.onTabUpdated(80, { url: 'about:blank#antigravity' }, agentTab);

  assert.equal(mock.groups.size, 1, 'Must successfully group tab 80 even on cold browser wake');
  assert.equal(mock.tabs.get(2).groupId, -1, 'Restored user tab must stay ungrouped');
});

