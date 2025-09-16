const form = document.getElementById('organize-form');
const textarea = document.getElementById('organize-input');
const button = document.getElementById('organize-button');
const statusEl = document.getElementById('status');
const previewSection = document.getElementById('preview');
const previewContent = document.getElementById('preview-content');

let awaitingConfirmation = false;
let previewToken = null;
let previewPromptValue = '';

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (awaitingConfirmation && textarea.value.trim() !== previewPromptValue) {
    resetPreview();
  }

  const confirm = awaitingConfirmation;
  const prompt = textarea.value.trim();

  setWorkingState(true, confirm ? 'Applying…' : 'Organizing…');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'organize-tabs',
      prompt,
      confirm,
      token: confirm ? previewToken : undefined
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
      button.textContent = 'Apply plan';
      button.disabled = false;
      return;
    }

    setStatus(response.message || 'Tabs organized successfully.');
    resetPreview();
  } catch (error) {
    console.error('Popup organize error', error);
    setStatus(error.message || 'Unexpected error.');
  } finally {
    setWorkingState(false);
  }
});

function setWorkingState(isWorking, label) {
  button.disabled = isWorking;
  if (label) {
    button.textContent = label;
  } else if (!awaitingConfirmation) {
    button.textContent = 'Organize';
  }
  if (isWorking) {
    setStatus('');
  }
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
  button.textContent = 'Organize';
}
