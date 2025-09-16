/**
 * Utility helpers for working with Chrome tabs.
 * @module tab_utils
 */

/**
 * @typedef {Object} OrganizePreferences
 * @property {boolean} keepAtLeastOnePerDomain
 * @property {boolean} preservePinned
 * @property {number} maxTabsPerGroup
 */

/**
 * @typedef {Object} TabSnapshot
 * @property {number} id
 * @property {string} title
 * @property {string} url
 * @property {boolean} pinned
 * @property {boolean} audible
 * @property {boolean} active
 * @property {number} groupId
 * @property {number} index
 * @property {number|undefined} lastAccessed
 */

/**
 * Capture only the tab fields that are needed for planning.
 * @param {chrome.tabs.Tab} tab
 * @returns {TabSnapshot}
 */
export function snapshotTab(tab) {
  return {
    id: tab.id ?? -1,
    title: tab.title ?? 'Untitled',
    url: tab.url ?? '',
    pinned: Boolean(tab.pinned),
    audible: Boolean(tab.audible),
    active: Boolean(tab.active),
    groupId: typeof tab.groupId === 'number' ? tab.groupId : chrome.tabGroups ? chrome.tabGroups.TAB_GROUP_ID_NONE : -1,
    index: typeof tab.index === 'number' ? tab.index : 0,
    lastAccessed: typeof tab.lastAccessed === 'number' ? tab.lastAccessed : undefined
  };
}

/**
 * Get tabs from the current Chrome window.
 * @returns {Promise<{windowId: number, tabs: TabSnapshot[]}>}
 */
export async function fetchCurrentWindowTabs() {
  const win = await chrome.windows.getCurrent({ populate: true });
  if (!win || !Array.isArray(win.tabs)) {
    throw new Error('Unable to read tabs for the current window.');
  }
  const snapshots = win.tabs
    .filter((tab) => typeof tab.id === 'number')
    .map((tab) => snapshotTab(tab));
  return { windowId: win.id ?? -1, tabs: snapshots };
}

/**
 * Attempt to normalize a URL to assist with deduplication.
 * The canonical form keeps the hostname and pathname while stripping
 * fragments and most query parameters.
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function canonicalizeUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    const pathname = url.pathname.replace(/\/$/, '');
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (!host) return null;
    return `${host}${pathname || ''}` || host;
  } catch (error) {
    return null;
  }
}

/**
 * Extract a normalized domain/hostname for summary and policies.
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function extractDomain(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return url.hostname.replace(/^www\./i, '').toLowerCase();
  } catch (error) {
    return null;
  }
}

/**
 * Decide which tabs should be closed because they are duplicates.
 * @param {TabSnapshot[]} tabs
 * @param {OrganizePreferences} preferences
 * @returns {{
 *   tabsToClose: Array<{id: number, title: string, url: string, reason: string, duplicateOf: number}>,
 *   survivors: TabSnapshot[],
 *   duplicateSets: Array<{canonical: string|null, keeper: TabSnapshot, closing: TabSnapshot[]}>
 * }}
 */
export function computeDedupePlan(tabs, preferences) {
  const canonicalGroups = new Map();
  const preferencePreservePinned = Boolean(preferences.preservePinned);
  const keepAtLeastOnePerDomain = Boolean(preferences.keepAtLeastOnePerDomain);

  for (const tab of tabs) {
    const canonical = canonicalizeUrl(tab.url);
    const key = canonical || `id-${tab.id}`;
    if (!canonicalGroups.has(key)) {
      canonicalGroups.set(key, []);
    }
    canonicalGroups.get(key).push(tab);
  }

  /** @type {Set<number>} */
  const keepers = new Set();
  /** @type {Array<{id: number, title: string, url: string, reason: string, duplicateOf: number, domain: string|null}>>} */
  const toClose = [];
  /** @type {Array<{canonical: string|null, keeper: TabSnapshot, closing: TabSnapshot[]}>} */
  const duplicateSets = [];

  for (const [canonicalKey, groupTabs] of canonicalGroups.entries()) {
    if (groupTabs.length === 1) {
      keepers.add(groupTabs[0].id);
      continue;
    }

    const sorted = groupTabs.slice().sort((a, b) => compareTabsForKeeper(b, a, preferencePreservePinned));
    const keeper = sorted[0];
    keepers.add(keeper.id);
    const duplicates = sorted.slice(1);
    const canonical = canonicalKey.startsWith('id-') ? null : canonicalKey;
    duplicateSets.push({ canonical, keeper, closing: duplicates });
    for (const dup of duplicates) {
      if (preferencePreservePinned && dup.pinned) {
        keepers.add(dup.id);
        continue;
      }
      toClose.push({
        id: dup.id,
        title: dup.title,
        url: dup.url,
        reason: `Duplicate of "${keeper.title}"`,
        duplicateOf: keeper.id,
        domain: extractDomain(dup.url)
      });
    }
  }

  // Enforce the per-domain requirement.
  if (keepAtLeastOnePerDomain) {
    const survivorDomainCounts = new Map();
    for (const tab of tabs) {
      if (!keepers.has(tab.id)) continue;
      const domain = extractDomain(tab.url);
      if (!domain) continue;
      survivorDomainCounts.set(domain, (survivorDomainCounts.get(domain) || 0) + 1);
    }

    const filteredClosures = [];
    for (const candidate of toClose) {
      const domain = candidate.domain;
      if (!domain) {
        filteredClosures.push(candidate);
        continue;
      }
      const survivors = survivorDomainCounts.get(domain) || 0;
      if (survivors <= 0) {
        keepers.add(candidate.id);
      } else {
        filteredClosures.push(candidate);
      }
    }
    toClose.length = 0;
    toClose.push(...filteredClosures);
  }

  const survivors = tabs.filter((tab) => keepers.has(tab.id) && !toClose.find((dup) => dup.id === tab.id));

  return {
    tabsToClose: toClose,
    survivors,
    duplicateSets
  };
}

/**
 * Compare two tabs to determine which should be the keeper.
 * Higher scores should be kept.
 * @param {TabSnapshot} left
 * @param {TabSnapshot} right
 * @param {boolean} preferPinned
 * @returns {number}
 */
function compareTabsForKeeper(left, right, preferPinned) {
  return scoreTab(left, preferPinned) - scoreTab(right, preferPinned);
}

/**
 * Score a tab for dedupe decisions.
 * @param {TabSnapshot} tab
 * @param {boolean} preferPinned
 * @returns {number}
 */
function scoreTab(tab, preferPinned) {
  let score = 0;
  if (tab.active) score += 10000;
  if (tab.audible) score += 200;
  if (preferPinned && tab.pinned) score += 8000;
  if (!preferPinned && tab.pinned) score += 2000;
  if (typeof tab.lastAccessed === 'number') score += tab.lastAccessed / 1000;
  score += 100 - tab.index;
  return score;
}

/**
 * Clean up and constrain group assignments suggested by the LLM.
 * @param {Array<{name?: string, tabIds?: number[]}>} llmGroups
 * @param {TabSnapshot[]} availableTabs
 * @param {{ maxTabsPerGroup: number, preservePinned: boolean }} preferences
 * @returns {{ groups: Array<{name: string, tabIds: number[]}>, assignedTabIds: Set<number> }}
 */
export function sanitizeGroupPlan(llmGroups, availableTabs, preferences) {
  const maxPerGroup = Math.max(2, Number(preferences.maxTabsPerGroup) || 6);
  const preservePinned = Boolean(preferences.preservePinned);
  const tabMap = new Map(availableTabs.map((tab) => [tab.id, tab]));
  const assigned = new Set();
  const cleaned = [];

  for (const group of llmGroups || []) {
    if (!group || !Array.isArray(group.tabIds)) continue;
    const proposedName = (group.name || '').trim();
    const name = proposedName ? truncateLabel(proposedName) : 'Group';
    const ids = [];
    for (const tabId of group.tabIds) {
      if (ids.length >= maxPerGroup) break;
      if (assigned.has(tabId)) continue;
      const tab = tabMap.get(tabId);
      if (!tab) continue;
      if (preservePinned && tab.pinned) continue;
      ids.push(tabId);
      assigned.add(tabId);
    }
    if (ids.length) {
      cleaned.push({ name, tabIds: ids });
    }
  }

  return { groups: cleaned, assignedTabIds: assigned };
}

/**
 * Create a short human-friendly preview description of a dedupe/group plan.
 * @param {{
 *  tabsToClose: Array<{id:number,title:string,url:string,reason:string}>,
 *  grouping: { groups: Array<{name: string, tabIds: number[]}> },
 *  tabLookup: Map<number, TabSnapshot>,
 *  notes?: string
 * }} plan
 * @returns {{closing: Array<{title: string, url: string}>, groups: Array<{name: string, tabs: Array<{title: string, url: string}>}>, notes?: string}}
 */
export function summarizePlanForPreview(plan) {
  const closing = plan.tabsToClose.map((item) => ({ title: item.title, url: item.url }));
  const groups = [];
  for (const group of plan.grouping.groups) {
    const tabs = group.tabIds
      .map((id) => plan.tabLookup.get(id))
      .filter(Boolean)
      .map((tab) => ({ title: tab.title, url: tab.url }));
    groups.push({ name: group.name, tabs });
  }
  return { closing, groups, notes: plan.notes };
}

/**
 * Make sure group labels are concise and readable.
 * @param {string} label
 * @returns {string}
 */
function truncateLabel(label) {
  const trimmed = label.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 24) return trimmed;
  return `${trimmed.slice(0, 21)}…`;
}
