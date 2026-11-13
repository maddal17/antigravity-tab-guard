import {
  ALLOWED_GROUP_COLORS,
  BIRTH_CANDIDATE_TTL_MS,
  DEFAULT_GROUP_COLOR,
  DEFAULT_MAX_SESSION_AGE_MS,
  DONE_FALLBACK_CLOSE_DELAY_MS,
  GROUP_TITLE,
  PREFS_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  TAB_GROUP_ID_NONE,
  isBootstrapSignalUrl,
  isCleanBlankBirthUrl,
  isTeardownSignalUrl,
} from './constants.js';

function createEmptySessionState() {
  return {
    initialized: false,
    managedTabs: {},       // tabId -> { windowId, role: 'root'|'child', claimedAt, grouped }
    birthCandidates: {},   // tabId -> createdAt timestamp
    disqualifiedTabIds: [],
    closingTabIds: [],
    windowGroups: {},      // windowId -> groupId
  };
}

function createDefaultPrefs() {
  return {
    groupColor: DEFAULT_GROUP_COLOR,
    staleSweepEnabled: true,
    maxSessionAgeMs: DEFAULT_MAX_SESSION_AGE_MS,
  };
}

/**
 * Zero-trust Tab Group Lifecycle Controller.
 * Serializes all Chrome tab/group mutations via an internal async mutex queue
 * and persists state to chrome.storage.session to survive MV3 worker suspension.
 */
export class GroupController {
  constructor({
    chromeApi = globalThis.chrome,
    now = () => Date.now(),
    scheduleTimeout = (fn, ms) => setTimeout(fn, ms),
  } = {}) {
    this.chrome = chromeApi;
    this.now = now;
    this.scheduleTimeout = scheduleTimeout;
    this._queue = Promise.resolve();
  }

  enqueue(task) {
    const run = this._queue.then(() => task());
    this._queue = run.catch((err) => {
      console.error('[AntigravityTabGuard] Queue task error:', err);
    });
    return run;
  }

  async _loadPrefs() {
    try {
      const stored = await this.chrome.storage.local.get(PREFS_STORAGE_KEY);
      const raw = stored?.[PREFS_STORAGE_KEY] || {};
      const defaults = createDefaultPrefs();
      return {
        groupColor: ALLOWED_GROUP_COLORS.includes(raw.groupColor)
          ? raw.groupColor
          : defaults.groupColor,
        staleSweepEnabled:
          typeof raw.staleSweepEnabled === 'boolean'
            ? raw.staleSweepEnabled
            : defaults.staleSweepEnabled,
        maxSessionAgeMs:
          typeof raw.maxSessionAgeMs === 'number' && raw.maxSessionAgeMs >= 60_000
            ? raw.maxSessionAgeMs
            : defaults.maxSessionAgeMs,
      };
    } catch {
      return createDefaultPrefs();
    }
  }

  async _savePrefs(prefs) {
    await this.chrome.storage.local.set({ [PREFS_STORAGE_KEY]: prefs });
  }

  async _loadState() {
    const stored = await this.chrome.storage.session.get(SESSION_STORAGE_KEY);
    const raw = stored?.[SESSION_STORAGE_KEY];
    const state = raw
      ? {
          initialized: Boolean(raw.initialized),
          managedTabs: { ...(raw.managedTabs || {}) },
          birthCandidates: { ...(raw.birthCandidates || {}) },
          disqualifiedTabIds: Array.isArray(raw.disqualifiedTabIds)
            ? [...new Set(raw.disqualifiedTabIds)]
            : [],
          closingTabIds: Array.isArray(raw.closingTabIds)
            ? [...new Set(raw.closingTabIds)]
            : [],
          windowGroups: { ...(raw.windowGroups || {}) },
        }
      : createEmptySessionState();

    if (!state.initialized) {
      const existingTabs = await this.chrome.tabs.query({});
      const disqualified = new Set(state.disqualifiedTabIds);
      for (const t of existingTabs) {
        if (t.id == null) continue;
        const url = t.pendingUrl || t.url || '';
        // Leave brand-new openerless blank/bootstrap tabs eligible on cold wake; protect all existing user tabs.
        if (t.openerTabId == null && isCleanBlankBirthUrl(url)) {
          continue;
        }
        disqualified.add(t.id);
      }
      state.disqualifiedTabIds = [...disqualified];
      state.initialized = true;
      await this._saveState(state);
    }

    this._pruneExpiredCandidates(state);
    return state;
  }

  async _saveState(state) {
    // Keep disqualifiedTabIds bounded to open/recent tabs so session storage stays tiny
    if (state.disqualifiedTabIds.length > 2000) {
      state.disqualifiedTabIds = state.disqualifiedTabIds.slice(-1000);
    }
    await this.chrome.storage.session.set({ [SESSION_STORAGE_KEY]: state });
    await this._updateBadge(state);
  }

  _pruneExpiredCandidates(state) {
    const cutoff = this.now() - BIRTH_CANDIDATE_TTL_MS;
    for (const [key, ts] of Object.entries(state.birthCandidates)) {
      if (ts < cutoff) {
        delete state.birthCandidates[key];
      }
    }
  }

  async _updateBadge(state) {
    if (!this.chrome.action?.setBadgeText) return;
    const count = Object.keys(state.managedTabs).length;
    try {
      await this.chrome.action.setBadgeText({
        text: count > 0 ? String(count) : '',
      });
      if (count > 0 && this.chrome.action?.setBadgeBackgroundColor) {
        await this.chrome.action.setBadgeBackgroundColor({ color: '#7C3AED' });
      }
    } catch {
      // Ignore badge update failures during browser shutdown
    }
  }

  async _ensureTabInAntigravityGroup(state, tabId, windowId) {
    const prefs = await this._loadPrefs();
    const winKey = String(windowId);
    let groupId = state.windowGroups[winKey];
    let groupValid = false;

    if (typeof groupId === 'number' && groupId !== TAB_GROUP_ID_NONE) {
      try {
        const existingGroup = await this.chrome.tabGroups.get(groupId);
        if (existingGroup && existingGroup.windowId === windowId) {
          groupValid = true;
        }
      } catch {
        groupValid = false;
      }
    }

    if (!groupValid) {
      // Move first Antigravity tab to the right end of the tab bar to avoid shifting user tabs
      try {
        await this.chrome.tabs.move(tabId, { index: -1 });
      } catch {
        // Tab may be pinned or mid-transition; safe to continue
      }
      groupId = await this.chrome.tabs.group({
        createProperties: { windowId },
        tabIds: [tabId],
      });
      state.windowGroups[winKey] = groupId;
    } else {
      await this.chrome.tabs.group({
        groupId,
        tabIds: [tabId],
      });
    }

    // Keep collapsed: false while active so Chromium's compositor does not freeze screenshots/WebGL!
    await this.chrome.tabGroups.update(groupId, {
      title: GROUP_TITLE,
      color: prefs.groupColor,
      collapsed: false,
    });

    if (state.managedTabs[String(tabId)]) {
      state.managedTabs[String(tabId)].grouped = true;
      state.managedTabs[String(tabId)].windowId = windowId;
    }
    return groupId;
  }

  async _ungroupAndRemoveTabsSafely(state, windowId, tabIdsToClose) {
    if (!tabIdsToClose.length) return;

    // Verify which tabs actually still exist in Chrome
    const openWindowTabs = await this.chrome.tabs.query({ windowId });
    const openIdsSet = new Set(openWindowTabs.map((t) => t.id));
    const existingToClose = tabIdsToClose.filter((id) => openIdsSet.has(id));
    if (!existingToClose.length) {
      for (const id of tabIdsToClose) {
        delete state.managedTabs[String(id)];
      }
      return;
    }

    const closingSet = new Set(state.closingTabIds);
    for (const id of existingToClose) {
      closingSet.add(id);
      delete state.managedTabs[String(id)];
    }
    state.closingTabIds = [...closingSet];

    // If closing all managed tabs would close the last tab in the user's window,
    // spawn a clean New Tab first so the Chrome window itself stays alive.
    const remainingUserTabs = openWindowTabs.filter(
      (t) => t.id != null && !existingToClose.includes(t.id)
    );
    if (remainingUserTabs.length === 0 && openWindowTabs.length > 0) {
      try {
        const replacement = await this.chrome.tabs.create({
          windowId,
          url: 'chrome://newtab/',
          active: true,
        });
        if (replacement?.id != null) {
          const disq = new Set(state.disqualifiedTabIds);
          disq.add(replacement.id);
          state.disqualifiedTabIds = [...disq];
        }
      } catch {
        // Window may already be closing
      }
    }

    // CRITICAL: Ungroup BEFORE removing tabs so Chrome's "Automatically save tab groups"
    // feature sees an explicitly disbanded group rather than saving a ghost pill to the Bookmarks Bar!
    try {
      await this.chrome.tabs.ungroup(existingToClose);
    } catch {
      // Ignore if already ungrouped
    }

    try {
      await this.chrome.tabs.remove(existingToClose);
    } catch {
      // Ignore if concurrently closed by CDP close_page
    }

    // If no managed tabs remain in this window, drop cached groupId
    const anyLeftInWindow = Object.values(state.managedTabs).some(
      (entry) => entry.windowId === windowId
    );
    if (!anyLeftInWindow) {
      delete state.windowGroups[String(windowId)];
    }
  }

  async initialize() {
    return this.enqueue(async () => {
      const state = await this._loadState();
      await this._reconcileWithBrowser(state);
      await this._saveState(state);
    });
  }

  async _reconcileWithBrowser(state) {
    const openTabs = await this.chrome.tabs.query({});
    const openIds = new Set(openTabs.map((t) => t.id));
    for (const key of Object.keys(state.managedTabs)) {
      if (!openIds.has(Number(key))) {
        delete state.managedTabs[key];
      }
    }
  }

  async onTabCreated(tab) {
    return this.enqueue(async () => {
      if (!tab || tab.id == null) return;
      const state = await this._loadState();
      const tabId = tab.id;
      const key = String(tabId);
      const disq = new Set(state.disqualifiedTabIds);

      if (state.managedTabs[key]) return;

      // Path 1: Child popup/tab opened by an existing Antigravity-managed tab
      if (tab.openerTabId != null) {
        const parentEntry = state.managedTabs[String(tab.openerTabId)];
        if (parentEntry) {
          state.managedTabs[key] = {
            windowId: tab.windowId,
            role: 'child',
            claimedAt: this.now(),
            grouped: false,
          };
          try {
            await this._ensureTabInAntigravityGroup(state, tabId, tab.windowId);
          } catch (err) {
            console.warn('[AntigravityTabGuard] Failed grouping child tab:', err);
          }
          await this._saveState(state);
          return;
        }
        // Opened from a personal/user tab -> strictly user-owned!
        disq.add(tabId);
        state.disqualifiedTabIds = [...disq];
        await this._saveState(state);
        return;
      }

      // Path 2: Openerless tab — inspect birth URL
      const initialUrl = tab.pendingUrl || tab.url || '';
      if (/^about:blank#antigravity-wake$/i.test(initialUrl)) {
        try {
          await this.chrome.tabs.remove(tabId);
        } catch {
          // Ignore
        }
        return;
      }

      if (isBootstrapSignalUrl(initialUrl)) {
        disq.delete(tabId);
        state.disqualifiedTabIds = [...disq];
        delete state.birthCandidates[key];
        state.managedTabs[key] = {
          windowId: tab.windowId,
          role: 'root',
          claimedAt: this.now(),
          grouped: false,
        };
        try {
          await this._ensureTabInAntigravityGroup(state, tabId, tab.windowId);
        } catch (err) {
          console.warn('[AntigravityTabGuard] Failed grouping root tab on create:', err);
        }
        await this._saveState(state);
        return;
      }

      if (isCleanBlankBirthUrl(initialUrl)) {
        // Candidate for CDP Target.createTarget('about:blank') -> goto('about:blank#antigravity')
        disq.delete(tabId);
        state.disqualifiedTabIds = [...disq];
        state.birthCandidates[key] = this.now();
        await this._saveState(state);
        return;
      }

      // Human New Tab (chrome://newtab/), omnibox URL, or bookmark -> permanently user-owned!
      disq.add(tabId);
      state.disqualifiedTabIds = [...disq];
      await this._saveState(state);
    });
  }

  async onTabUpdated(tabId, changeInfo, tab) {
    return this.enqueue(async () => {
      if (tabId == null) return;
      const state = await this._loadState();
      const key = String(tabId);
      const disq = new Set(state.disqualifiedTabIds);
      const closingSet = new Set(state.closingTabIds);
      const url = changeInfo?.url ?? tab?.pendingUrl ?? tab?.url ?? '';

      const managedEntry = state.managedTabs[key];
      if (managedEntry) {
        // 1. Respect Human Drag-Out Override: if user drags tab out of Antigravity group, release ownership!
        if (
          changeInfo?.groupId === TAB_GROUP_ID_NONE &&
          managedEntry.grouped &&
          !closingSet.has(tabId)
        ) {
          delete state.managedTabs[key];
          disq.add(tabId);
          state.disqualifiedTabIds = [...disq];
          await this._saveState(state);
          return;
        }

        // 2. Deterministic Teardown Signal: about:blank#antigravity-done
        if (isTeardownSignalUrl(url)) {
          const windowId = tab?.windowId ?? managedEntry.windowId;
          const windowManagedEntries = Object.entries(state.managedTabs).filter(
            ([, entry]) => entry.windowId === windowId
          );
          const allWindowManagedIds = windowManagedEntries.map(([k]) => Number(k));
          const childIds = windowManagedEntries
            .filter(([k, entry]) => entry.role === 'child' && Number(k) !== tabId)
            .map(([k]) => Number(k));

          // Mark all managed tabs in this window as closing and ungroup immediately
          // so no Saved Tab Group ghost pill is archived in Chrome's Bookmarks Bar!
          for (const id of allWindowManagedIds) {
            closingSet.add(id);
          }
          state.closingTabIds = [...closingSet];

          try {
            await this.chrome.tabs.ungroup(allWindowManagedIds);
          } catch {
            // Already ungrouped
          }
          delete state.windowGroups[String(windowId)];

          // Close child popups immediately
          if (childIds.length > 0) {
            for (const cid of childIds) {
              delete state.managedTabs[String(cid)];
            }
            try {
              await this.chrome.tabs.remove(childIds);
            } catch {
              // Ignore
            }
          }

          await this._saveState(state);

          // Schedule fallback close for root tab(s) after goto() resolves in Puppeteer
          this.scheduleTimeout(() => {
            this.enqueue(async () => {
              const latest = await this._loadState();
              const remainingRoots = Object.entries(latest.managedTabs)
                .filter(([, entry]) => entry.windowId === windowId)
                .map(([k]) => Number(k));
              if (remainingRoots.length > 0) {
                await this._ungroupAndRemoveTabsSafely(latest, windowId, remainingRoots);
                await this._saveState(latest);
              }
            });
          }, DONE_FALLBACK_CLOSE_DELAY_MS);
          return;
        }

        // 3. Ensure grouping succeeded if initial create raced with window readiness
        if (!managedEntry.grouped && tab?.windowId != null) {
          try {
            await this._ensureTabInAntigravityGroup(state, tabId, tab.windowId);
            await this._saveState(state);
          } catch {
            // Will retry on next update
          }
        }
        return;
      }

      // Not managed: never claim a disqualified user tab!
      if (disq.has(tabId)) {
        return;
      }

      if (isBootstrapSignalUrl(url)) {
        const hasValidCandidate = state.birthCandidates[key] != null;
        const openerless = tab?.openerTabId == null;
        if (openerless && (hasValidCandidate || !disq.has(tabId))) {
          delete state.birthCandidates[key];
          const windowId = tab?.windowId;
          state.managedTabs[key] = {
            windowId,
            role: 'root',
            claimedAt: this.now(),
            grouped: false,
          };
          if (windowId != null) {
            try {
              await this._ensureTabInAntigravityGroup(state, tabId, windowId);
            } catch (err) {
              console.warn('[AntigravityTabGuard] Failed grouping root tab on update:', err);
            }
          }
          await this._saveState(state);
        }
        return;
      }

      // Any non-blank external navigation without prior bootstrap permanently disqualifies the tab!
      if (url !== '' && url !== 'about:blank') {
        delete state.birthCandidates[key];
        disq.add(tabId);
        state.disqualifiedTabIds = [...disq];
        await this._saveState(state);
      }
    });
  }

  async onTabRemoved(tabId, removeInfo) {
    return this.enqueue(async () => {
      const state = await this._loadState();
      const key = String(tabId);

      delete state.birthCandidates[key];
      state.disqualifiedTabIds = state.disqualifiedTabIds.filter((id) => id !== tabId);
      state.closingTabIds = state.closingTabIds.filter((id) => id !== tabId);

      const removedEntry = state.managedTabs[key];
      if (!removedEntry) {
        await this._saveState(state);
        return;
      }

      delete state.managedTabs[key];
      const { windowId, role } = removedEntry;

      if (removeInfo?.isWindowClosing) {
        for (const [k, entry] of Object.entries(state.managedTabs)) {
          if (entry.windowId === windowId) {
            delete state.managedTabs[k];
          }
        }
        delete state.windowGroups[String(windowId)];
        await this._saveState(state);
        return;
      }

      // If the last root agent tab in this window was closed (e.g. via CDP close_page),
      // cascade-sweep any leftover child popups so the Antigravity group disappears completely!
      if (role === 'root') {
        const remainingRootsInWindow = Object.values(state.managedTabs).some(
          (entry) => entry.windowId === windowId && entry.role === 'root'
        );
        if (!remainingRootsInWindow) {
          const orphanChildren = Object.entries(state.managedTabs)
            .filter(([, entry]) => entry.windowId === windowId)
            .map(([k]) => Number(k));
          if (orphanChildren.length > 0) {
            await this._ungroupAndRemoveTabsSafely(state, windowId, orphanChildren);
          } else {
            delete state.windowGroups[String(windowId)];
          }
        }
      }

      await this._saveState(state);
    });
  }

  async sweepStaleSessions() {
    return this.enqueue(async () => {
      const prefs = await this._loadPrefs();
      if (!prefs.staleSweepEnabled) return { sweptCount: 0 };

      const state = await this._loadState();
      await this._reconcileWithBrowser(state);
      const cutoff = this.now() - prefs.maxSessionAgeMs;

      const byWindow = new Map();
      for (const [k, entry] of Object.entries(state.managedTabs)) {
        if (entry.claimedAt < cutoff) {
          const list = byWindow.get(entry.windowId) || [];
          list.push(Number(k));
          byWindow.set(entry.windowId, list);
        }
      }

      let sweptCount = 0;
      for (const [windowId, ids] of byWindow.entries()) {
        sweptCount += ids.length;
        await this._ungroupAndRemoveTabsSafely(state, windowId, ids);
      }
      await this._saveState(state);
      return { sweptCount };
    });
  }

  async sweepAllManagedTabs() {
    return this.enqueue(async () => {
      const state = await this._loadState();
      await this._reconcileWithBrowser(state);

      const byWindow = new Map();
      for (const [k, entry] of Object.entries(state.managedTabs)) {
        const list = byWindow.get(entry.windowId) || [];
        list.push(Number(k));
        byWindow.set(entry.windowId, list);
      }

      let closedCount = 0;
      for (const [windowId, ids] of byWindow.entries()) {
        closedCount += ids.length;
        await this._ungroupAndRemoveTabsSafely(state, windowId, ids);
      }
      state.windowGroups = {};
      await this._saveState(state);
      return { closedCount };
    });
  }

  async getStatus() {
    return this.enqueue(async () => {
      const state = await this._loadState();
      await this._reconcileWithBrowser(state);
      await this._saveState(state);
      const prefs = await this._loadPrefs();
      return {
        managedCount: Object.keys(state.managedTabs).length,
        activeWindows: Object.keys(state.windowGroups).length,
        prefs,
      };
    });
  }

  async isManagedTab(tabId) {
    if (tabId == null) return false;
    return this.enqueue(async () => {
      const state = await this._loadState();
      await this._reconcileWithBrowser(state);
      return Boolean(state.managedTabs[String(tabId)]);
    });
  }

  async getManagedTabs() {
    return this.enqueue(async () => {
      const state = await this._loadState();
      await this._reconcileWithBrowser(state);
      await this._saveState(state);
      const openTabs = await this.chrome.tabs.query({});
      const tabById = new Map(openTabs.map((t) => [t.id, t]));
      const result = [];
      for (const [k, entry] of Object.entries(state.managedTabs)) {
        const id = Number(k);
        const live = tabById.get(id);
        if (live) {
          result.push({
            tabId: id,
            windowId: live.windowId ?? entry.windowId,
            groupId: live.groupId ?? state.windowGroups[String(entry.windowId)] ?? TAB_GROUP_ID_NONE,
            role: entry.role,
            claimedAt: entry.claimedAt,
            url: live.url || live.pendingUrl || '',
            title: live.title || '',
            active: Boolean(live.active),
            status: live.status || 'complete',
          });
        }
      }
      return result;
    });
  }

  async createManagedTab({ url = 'about:blank', active = false, windowId } = {}) {
    return this.enqueue(async () => {
      const state = await this._loadState();
      await this._reconcileWithBrowser(state);

      const createProps = {
        url: 'about:blank#antigravity',
        active: Boolean(active),
      };
      if (windowId != null) {
        createProps.windowId = windowId;
      }

      const tab = await this.chrome.tabs.create(createProps);
      if (!tab || tab.id == null) {
        throw new Error('Failed to create Chrome tab');
      }

      const tabId = tab.id;
      const key = String(tabId);
      const disq = new Set(state.disqualifiedTabIds);
      disq.delete(tabId);
      state.disqualifiedTabIds = [...disq];
      delete state.birthCandidates[key];

      state.managedTabs[key] = {
        windowId: tab.windowId,
        role: 'root',
        claimedAt: this.now(),
        grouped: false,
      };

      const groupId = await this._ensureTabInAntigravityGroup(state, tabId, tab.windowId);
      await this._saveState(state);

      if (url && url !== 'about:blank' && !isBootstrapSignalUrl(url)) {
        if (this.chrome.tabs.update) {
          await this.chrome.tabs.update(tabId, { url, active: Boolean(active) });
        }
      }

      return {
        tabId,
        windowId: tab.windowId,
        groupId,
        url,
      };
    });
  }

  async closeManagedTab(tabId) {
    return this.enqueue(async () => {
      const state = await this._loadState();
      await this._reconcileWithBrowser(state);
      const key = String(tabId);
      const entry = state.managedTabs[key];
      if (!entry) {
        throw new Error(`Refusing to close unmanaged/user tab ${tabId}`);
      }

      const { windowId, role } = entry;
      const toClose = [Number(tabId)];

      if (role === 'root') {
        const otherRoots = Object.entries(state.managedTabs).some(
          ([k, e]) => Number(k) !== Number(tabId) && e.windowId === windowId && e.role === 'root'
        );
        if (!otherRoots) {
          for (const [k, e] of Object.entries(state.managedTabs)) {
            if (e.windowId === windowId && !toClose.includes(Number(k))) {
              toClose.push(Number(k));
            }
          }
        }
      }

      await this._ungroupAndRemoveTabsSafely(state, windowId, toClose);
      await this._saveState(state);
      return { closedTabIds: toClose };
    });
  }

  async updatePrefs(partialPrefs) {
    return this.enqueue(async () => {
      const current = await this._loadPrefs();
      const next = {
        ...current,
        ...(ALLOWED_GROUP_COLORS.includes(partialPrefs?.groupColor)
          ? { groupColor: partialPrefs.groupColor }
          : {}),
        ...(typeof partialPrefs?.staleSweepEnabled === 'boolean'
          ? { staleSweepEnabled: partialPrefs.staleSweepEnabled }
          : {}),
      };
      await this._savePrefs(next);

      // Live-update color on any active Antigravity groups
      const state = await this._loadState();
      for (const groupId of Object.values(state.windowGroups)) {
        try {
          await this.chrome.tabGroups.update(groupId, {
            title: GROUP_TITLE,
            color: next.groupColor,
          });
        } catch {
          // Group may already be gone
        }
      }
      return next;
    });
  }

  async runVisualSelfTest({ holdMs = 3000 } = {}) {
    const demoTab = await this.chrome.tabs.create({
      url: 'about:blank#antigravity-selftest',
      active: false,
    });
    // Ensure self-test cleans up deterministically after holdMs
    this.scheduleTimeout(() => {
      this.enqueue(async () => {
        const state = await this._loadState();
        if (demoTab?.id != null && state.managedTabs[String(demoTab.id)]) {
          await this._ungroupAndRemoveTabsSafely(state, demoTab.windowId, [demoTab.id]);
          await this._saveState(state);
        }
      });
    }, holdMs);
    return { demoTabId: demoTab?.id ?? null };
  }

  async handleInternalMessage(message, sender) {
    // Strict context verification (prevents ClaudeBleed / content-script spoofing):
    // Only accept messages from our own extension pages (popup), NEVER from web tabs or external extensions!
    if (!sender || sender.id !== this.chrome.runtime.id || sender.tab) {
      throw new Error('Unauthorized message sender context.');
    }

    switch (message?.type) {
      case 'GET_STATUS':
        return this.getStatus();
      case 'SET_PREFS':
        return this.updatePrefs(message.prefs || {});
      case 'SWEEP_ALL':
        return this.sweepAllManagedTabs();
      case 'RUN_SELF_TEST':
        return this.runVisualSelfTest({ holdMs: 3000 });
      default:
        throw new Error('Unsupported command.');
    }
  }
}
