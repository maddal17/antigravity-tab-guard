import {
  NATIVE_RECONNECT_ALARM,
  STALE_SWEEP_ALARM,
  STALE_SWEEP_PERIOD_MINUTES,
} from './constants.js';
import { GroupController } from './group-controller.js';
import { NativeBridge } from './native-bridge.js';

const controller = new GroupController();
const bridge = new NativeBridge({ controller });

function ensureAlarms() {
  chrome.alarms.create(STALE_SWEEP_ALARM, {
    periodInMinutes: STALE_SWEEP_PERIOD_MINUTES,
  });
  chrome.alarms.create(NATIVE_RECONNECT_ALARM, {
    periodInMinutes: 1,
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarms();
  controller.initialize();
  bridge.connect();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  controller.initialize();
  bridge.connect();
});

chrome.tabs.onCreated.addListener((tab) => {
  bridge.connect();
  controller.onTabCreated(tab);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  bridge.connect();
  controller.onTabUpdated(tabId, changeInfo, tab);
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  controller.onTabRemoved(tabId, removeInfo);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  bridge.connect();
  if (alarm?.name === STALE_SWEEP_ALARM) {
    controller.sweepStaleSessions();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  bridge.connect();
  controller
    .handleInternalMessage(message, sender)
    .then((data) => {
      if (data && typeof data === 'object') {
        data.nativeConnected = bridge.connected;
      }
      sendResponse({ ok: true, data });
    })
    .catch((err) => sendResponse({ ok: false, error: err?.message || 'Error' }));
  return true;
});

// Hydrate and connect native host immediately on worker wake
ensureAlarms();
controller.initialize();
bridge.connect();
