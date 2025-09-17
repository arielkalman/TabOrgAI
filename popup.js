const form = document.getElementById('organize-form');
const textarea = document.getElementById('organize-input');
const llmButton = document.getElementById('organize-llm');
const noLlmButton = document.getElementById('organize-nollm');
const dryRunNoLlmCheckbox = document.getElementById('dryRunNoLLM');
const statusEl = document.getElementById('status');
const previewSection = document.getElementById('preview');
const previewContent = document.getElementById('preview-content');

let awaitingConfirmation = false;
let previewToken = null;
let previewPromptValue = '';
let cachedUserRules = '';
let llmDryRunPreference = false;

initializePopup();

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (awaitingConfirmation && textarea.value.trim() !== previewPromptValue) {
    resetPreview();
  }

  const confirm = awaitingConfirmation;
  const prompt = textarea.value.trim();

  setLLMWorkingState(true, confirm ? 'Applying…' : 'Organizing…');

  try {
    try {
      const stored = await chrome.storage.sync.get({ dryRun: llmDryRunPreference });
      llmDryRunPreference = Boolean(stored.dryRun);
    } catch (error) {
      console.warn('Unable to refresh LLM dry-run preference', error);
    }

    const response = await chrome.runtime.sendMessage({
      type: 'ORGANIZE_TABS_LLM',
      prompt,
      confirm,
      token: confirm ? previewToken : undefined,
      dryRun: llmDryRunPreference
    });

    if (!response) {
      throw new Error('No response from background script.');
    }

    if (!response.success) {
      throw new Error(response.error || 'Unable to organize tabs.');
    }

    if (response.preview) {
      previewToken = response.token;
      awaitingConfirmation = true;
      previewPromptValue = prompt;
      renderPreview(response.summary);
      setStatus(response.message || 'Review the plan and confirm.');
      llmButton.textContent = 'Apply plan';
      return;
    }

    setStatus(response.message || 'Tabs organized successfully.');
    resetPreview();
  } catch (error) {
    console.error('Popup organize error', error);
    setStatus(error.message || 'Unexpected error.');
  } finally {
    setLLMWorkingState(false);
  }
});

noLlmButton.addEventListener('click', async () => {
  resetPreview();
  setNoLLMWorkingState(true);

  try {
    try {
      const stored = await chrome.storage.sync.get({
        userRulesJSON: cachedUserRules,
        dryRunNoLLM: dryRunNoLlmCheckbox.checked
      });
      if (typeof stored.userRulesJSON === 'string') {
        cachedUserRules = stored.userRulesJSON;
      }
      if (typeof stored.dryRunNoLLM === 'boolean') {
        dryRunNoLlmCheckbox.checked = stored.dryRunNoLLM;
      }
    } catch (error) {
      console.warn('Unable to refresh no-LLM preferences', error);
    }

    const response = await chrome.runtime.sendMessage({
      type: 'ORGANIZE_TABS_NOLLM',
      dryRun: dryRunNoLlmCheckbox.checked,
      userRules: cachedUserRules
    });

    if (!response) {
      throw new Error('No response from background script.');
    }

    if (!response.success) {
      throw new Error(response.error || 'Unable to organize tabs.');
    }

    setStatus(response.message || '');

    if (response.dryRun && response.plan) {
      renderPreview(convertPlanToPreview(response.plan));
    }
  } catch (error) {
    console.error('Popup no-LLM organize error', error);
    setStatus(error.message || 'Unexpected error.');
  } finally {
    setNoLLMWorkingState(false);
  }
});

dryRunNoLlmCheckbox.addEventListener('change', async () => {
  try {
    await chrome.storage.sync.set({ dryRunNoLLM: dryRunNoLlmCheckbox.checked });
  } catch (error) {
    console.warn('Unable to persist no-LLM dry-run preference', error);
  }
});

function setLLMWorkingState(isWorking, label) {
  setInteractivity(isWorking);
  if (label) {
    llmButton.textContent = label;
  } else if (!awaitingConfirmation) {
    llmButton.textContent = 'Organize (LLM)';
  }
  if (!isWorking && awaitingConfirmation) {
    llmButton.disabled = false;
  }
  if (isWorking) {
    setStatus('');
  }
}

function setNoLLMWorkingState(isWorking) {
  setInteractivity(isWorking);
  if (isWorking) {
    noLlmButton.textContent = 'Organizing…';
    setStatus('');
  } else {
    noLlmButton.textContent = 'Organize (No-LLM)';
    if (!awaitingConfirmation) {
      llmButton.textContent = 'Organize (LLM)';
    }
  }
}

function setInteractivity(disabled) {
  llmButton.disabled = disabled;
  noLlmButton.disabled = disabled;
  textarea.disabled = disabled;
  dryRunNoLlmCheckbox.disabled = disabled;
}

function setStatus(message) {
  statusEl.textContent = message;
}

function renderPreview(summary) {
  if (!summary) {
    resetPreview();
    return;
  }
  previewContent.innerHTML = '';

  const closingSection = document.createElement('div');
  closingSection.className = 'preview-section';
  const closingTitle = document.createElement('h3');
  closingTitle.textContent = 'Tabs to close';
  closingSection.appendChild(closingTitle);
  const closingList = document.createElement('ul');
  closingList.className = 'preview-list';
  if (summary.closing.length) {
    for (const item of summary.closing) {
      const li = document.createElement('li');
      li.textContent = `${item.title} – ${item.url}`;
      closingList.appendChild(li);
    }
  } else {
    const li = document.createElement('li');
    li.textContent = 'No duplicates will be closed.';
    closingList.appendChild(li);
  }
  closingSection.appendChild(closingList);
  previewContent.appendChild(closingSection);

  const groupingSection = document.createElement('div');
  groupingSection.className = 'preview-section';
  const groupingTitle = document.createElement('h3');
  groupingTitle.textContent = 'Tab groups';
  groupingSection.appendChild(groupingTitle);
  const groupingList = document.createElement('ul');
  groupingList.className = 'preview-list';
  if (summary.groups.length) {
    for (const group of summary.groups) {
      const li = document.createElement('li');
      const tabList = group.tabs.map((tab) => tab.title).join(', ');
      li.textContent = `${group.name}: ${tabList}`;
      groupingList.appendChild(li);
    }
  } else {
    const li = document.createElement('li');
    li.textContent = 'No changes to tab groups.';
    groupingList.appendChild(li);
  }
  groupingSection.appendChild(groupingList);
  previewContent.appendChild(groupingSection);

  if (summary.notes) {
    const notesSection = document.createElement('div');
    notesSection.className = 'preview-section';
    const notesTitle = document.createElement('h3');
    notesTitle.textContent = 'Notes';
    const notesBody = document.createElement('p');
    notesBody.textContent = summary.notes;
    notesSection.appendChild(notesTitle);
    notesSection.appendChild(notesBody);
    previewContent.appendChild(notesSection);
  }

  previewSection.hidden = false;
}

function resetPreview() {
  awaitingConfirmation = false;
  previewToken = null;
  previewPromptValue = '';
  previewSection.hidden = true;
  previewContent.innerHTML = '';
  llmButton.textContent = 'Organize (LLM)';
  noLlmButton.textContent = 'Organize (No-LLM)';
}

function convertPlanToPreview(plan) {
  return {
    closing: (plan.duplicates || []).map((item) => ({ title: item.title, url: item.url })),
    groups: (plan.groups || []).map((group) => ({
      name: group.name,
      tabs: (group.tabs || []).map((tab) => ({ title: tab.title, url: tab.url }))
    }))
  };
}

async function initializePopup() {
  try {
    const stored = await chrome.storage.sync.get({
      dryRunNoLLM: false,
      userRulesJSON: '',
      dryRun: false
    });
    dryRunNoLlmCheckbox.checked = Boolean(stored.dryRunNoLLM);
    cachedUserRules = typeof stored.userRulesJSON === 'string' ? stored.userRulesJSON : '';
    llmDryRunPreference = Boolean(stored.dryRun);
  } catch (error) {
    console.warn('Unable to load popup preferences', error);
  }
}

resetPreview();
