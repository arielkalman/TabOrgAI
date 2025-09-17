import { DEFAULT_MODEL } from './llm.js';
import { parseUserRulesJSON } from './tab_utils.js';

const form = document.getElementById('options-form');
const statusEl = document.getElementById('status');

const DEFAULTS = {
  apiKey: '',
  model: DEFAULT_MODEL,
  keepAtLeastOnePerDomain: true,
  preservePinned: true,
  maxTabsPerGroup: 6,
  dryRun: false,
  dryRunNoLLM: false,
  userRulesJSON: ''
};

const RULES_EXAMPLE = `[
  {
    "name": "GitHub PRs",
    "host": "github\\.com",
    "path": "/pull"
  },
  {
    "name": "Docs",
    "host": "(docs|drive)\\.google\\.com"
  }
]`;

async function restoreOptions() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    form.apiKey.value = typeof stored.apiKey === 'string' ? stored.apiKey : '';
    form.model.value = typeof stored.model === 'string' ? stored.model : DEFAULT_MODEL;
    form.keepDomain.checked = stored.keepAtLeastOnePerDomain !== false;
    form.preservePinned.checked = stored.preservePinned !== false;
    form.maxTabs.value = Number.isFinite(Number(stored.maxTabsPerGroup)) ? stored.maxTabsPerGroup : DEFAULTS.maxTabsPerGroup;
    form.dryRun.checked = Boolean(stored.dryRun);
    form.dryRunNoLLM.checked = Boolean(stored.dryRunNoLLM);
    const rulesValue = typeof stored.userRulesJSON === 'string' ? stored.userRulesJSON.trim() : '';
    form.userRules.value = rulesValue || RULES_EXAMPLE;
    setStatus('');
  } catch (error) {
    console.error('Failed to restore options', error);
    setStatus('Unable to load saved settings.');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const maxTabsValue = Math.max(2, Number(form.maxTabs.value) || DEFAULTS.maxTabsPerGroup);
  const rawRules = form.userRules.value.trim();
  let userRulesJSON = '';

  if (rawRules) {
    try {
      const parsed = JSON.parse(rawRules);
      if (!Array.isArray(parsed)) {
        throw new Error('Rules must be an array');
      }
      const normalized = parseUserRulesJSON(rawRules);
      for (const rule of normalized) {
        for (const key of ['host', 'title', 'path']) {
          const descriptor = rule[key];
          if (!descriptor) continue;
          // Throws if the pattern is invalid.
          // eslint-disable-next-line no-new
          new RegExp(descriptor.pattern, descriptor.flags || 'i');
        }
      }
      userRulesJSON = rawRules;
    } catch (error) {
      console.error('Invalid custom rules JSON', error);
      setStatus('Custom rules must be valid JSON (array of objects).');
      return;
    }
  }

  const payload = {
    apiKey: form.apiKey.value.trim(),
    model: form.model.value.trim() || DEFAULT_MODEL,
    keepAtLeastOnePerDomain: form.keepDomain.checked,
    preservePinned: form.preservePinned.checked,
    maxTabsPerGroup: maxTabsValue,
    dryRun: form.dryRun.checked,
    dryRunNoLLM: form.dryRunNoLLM.checked,
    userRulesJSON
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
