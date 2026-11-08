const managedCountEl = document.getElementById('managedCount');
const activeWindowsEl = document.getElementById('activeWindows');
const statusPillEl = document.getElementById('statusPill');
const sweepBtn = document.getElementById('sweepBtn');
const selfTestBtn = document.getElementById('selfTestBtn');
const feedbackMsgEl = document.getElementById('feedbackMsg');
const swatches = Array.from(document.querySelectorAll('.swatch'));

async function sendCommand(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) {
    throw new Error(response?.error || 'Extension command failed');
  }
  return response.data;
}

function renderStatus(status) {
  const count = status.managedCount || 0;
  managedCountEl.textContent = String(count);
  activeWindowsEl.textContent = String(status.activeWindows || 0);

  if (count > 0) {
    statusPillEl.textContent = 'Active';
    statusPillEl.className = 'pill pill-active';
    sweepBtn.disabled = false;
  } else {
    statusPillEl.textContent = 'Idle';
    statusPillEl.className = 'pill pill-idle';
    sweepBtn.disabled = true;
  }

  const activeColor = status.prefs?.groupColor || 'purple';
  for (const btn of swatches) {
    btn.classList.toggle('selected', btn.dataset.color === activeColor);
  }
}

async function refresh() {
  try {
    const status = await sendCommand('GET_STATUS');
    renderStatus(status);
  } catch (err) {
    feedbackMsgEl.textContent = err.message;
  }
}

for (const btn of swatches) {
  btn.addEventListener('click', async () => {
    const groupColor = btn.dataset.color;
    await sendCommand('SET_PREFS', { prefs: { groupColor } });
    feedbackMsgEl.textContent = `Group color updated to ${groupColor}.`;
    await refresh();
  });
}

sweepBtn.addEventListener('click', async () => {
  sweepBtn.disabled = true;
  const result = await sendCommand('SWEEP_ALL');
  feedbackMsgEl.textContent = `Closed ${result.closedCount} Antigravity tab(s).`;
  await refresh();
});

selfTestBtn.addEventListener('click', async () => {
  selfTestBtn.disabled = true;
  feedbackMsgEl.textContent = 'Running 3s Antigravity Tab Group demo...';
  await sendCommand('RUN_SELF_TEST');
  await refresh();
  setTimeout(async () => {
    await refresh();
    selfTestBtn.disabled = false;
    feedbackMsgEl.textContent = 'Demo complete — group dissolved cleanly.';
  }, 3300);
});

refresh();
