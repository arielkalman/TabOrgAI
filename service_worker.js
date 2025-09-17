import { requestChatCompletion, extractMessageContent, DEFAULT_MODEL } from './llm.js';
import {
  fetchCurrentWindowTabs,
  computeDedupePlan,
  sanitizeGroupPlan,
  summarizePlanForPreview,
  extractDomain,
  dedupeTabs,
  groupByRules,
  parseUserRulesJSON,
  assignUniqueGroupColors
} from './tab_utils.js';

const RATE_LIMIT_INTERVAL_MS = 5000;
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const TAB_GROUP_ID_NONE =
  chrome.tabGroups && typeof chrome.tabGroups.TAB_GROUP_ID_NONE === 'number'
    ? chrome.tabGroups.TAB_GROUP_ID_NONE
    : -1;

const DEFAULT_SYNC_SETTINGS = {
  apiKey: '',
  model: DEFAULT_MODEL,
  keepAtLeastOnePerDomain: true,
  preservePinned: true,
  maxTabsPerGroup: 6,
  dryRun: false,
  dryRunNoLLM: false,
  userRulesJSON: ''
};

let lastCompletionTimestamp = 0;
const previewPlans = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === 'organize-tabs' || message.type === 'ORGANIZE_TABS_LLM') {
    handleOrganizeMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error('[Tab Organizer AI] organize-tabs error', error);
        sendResponse({ success: false, error: error.message || 'Unexpected error' });
      });
    return true;
  }

  if (message.type === 'ORGANIZE_TABS_NOLLM') {
    handleOrganizeTabsNoLLM(message)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error('[Tab Organizer AI] no-llm error', error);
        sendResponse({ success: false, error: error.message || 'Unexpected error' });
      });
    return true;
  }

  if (message.type === 'CLOSE_DUPLICATE_TABS') {
    handleCloseDuplicateTabs()
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error('[Tab Organizer AI] close duplicates error', error);
        sendResponse({ success: false, error: error.message || 'Unexpected error' });
      });
    return true;
  }

  return false;
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
 * Deterministic tab organization without the LLM dependency.
 * @param {{ dryRun?: boolean, userRules?: string }} message
 */
async function handleOrganizeTabsNoLLM(message) {
  const preferences = await loadPreferences();
  const dryRun = typeof message.dryRun === 'boolean' ? message.dryRun : Boolean(preferences.dryRunNoLLM);
  const rulesSource = typeof message.userRules === 'string' ? message.userRules : preferences.userRulesJSON || '';
  const userRules = parseUserRulesJSON(rulesSource);

  let currentWindow;
  try {
    currentWindow = await chrome.windows.getCurrent({ populate: false });
  } catch (error) {
    throw new Error('Unable to determine the current window.');
  }

  if (!currentWindow || typeof currentWindow.id !== 'number') {
    throw new Error('Unable to determine the current window.');
  }

  if (currentWindow.incognito) {
    throw new Error('The no-LLM organizer is unavailable in incognito windows.');
  }

  const tabs = await chrome.tabs.query({ windowId: currentWindow.id });
  if (!tabs.length) {
    throw new Error('No tabs were found in the current window.');
  }

  const dedupePlan = dedupeTabs(tabs, {
    preservePinned: preferences.preservePinned !== false,
    keepAtLeastOnePerDomain: preferences.keepAtLeastOnePerDomain !== false
  });

  const groupingMap = groupByRules(dedupePlan.survivors, {
    userRules,
    maxTabsPerGroup: preferences.maxTabsPerGroup,
    preservePinned: preferences.preservePinned !== false
  });

  const survivorLookup = new Map(dedupePlan.survivors.map((tab) => [tab.id, tab]));
  const colorMap = groupingMap.colors instanceof Map ? groupingMap.colors : new Map();
  const groupingArray = Array.from(groupingMap.entries()).map(([name, tabIds]) => {
    const tabsDetailed = tabIds
      .map((id) => survivorLookup.get(id))
      .filter(Boolean)
      .map((tab) => ({ id: tab.id, title: tab.title, url: tab.url }));
    return {
      name,
      tabIds: tabIds.slice(),
      color: colorMap.get(name) || null,
      tabs: tabsDetailed
    };
  });

  assignUniqueGroupColors(groupingArray);

  const summary = groupingArray.map((group) => ({ name: group.name, count: group.tabIds.length, color: group.color }));
  const closedPlanned = dedupePlan.tabsToClose.filter((item) => typeof item.id === 'number');
  const statusMessage = buildNoLlmStatus({
    closedCount: closedPlanned.length,
    groupCount: groupingArray.length,
    dryRun
  });

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      closed: closedPlanned.length,
      groups: summary,
      message: statusMessage,
      plan: {
        duplicates: dedupePlan.tabsToClose.map((item) => ({
          id: item.id,
          title: item.title,
          url: item.url,
          duplicateOf: item.duplicateOf
        })),
        groups: groupingArray.map((group) => ({
          name: group.name,
          color: group.color,
          count: group.tabIds.length,
          tabs: group.tabs
        }))
      }
    };
  }

  const applyResult = await applyNoLlmPlan(currentWindow.id, dedupePlan, groupingArray, {
    preservePinned: preferences.preservePinned !== false
  });

  const messageAfterApply = buildNoLlmStatus({
    closedCount: applyResult.closedCount,
    groupCount: applyResult.groups.length,
    dryRun: false
  });

  return {
    success: true,
    dryRun: false,
    closed: applyResult.closedCount,
    groups: applyResult.groups,
    message: messageAfterApply
  };
}

/**
 * Close duplicate tabs immediately using deterministic dedupe rules.
 */
async function handleCloseDuplicateTabs() {
  const preferences = await loadPreferences();
  const { windowId, tabs } = await fetchCurrentWindowTabs();

  if (!tabs.length) {
    throw new Error('No tabs were found in the current window.');
  }

  const dedupePlan = computeDedupePlan(tabs, {
    preservePinned: preferences.preservePinned !== false,
    keepAtLeastOnePerDomain: preferences.keepAtLeastOnePerDomain !== false
  });

  const allRemovalIds = dedupePlan.tabsToClose
    .map((item) => item && typeof item.id === 'number' ? item.id : null)
    .filter((id) => typeof id === 'number');

  if (!allRemovalIds.length) {
    return { success: true, closed: 0, message: 'No duplicate tabs detected.' };
  }

  const currentTabs = await chrome.tabs.query({ windowId });
  const currentIds = new Set(currentTabs.map((tab) => tab.id));
  const removalIds = allRemovalIds.filter((id) => currentIds.has(id));

  if (!removalIds.length) {
    return { success: true, closed: 0, message: 'No duplicate tabs detected.' };
  }

  try {
    await chrome.tabs.remove(removalIds);
  } catch (error) {
    console.warn('Failed to remove duplicate tabs', error);
    throw new Error('Unable to close duplicate tabs.');
  }

  const closedCount = removalIds.length;
  const message = `Closed ${closedCount} duplicate tab${closedCount === 1 ? '' : 's'}.`;
  return { success: true, closed: closedCount, message };
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

  const colorizedGroups = assignUniqueGroupColors(
    grouping.groups.map((group) => ({ ...group }))
  );

  for (const group of colorizedGroups) {
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
      const updatePayload = { title: group.name };
      if (group.color) {
        updatePayload.color = group.color;
      }
      await chrome.tabGroups.update(groupId, updatePayload);
      plannedAssignments.push({ groupId, name: group.name, tabIds: ids, color: group.color || null });
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
 * Apply deterministic dedupe and grouping results for the no-LLM path.
 * @param {number} windowId
 * @param {{ tabsToClose: Array<{id:number}>, survivors: any[] }} dedupePlan
 * @param {Array<{ name: string, tabIds: number[], color?: string|null }>} groupingArray
 * @param {{ preservePinned?: boolean }} options
 */
async function applyNoLlmPlan(windowId, dedupePlan, groupingArray, options = {}) {
  const preservePinned = options.preservePinned !== false;
  const currentTabs = await chrome.tabs.query({ windowId });
  const tabMap = new Map(currentTabs.map((tab) => [tab.id, tab]));

  assignUniqueGroupColors(groupingArray);

  const removalIds = [];
  for (const item of dedupePlan.tabsToClose) {
    const tab = tabMap.get(item.id);
    if (!tab) continue;
    if (preservePinned && tab.pinned) continue;
    removalIds.push(tab.id);
  }

  if (removalIds.length) {
    try {
      await chrome.tabs.remove(removalIds);
    } catch (error) {
      console.warn('Failed to remove duplicate tabs', error);
    }
  }

  const tabsAfterRemoval = removalIds.length ? await chrome.tabs.query({ windowId }) : currentTabs;
  const postRemovalMap = new Map(tabsAfterRemoval.map((tab) => [tab.id, tab]));
  const assigned = new Set();
  const appliedGroups = [];

  for (const group of groupingArray) {
    const candidateIds = [];
    for (const tabId of group.tabIds) {
      const tab = postRemovalMap.get(tabId);
      if (!tab) continue;
      if (preservePinned && tab.pinned) continue;
      candidateIds.push(tabId);
    }
    if (!candidateIds.length) continue;
    try {
      const groupId = await chrome.tabs.group({ tabIds: candidateIds });
      const updatePayload = { title: group.name };
      if (group.color) {
        updatePayload.color = group.color;
      }
      await chrome.tabGroups.update(groupId, updatePayload);
      candidateIds.forEach((id) => assigned.add(id));
      appliedGroups.push({ name: group.name, count: candidateIds.length, color: group.color || null });
    } catch (error) {
      console.warn('Failed to apply deterministic group', group, error);
    }
  }

  for (const tab of tabsAfterRemoval) {
    if (tab.groupId === TAB_GROUP_ID_NONE) continue;
    if (assigned.has(tab.id)) continue;
    if (preservePinned && tab.pinned) continue;
    try {
      await chrome.tabs.ungroup(tab.id);
    } catch (error) {
      console.warn('Failed to ungroup tab during deterministic apply', tab.id, error);
    }
  }

  await cleanupEmptyGroups(windowId);

  return {
    closedCount: removalIds.length,
    groups: appliedGroups
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
  const rawMaxTabs = Number(stored.maxTabsPerGroup);
  const maxTabsPerGroup = Number.isFinite(rawMaxTabs) && rawMaxTabs >= 2 ? Math.floor(rawMaxTabs) : DEFAULT_SYNC_SETTINGS.maxTabsPerGroup;
  return {
    apiKey: typeof stored.apiKey === 'string' ? stored.apiKey.trim() : '',
    model: typeof stored.model === 'string' && stored.model.trim() ? stored.model.trim() : DEFAULT_MODEL,
    keepAtLeastOnePerDomain: stored.keepAtLeastOnePerDomain !== false,
    preservePinned: stored.preservePinned !== false,
    maxTabsPerGroup,
    dryRun: Boolean(stored.dryRun),
    dryRunNoLLM: Boolean(stored.dryRunNoLLM),
    userRulesJSON: typeof stored.userRulesJSON === 'string' ? stored.userRulesJSON : ''
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

/**
 * Create a concise status line for deterministic organization results.
 * @param {{closedCount: number, groupCount: number, dryRun: boolean}} details
 */
function buildNoLlmStatus(details) {
  const closePart = details.closedCount
    ? `${details.dryRun ? 'Would close' : 'Closed'} ${details.closedCount} dupe${details.closedCount === 1 ? '' : 's'}`
    : details.dryRun
    ? 'Would keep all tabs'
    : 'No duplicates closed';
  const groupPart = details.groupCount
    ? `${details.dryRun ? 'Would organize' : 'Organized'} ${details.groupCount} group${details.groupCount === 1 ? '' : 's'}`
    : details.dryRun
    ? 'No groups to create'
    : 'No group changes';
  const summary = `${closePart} · ${groupPart}`;
  return details.dryRun ? `Dry-run: ${summary}` : summary;
}
