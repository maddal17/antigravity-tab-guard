import { STALE_SWEEP_ALARM, STALE_SWEEP_PERIOD_MINUTES } from './constants.js';
import { GroupController } from './group-controller.js';

const controller = new GroupController();

function ensureAlarms() {
  chrome.alarms.create(STALE_SWEEP_ALARM, {
    periodInMinutes: STALE_SWEEP_PERIOD_MINUTES,
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarms();
  controller.initialize();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  controller.initialize();
});

chrome.tabs.onCreated.addListener((tab) => {
  controller.onTabCreated(tab);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  controller.onTabUpdated(tabId, changeInfo, tab);
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  controller.onTabRemoved(tabId, removeInfo);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === STALE_SWEEP_ALARM) {
    controller.sweepStaleSessions();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  controller
    .handleInternalMessage(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || 'Error' }));
  return true;
});

// Hydrate immediately on worker wake
controller.initialize();
