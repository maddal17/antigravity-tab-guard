/**
 * Protocol constants and security boundaries for Antigravity Tab Group Guard.
 */

export const GROUP_TITLE = 'Antigravity';
export const DEFAULT_GROUP_COLOR = 'purple';
export const NATIVE_HOST_NAME = 'com.antigravity.tab_guard';
export const NATIVE_RECONNECT_ALARM = 'ag_native_reconnect_alarm';
export const NATIVE_CHUNK_SIZE = 512 * 1024; // 512 KB chunks (safely under Chrome's 1 MB Native Messaging limit)

export const ALLOWED_GROUP_COLORS = Object.freeze([
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]);

export const SESSION_STORAGE_KEY = 'ag_tab_guard_session_v1';
export const PREFS_STORAGE_KEY = 'ag_tab_guard_prefs_v1';

export const STALE_SWEEP_ALARM = 'ag_stale_sweep_alarm';
export const STALE_SWEEP_PERIOD_MINUTES = 5;
export const DEFAULT_MAX_SESSION_AGE_MS = 45 * 60 * 1000; // 45 minutes orphan failsafe
export const BIRTH_CANDIDATE_TTL_MS = 10 * 1000; // 10s window from about:blank birth to bootstrap hash
export const DONE_FALLBACK_CLOSE_DELAY_MS = 650; // Allows Puppeteer goto() to resolve cleanly before fallback close

export const TAB_GROUP_ID_NONE = -1;

// Strict bootstrap URI pattern: only about:blank#antigravity (or optional session suffix)
const BOOTSTRAP_REGEX = /^about:blank#antigravity(?:-[a-z0-9_-]{1,32})?$/i;
const TEARDOWN_REGEX = /^about:blank#antigravity-(?:done|close)$/i;

export function isBootstrapSignalUrl(url) {
  if (typeof url !== 'string') return false;
  if (TEARDOWN_REGEX.test(url)) return false;
  return BOOTSTRAP_REGEX.test(url);
}

export function isTeardownSignalUrl(url) {
  if (typeof url !== 'string') return false;
  return TEARDOWN_REGEX.test(url);
}

export function isCleanBlankBirthUrl(url) {
  return url === '' || url === 'about:blank' || isBootstrapSignalUrl(url);
}
