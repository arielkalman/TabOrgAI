import { requestChatCompletion, extractMessageContent, DEFAULT_MODEL } from './llm.js';
import {
  fetchCurrentWindowTabs,
  computeDedupePlan,
  sanitizeGroupPlan,
  summarizePlanForPreview,
  extractDomain
} from './tab_utils.js';

const RATE_LIMIT_INTERVAL_MS = 5000;
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const TAB_GROUP_ID_NONE = chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;

const DEFAULT_SYNC_SETTINGS = {
  apiKey: '',
  model: DEFAULT_MODEL,
  keepAtLeastOnePerDomain: true,
  preservePinned: true,
  maxTabsPerGroup: 6,
  dryRun: false
};

let lastCompletionTimestamp = 0;
const previewPlans = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'organize-tabs') {
    return false;
  }
  handleOrganizeMessage(message)
    .then((result) => sendResponse(result))
    .catch((error) => {
      console.error('[Tab Organizer AI] organize-tabs error', error);
      sendResponse({ success: false, error: error.message || 'Unexpected error' });
    });
  return true;
});

/**
 * Process organize requests coming from the popup UI.
 * @param {{ prompt?: string, confirm?: boolean, token?: string }} message
 */
async function handleOrganizeMessage(message) {
  const preferences = await loadPreferences();
  cleanupExpiredPreviews();

  if (!preferences.apiKey) {
    throw new Error('Add your OpenAI API key in the extension options before organizing.');
  }

  const userPrompt = typeof message.prompt === 'string' ? message.prompt.trim() : '';
  const isConfirm = Boolean(message.confirm);

  if (preferences.dryRun && !isConfirm) {
    const plan = await buildPlan(userPrompt, preferences, { skipRateLimit: false });
    const token = crypto.randomUUID();
    previewPlans.set(token, { plan, createdAt: Date.now() });
    return {
      success: true,
      preview: true,
      token,
      summary: plan.preview,
      message: buildPreviewMessage(plan)
    };
  }

  if (isConfirm && message.token) {
    const stored = previewPlans.get(message.token);
    if (!stored) {
      throw new Error('Preview expired. Please analyze the tabs again.');
    }
    previewPlans.delete(message.token);
    const applyResult = await applyPlan(stored.plan);
    return { success: true, preview: false, ...applyResult };
  }

  const plan = await buildPlan(userPrompt, preferences, { skipRateLimit: false });
  const applyResult = await applyPlan(plan);
  return { success: true, preview: false, ...applyResult };
}

/**
 * Create a detailed organization plan without mutating tabs.
 * @param {string} userPrompt
 * @param {ReturnType<typeof loadPreferences>} preferences
 * @param {{skipRateLimit?: boolean}} [options]
 */
async function buildPlan(userPrompt, preferences, options = {}) {
  const { windowId, tabs } = await fetchCurrentWindowTabs();
  if (!tabs.length) {
    throw new Error('No tabs were found in the current window.');
  }

  const dedupe = computeDedupePlan(tabs, preferences);
  const survivorsSet = new Set(dedupe.survivors.map((tab) => tab.id));
  const survivors = tabs.filter((tab) => survivorsSet.has(tab.id));
  const tabLookup = new Map(tabs.map((tab) => [tab.id, tab]));

  let grouping = { groups: [], assignedTabIds: new Set(), notes: '' };
  if (survivors.length >= 2) {
    const groupingResult = await fetchGroupingFromLLM({
      windowId,
      tabs: survivors,
      preferences,
      userPrompt,
      skipRateLimit: Boolean(options.skipRateLimit)
    });
    const sanitized = sanitizeGroupPlan(groupingResult.groups, survivors, preferences);
    grouping = {
      groups: sanitized.groups,
      assignedTabIds: sanitized.assignedTabIds,
      notes: groupingResult.notes || ''
    };
  }

  const preview = summarizePlanForPreview({
    tabsToClose: dedupe.tabsToClose,
    grouping,
    tabLookup,
    notes: grouping.notes
  });

  return {
    windowId,
    tabs,
    preferences,
    dedupe,
    grouping,
    tabLookup,
    preview,
    userPrompt
  };
}

/**
 * Apply the stored plan to the live Chrome tabs.
 * @param {{ windowId: number, dedupe: any, grouping: any, preferences: any }} plan
 */
async function applyPlan(plan) {
  const { windowId, dedupe, grouping, preferences } = plan;

  const currentTabs = await chrome.tabs.query({ windowId });
  const tabMap = new Map(currentTabs.map((tab) => [tab.id, tab]));

  const removalIds = [];
  for (const item of dedupe.tabsToClose) {
    const tab = tabMap.get(item.id);
    if (!tab) continue;
    if (preferences.preservePinned && tab.pinned) continue;
    removalIds.push(item.id);
  }

  if (removalIds.length) {
    try {
      await chrome.tabs.remove(removalIds);
    } catch (error) {
      console.warn('Failed to remove some duplicate tabs', error);
    }
  }

  const tabsAfterRemoval = await chrome.tabs.query({ windowId });
  const afterRemovalMap = new Map(tabsAfterRemoval.map((tab) => [tab.id, tab]));
  const plannedAssignments = [];
  const assignedTabs = new Set();

  for (const group of grouping.groups) {
    const ids = [];
    for (const tabId of group.tabIds) {
      if (assignedTabs.has(tabId)) continue;
      const tab = afterRemovalMap.get(tabId);
      if (!tab) continue;
      if (preferences.preservePinned && tab.pinned) continue;
      ids.push(tabId);
      assignedTabs.add(tabId);
    }
    if (!ids.length) continue;
    try {
      const groupId = await chrome.tabs.group({ tabIds: ids });
      await chrome.tabGroups.update(groupId, { title: group.name });
      plannedAssignments.push({ groupId, name: group.name, tabIds: ids });
    } catch (error) {
      console.warn('Failed to apply tab group', group, error);
    }
  }

  // Ungroup tabs that are no longer assigned to a group.
  for (const tab of tabsAfterRemoval) {
    if (tab.groupId === TAB_GROUP_ID_NONE) continue;
    if (assignedTabs.has(tab.id)) continue;
    try {
      await chrome.tabs.ungroup(tab.id);
    } catch (error) {
      console.warn('Failed to ungroup tab', tab.id, error);
    }
  }

  await cleanupEmptyGroups(windowId);

  const closedCount = removalIds.length;
  const groupedCount = plannedAssignments.length;

  return {
    message: buildCompletionMessage({ closedCount, groupedCount }),
    details: {
      closedCount,
      groupedCount,
      groups: plannedAssignments
    }
  };
}

/**
 * Fetch LLM grouping suggestions.
 * @param {{windowId: number, tabs: any[], preferences: any, userPrompt: string, skipRateLimit: boolean}} params
 */
async function fetchGroupingFromLLM(params) {
  const { windowId, tabs, preferences, userPrompt, skipRateLimit } = params;
  if (!skipRateLimit) {
    enforceRateLimit();
  }

  const tabPayload = tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    url: tab.url,
    domain: extractDomain(tab.url),
    pinned: Boolean(tab.pinned),
    audible: Boolean(tab.audible),
    active: Boolean(tab.active)
  }));

  const systemPrompt = [
    'You are an assistant that organizes browser tabs into small, meaningful groups.',
    'Return JSON with the shape {"groups":[{"name":"string","tabIds":[number,...]}],"notes":"string"}.',
    `Limit each group to ${Math.max(2, Number(preferences.maxTabsPerGroup) || 6)} tabs or fewer.`,
    'Only include tab IDs that you were provided.',
    'Skip grouping pinned tabs and only group items that have a clear common task or theme.',
    'Prefer short titles (<= 20 characters) that summarize the intent. Avoid emoji unless it conveys clear meaning.',
    'Leave tabs out of all groups when no obvious grouping exists.'
  ].join(' ');

  const userContent = JSON.stringify({
    windowId,
    preferences: {
      keepAtLeastOnePerDomain: Boolean(preferences.keepAtLeastOnePerDomain),
      preservePinned: Boolean(preferences.preservePinned),
      maxTabsPerGroup: Math.max(2, Number(preferences.maxTabsPerGroup) || 6)
    },
    userPrompt: userPrompt || null,
    tabs: tabPayload
  });

  const completion = await requestChatCompletion({
    model: preferences.model || DEFAULT_MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content:
          'Analyze the following tabs and suggest topic-based groups. Respect the `userPrompt` guidance when provided. ' +
          'Respond with valid JSON and do not add any extra commentary.\n' +
          userContent
      }
    ]
  });

  lastCompletionTimestamp = Date.now();

  const content = extractMessageContent(completion);
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error('OpenAI returned an invalid grouping payload.');
  }

  const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
  const notes = typeof parsed.notes === 'string' ? parsed.notes : '';
  return { groups, notes };
}

/**
 * Load persisted preferences with defaults.
 */
async function loadPreferences() {
  const stored = await chrome.storage.sync.get(DEFAULT_SYNC_SETTINGS);
  return {
    apiKey: typeof stored.apiKey === 'string' ? stored.apiKey.trim() : '',
    model: typeof stored.model === 'string' && stored.model.trim() ? stored.model.trim() : DEFAULT_MODEL,
    keepAtLeastOnePerDomain: stored.keepAtLeastOnePerDomain !== false,
    preservePinned: stored.preservePinned !== false,
    maxTabsPerGroup: Math.max(2, Number(stored.maxTabsPerGroup) || 6),
    dryRun: Boolean(stored.dryRun)
  };
}

/**
 * Ensure OpenAI calls are rate limited.
 */
function enforceRateLimit() {
  const now = Date.now();
  if (now - lastCompletionTimestamp < RATE_LIMIT_INTERVAL_MS) {
    const waitMs = RATE_LIMIT_INTERVAL_MS - (now - lastCompletionTimestamp);
    throw new Error(`Please wait ${Math.ceil(waitMs / 1000)} more second(s) before organizing again.`);
  }
}

/**
 * Remove preview plans that are older than the TTL.
 */
function cleanupExpiredPreviews() {
  const now = Date.now();
  for (const [token, value] of previewPlans.entries()) {
    if (now - value.createdAt > PREVIEW_TTL_MS) {
      previewPlans.delete(token);
    }
  }
}

/**
 * Delete any empty tab groups that remain.
 * @param {number} windowId
 */
async function cleanupEmptyGroups(windowId) {
  try {
    const groups = await chrome.tabGroups.query({ windowId });
    for (const group of groups) {
      const tabs = await chrome.tabs.query({ windowId, groupId: group.id });
      if (!tabs.length) {
        try {
          await chrome.tabGroups.delete(group.id);
        } catch (error) {
          console.warn('Failed to delete empty group', group.id, error);
        }
      }
    }
  } catch (error) {
    console.warn('Unable to cleanup tab groups', error);
  }
}

/**
 * Build a user-facing message describing a preview.
 * @param {{preview: any, dedupe: any}} plan
 */
function buildPreviewMessage(plan) {
  const closingCount = plan.preview.closing.length;
  const groupCount = plan.preview.groups.length;
  const closingPart = closingCount ? `${closingCount} duplicate tab${closingCount === 1 ? '' : 's'} will close.` : 'No tabs will be closed.';
  const groupingPart = groupCount ? `${groupCount} group${groupCount === 1 ? '' : 's'} will be updated.` : 'No tab groups will change.';
  return `${closingPart} ${groupingPart}`;
}

/**
 * Compose a completion status message.
 * @param {{closedCount: number, groupedCount: number}} stats
 */
function buildCompletionMessage(stats) {
  const parts = [];
  if (stats.closedCount) {
    parts.push(`Closed ${stats.closedCount} duplicate tab${stats.closedCount === 1 ? '' : 's'}.`);
  }
  if (stats.groupedCount) {
    parts.push(`Updated ${stats.groupedCount} tab group${stats.groupedCount === 1 ? '' : 's'}.`);
  }
  if (!parts.length) {
    parts.push('No changes were necessary.');
  }
  return parts.join(' ');
}
