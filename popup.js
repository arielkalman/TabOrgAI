const form = document.getElementById('organize-form');
const textarea = document.getElementById('organize-input');
const llmButton = document.getElementById('organize-llm');
const noLlmButton = document.getElementById('organize-nollm');
const closeDuplicatesButton = document.getElementById('close-duplicates');
const settingsButton = document.getElementById('open-settings');
const dryRunNoLlmCheckbox = document.getElementById('dryRunNoLLM');
const statusEl = document.getElementById('status');
const previewSection = document.getElementById('preview');
const previewContent = document.getElementById('preview-content');
const tooltipTrigger = document.querySelector('.tooltip-trigger');
const tooltipBubble = document.getElementById('dry-run-tooltip');

let awaitingConfirmation = false;
let previewToken = null;
let previewPromptValue = '';
let cachedUserRules = '';
let llmDryRunPreference = false;
let tooltipVisible = false;

initializePopup();

if (tooltipTrigger && tooltipBubble) {
  tooltipTrigger.setAttribute('aria-expanded', 'false');
  tooltipTrigger.addEventListener('mouseenter', showTooltip);
  tooltipTrigger.addEventListener('focus', showTooltip);
  tooltipTrigger.addEventListener('mouseleave', hideTooltip);
  tooltipTrigger.addEventListener('blur', hideTooltip);
  tooltipTrigger.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideTooltip();
    }
  });

  window.addEventListener('resize', updateTooltipPosition);
  window.addEventListener(
    'scroll',
    () => {
      if (tooltipVisible) {
        updateTooltipPosition();
      }
    },
    true
  );
}

if (settingsButton) {
  settingsButton.addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options.html'));
    }
  });
}

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

closeDuplicatesButton.addEventListener('click', async () => {
  resetPreview();
  setCloseDuplicatesWorkingState(true);

  try {
    const response = await chrome.runtime.sendMessage({ type: 'CLOSE_DUPLICATE_TABS' });

    if (!response) {
      throw new Error('No response from background script.');
    }

    if (!response.success) {
      throw new Error(response.error || 'Unable to close duplicate tabs.');
    }

    setStatus(response.message || 'Duplicate tabs closed.');
  } catch (error) {
    console.error('Popup close duplicates error', error);
    setStatus(error.message || 'Unexpected error.');
  } finally {
    setCloseDuplicatesWorkingState(false);
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

function setCloseDuplicatesWorkingState(isWorking) {
  setInteractivity(isWorking);
  if (isWorking) {
    closeDuplicatesButton.textContent = 'Closing duplicates…';
    setStatus('');
  } else {
    closeDuplicatesButton.textContent = 'Close duplicates';
    if (!awaitingConfirmation) {
      llmButton.textContent = 'Organize (LLM)';
      noLlmButton.textContent = 'Organize (No-LLM)';
    }
  }
}

function setInteractivity(disabled) {
  if (disabled) {
    hideTooltip();
  }
  llmButton.disabled = disabled;
  noLlmButton.disabled = disabled;
  closeDuplicatesButton.disabled = disabled;
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

  const closingItems = Array.isArray(summary.closing) ? summary.closing : [];
  const groupingItems = Array.isArray(summary.groups) ? summary.groups : [];
  const notesText = typeof summary.notes === 'string' ? summary.notes.trim() : '';
  const hasClosing = closingItems.length > 0;
  const hasGrouping = groupingItems.length > 0;
  const hasNotes = notesText.length > 0;

  if (!hasClosing && !hasGrouping && !hasNotes) {
    resetPreview();
    return;
  }

  previewContent.innerHTML = '';

  if (hasClosing) {
    const closingSection = document.createElement('div');
    closingSection.className = 'preview-section';
    const closingTitle = document.createElement('h3');
    closingTitle.textContent = 'Tabs to close';
    closingSection.appendChild(closingTitle);
    const closingList = document.createElement('ul');
    closingList.className = 'preview-list';
    for (const item of closingItems) {
      const li = document.createElement('li');
      li.textContent = `${item.title} – ${item.url}`;
      closingList.appendChild(li);
    }
    closingSection.appendChild(closingList);
    previewContent.appendChild(closingSection);
  }

  if (hasGrouping) {
    const groupingSection = document.createElement('div');
    groupingSection.className = 'preview-section';
    const groupingTitle = document.createElement('h3');
    groupingTitle.textContent = 'Tab groups';
    groupingSection.appendChild(groupingTitle);
    const groupingList = document.createElement('ul');
    groupingList.className = 'preview-list';
    for (const group of groupingItems) {
      const li = document.createElement('li');
      const tabList = group.tabs.map((tab) => tab.title).join(', ');
      li.textContent = `${group.name}: ${tabList}`;
      groupingList.appendChild(li);
    }
    groupingSection.appendChild(groupingList);
    previewContent.appendChild(groupingSection);
  }

  if (hasNotes) {
    const notesSection = document.createElement('div');
    notesSection.className = 'preview-section';
    const notesTitle = document.createElement('h3');
    notesTitle.textContent = 'Notes';
    const notesBody = document.createElement('p');
    notesBody.textContent = notesText;
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
    })),
    notes: typeof plan.notes === 'string' ? plan.notes : ''
  };
}

function showTooltip() {
  if (!tooltipTrigger || !tooltipBubble) {
    return;
  }
  if (tooltipVisible) {
    updateTooltipPosition();
    return;
  }
  tooltipVisible = true;
  tooltipBubble.dataset.visible = 'true';
  tooltipTrigger.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => {
    updateTooltipPosition();
  });
}

function hideTooltip() {
  if (!tooltipTrigger || !tooltipBubble || !tooltipVisible) {
    return;
  }
  tooltipVisible = false;
  delete tooltipBubble.dataset.visible;
  tooltipTrigger.setAttribute('aria-expanded', 'false');
}

function updateTooltipPosition() {
  if (!tooltipTrigger || !tooltipBubble || !tooltipVisible) {
    return;
  }
  const margin = 8;
  const triggerRect = tooltipTrigger.getBoundingClientRect();
  const bubbleRect = tooltipBubble.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;

  let left = triggerRect.left + triggerRect.width / 2 - bubbleRect.width / 2;
  left = Math.max(margin, Math.min(left, viewportWidth - margin - bubbleRect.width));

  let top = triggerRect.bottom + margin;
  if (top + bubbleRect.height > viewportHeight - margin) {
    const above = triggerRect.top - margin - bubbleRect.height;
    if (above >= margin) {
      top = above;
    } else {
      top = Math.max(margin, Math.min(viewportHeight - margin - bubbleRect.height, triggerRect.top + margin));
    }
  }
  top = Math.max(margin, Math.min(top, viewportHeight - margin - bubbleRect.height));

  tooltipBubble.style.left = `${Math.round(left)}px`;
  tooltipBubble.style.top = `${Math.round(top)}px`;
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
