import { DEFAULT_MODEL } from './llm.js';

const form = document.getElementById('options-form');
const statusEl = document.getElementById('status');

const DEFAULTS = {
  apiKey: '',
  model: DEFAULT_MODEL,
  keepAtLeastOnePerDomain: true,
  preservePinned: true,
  maxTabsPerGroup: 6,
  dryRun: false
};

async function restoreOptions() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    form.apiKey.value = typeof stored.apiKey === 'string' ? stored.apiKey : '';
    form.model.value = typeof stored.model === 'string' ? stored.model : DEFAULT_MODEL;
    form.keepDomain.checked = stored.keepAtLeastOnePerDomain !== false;
    form.preservePinned.checked = stored.preservePinned !== false;
    form.maxTabs.value = Number.isFinite(Number(stored.maxTabsPerGroup)) ? stored.maxTabsPerGroup : DEFAULTS.maxTabsPerGroup;
    form.dryRun.checked = Boolean(stored.dryRun);
    setStatus('');
  } catch (error) {
    console.error('Failed to restore options', error);
    setStatus('Unable to load saved settings.');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const maxTabsValue = Math.max(2, Number(form.maxTabs.value) || DEFAULTS.maxTabsPerGroup);
  const payload = {
    apiKey: form.apiKey.value.trim(),
    model: form.model.value.trim() || DEFAULT_MODEL,
    keepAtLeastOnePerDomain: form.keepDomain.checked,
    preservePinned: form.preservePinned.checked,
    maxTabsPerGroup: maxTabsValue,
    dryRun: form.dryRun.checked
  };
  try {
    await chrome.storage.sync.set(payload);
    setStatus('Settings saved.');
  } catch (error) {
    console.error('Failed to save options', error);
    setStatus('Unable to save settings.');
  }
});

function setStatus(message) {
  statusEl.textContent = message;
}

restoreOptions();
