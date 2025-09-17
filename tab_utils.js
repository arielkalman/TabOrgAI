/**
 * Utility helpers for working with Chrome tabs.
 * @module tab_utils
 */

const TRACKING_PARAM_PREFIXES = ['utm_'];
const TRACKING_PARAM_NAMES = ['gclid', 'fbclid', 'igshid', 'spm', 'ref', 'ref_src'];
const VALID_GROUP_COLORS = new Set([
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange'
]);

const DEFAULT_RULE_DEFINITIONS = [
  { name: 'GitHub PRs', host: /github\.com/i, path: /\/pull\/\d+/i, color: 'green' },
  { name: 'GitHub Issues', host: /github\.com/i, path: /\/issues?\//i, color: 'orange' },
  {
    name: 'Google Docs',
    host: /(docs|drive)\.google\.com/i,
    path: /\/(document|spreadsheets?|presentation|drive)/i,
    color: 'blue'
  },
  {
    name: 'Meetings',
    host: /(meet\.google\.com|zoom\.us|teams\.microsoft\.com)/i,
    color: 'purple'
  },
  {
    name: 'Project Hubs',
    host: /(linear\.app|asana\.com|app\.clickup\.com|notion\.so)/i,
    color: 'cyan'
  },
  {
    name: 'Social',
    host: /(twitter\.com|x\.com|facebook\.com|instagram\.com|linkedin\.com|reddit\.com)/i,
    color: 'pink'
  },
  {
    name: 'Search',
    host: /(google\.|bing\.|duckduckgo\.com)/i,
    path: /(search|results?)/i,
    color: 'yellow'
  }
];

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
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (!host) return null;

    let pathname = url.pathname || '';
    pathname = pathname.replace(/\/+$/, '');
    if (pathname && pathname !== '/' && !pathname.startsWith('/')) {
      pathname = `/${pathname}`;
    }
    if (pathname === '/' || pathname === '') {
      pathname = '';
    }

    const params = sanitizeQueryParams(url.searchParams);
    const queryString = params.toString();

    return queryString ? `${host}${pathname}?${queryString}` : `${host}${pathname}`;
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
 * Normalize tracking parameters and return a consistently ordered search params object.
 * @param {URLSearchParams} searchParams
 * @returns {URLSearchParams}
 */
function sanitizeQueryParams(searchParams) {
  const result = new URLSearchParams();
  if (!searchParams) return result;

  const keys = Array.from(searchParams.keys());
  for (const key of keys) {
    const lower = key.toLowerCase();
    const hasBlockedPrefix = TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix));
    if (hasBlockedPrefix || TRACKING_PARAM_NAMES.includes(lower)) {
      continue;
    }
    const values = searchParams.getAll(key);
    for (const value of values) {
      result.append(key, value);
    }
  }

  // Sort for deterministic order to maximize dedupe accuracy.
  const sorted = new URLSearchParams();
  const sortedKeys = Array.from(result.keys()).sort((a, b) => a.localeCompare(b));
  for (const key of sortedKeys) {
    const values = result.getAll(key);
    for (const value of values) {
      sorted.append(key, value);
    }
  }
  return sorted;
}

/**
 * Attempt to convert an arbitrary rule value into a regular expression descriptor.
 * @param {any} value
 * @returns {{ pattern: string, flags: string }|null}
 */
function normalizeRulePattern(value) {
  if (!value) return null;
  if (value instanceof RegExp) {
    return { pattern: value.source, flags: value.flags || 'i' };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return { pattern: trimmed, flags: 'i' };
  }
  if (typeof value === 'object') {
    const pattern = typeof value.pattern === 'string' ? value.pattern.trim() : '';
    if (!pattern) return null;
    const flags = typeof value.flags === 'string' ? value.flags : 'i';
    return { pattern, flags };
  }
  return null;
}

/**
 * Parse user-provided rule JSON into normalized rule definitions.
 * @param {string|undefined|null} jsonString
 * @returns {Array<{ name: string, host?: {pattern:string,flags:string}, title?: {pattern:string,flags:string}, path?: {pattern:string,flags:string}, color?: string }>}
 */
export function parseUserRulesJSON(jsonString) {
  if (!jsonString) return [];
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (error) {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }

  const cleaned = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) continue;
    const host = normalizeRulePattern(entry.host ?? entry.hostname ?? entry.hostPattern);
    const title = normalizeRulePattern(entry.title ?? entry.titlePattern);
    const path = normalizeRulePattern(entry.path ?? entry.pathname ?? entry.pathPattern);
    if (!host && !title && !path) continue;
    const color = sanitizeGroupColor(entry.color);
    cleaned.push({ name, host, title, path, color: color || undefined });
  }
  return cleaned;
}

/**
 * Ensure a provided color is valid for Chrome tab groups.
 * @param {any} value
 * @returns {string|null}
 */
function sanitizeGroupColor(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return VALID_GROUP_COLORS.has(normalized) ? normalized : null;
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

/**
 * Convert chrome.tab.Tab entries into TabSnapshots when needed.
 * @param {Array<chrome.tabs.Tab|TabSnapshot>} tabs
 * @returns {TabSnapshot[]}
 */
function ensureSnapshots(tabs) {
  if (!Array.isArray(tabs)) return [];
  return tabs.map((tab) => {
    if (tab && typeof tab === 'object' && 'windowId' in tab) {
      return snapshotTab(/** @type {chrome.tabs.Tab} */ (tab));
    }
    return /** @type {TabSnapshot} */ (tab);
  });
}

/**
 * Determine which tabs to close using deterministic logic.
 * @param {Array<chrome.tabs.Tab|TabSnapshot>} tabs
 * @param {{ preservePinned?: boolean, keepAtLeastOnePerDomain?: boolean }} preferences
 */
export function dedupeTabs(tabs, preferences = {}) {
  const snapshots = ensureSnapshots(tabs);
  return computeDedupePlan(snapshots, {
    preservePinned: preferences.preservePinned !== false,
    keepAtLeastOnePerDomain: preferences.keepAtLeastOnePerDomain !== false
  });
}

/**
 * Build deterministic tab groups using rule-based assignments and domain fallback.
 * @param {Array<chrome.tabs.Tab|TabSnapshot>} tabs
 * @param {{
 *  userRules?: ReturnType<typeof parseUserRulesJSON>,
 *  maxTabsPerGroup?: number|null,
 *  preservePinned?: boolean
 * }} [options]
 * @returns {{
 *  groups: Array<{ name: string, tabIds: number[], color?: string, tabs: Array<{id:number,title:string,url:string}>, source: string, sourceValue: string }>,
 *  summary: Array<{ name: string, count: number, color: string|null }>,
 *  assignedTabIds: number[],
 *  leftovers: TabSnapshot[]
 * }}
 */
export function groupByRules(tabs, options = {}) {
  const snapshots = ensureSnapshots(tabs).slice().sort((a, b) => a.index - b.index);
  const preservePinned = options.preservePinned !== false;
  const userRules = Array.isArray(options.userRules) ? options.userRules : [];
  const limitValue = Number(options.maxTabsPerGroup);
  const maxTabsPerGroup = Number.isFinite(limitValue) && limitValue >= 2 ? Math.floor(limitValue) : 0;

  const ruleMatchers = buildRuleMatchers(userRules);
  const state = { buckets: new Map(), ordered: [] };
  /** @type {Map<string, TabSnapshot[]>} */
  const fallbackCandidates = new Map();

  for (const tab of snapshots) {
    if (preservePinned && tab.pinned) {
      continue;
    }
    const parts = getUrlParts(tab.url);
    const match = matchRule(ruleMatchers, tab, parts);
    if (match) {
      assignTabToBucket(state, match, tab, maxTabsPerGroup);
      continue;
    }
    const domainKey = parts.host || extractDomain(tab.url) || '';
    if (!fallbackCandidates.has(domainKey)) {
      fallbackCandidates.set(domainKey, []);
    }
    fallbackCandidates.get(domainKey).push(tab);
  }

  /** @type {TabSnapshot[]} */
  const leftovers = [];

  for (const [domainKey, domainTabs] of fallbackCandidates.entries()) {
    const eligibleTabs = domainTabs.filter((tab) => !(preservePinned && tab.pinned));
    if (eligibleTabs.length < 2) {
      leftovers.push(...eligibleTabs);
      continue;
    }
    const baseName = truncateLabel(domainToLabel(domainKey) || 'Other');
    const baseKey = domainKey || 'other';
    let chunkIndex = 0;
    let cursor = 0;
    const limit = maxTabsPerGroup && maxTabsPerGroup > 1 ? maxTabsPerGroup : 0;
    while (cursor < eligibleTabs.length) {
      const remaining = eligibleTabs.length - cursor;
      const chunkSize = limit ? Math.min(limit, remaining) : remaining;
      if (chunkSize < 2) {
        leftovers.push(...eligibleTabs.slice(cursor));
        break;
      }
      const chunkTabs = eligibleTabs.slice(cursor, cursor + chunkSize);
      const descriptor = {
        key: `domain:${baseKey}:${chunkIndex}`,
        baseName: chunkIndex === 0 ? baseName : truncateLabel(`${baseName} (${chunkIndex + 1})`),
        color: undefined,
        source: 'domain',
        sourceValue: domainKey || 'Other'
      };
      for (const tab of chunkTabs) {
        assignTabToBucket(state, descriptor, tab, maxTabsPerGroup);
      }
      cursor += chunkSize;
      chunkIndex += 1;
    }
  }

  const finalGroups = [];
  for (const bucket of state.ordered) {
    if (bucket.source === 'domain' && bucket.tabIds.length < 2) {
      leftovers.push(
        ...bucket.tabs.map((tab) => ({
          id: tab.id,
          title: tab.title,
          url: tab.url,
          pinned: false,
          audible: false,
          active: false,
          groupId: -1,
          index: 0,
          lastAccessed: undefined
        }))
      );
      continue;
    }
    finalGroups.push({
      name: bucket.name,
      tabIds: bucket.tabIds.slice(),
      color: bucket.color,
      tabs: bucket.tabs.map((tab) => ({ ...tab })),
      source: bucket.source,
      sourceValue: bucket.sourceValue
    });
  }

  const assignedTabIds = finalGroups.flatMap((group) => group.tabIds.slice());
  const summary = finalGroups.map((group) => ({
    name: group.name,
    count: group.tabIds.length,
    color: group.color || null
  }));

  return { groups: finalGroups, summary, assignedTabIds, leftovers };
}

/**
 * Create compiled rule matchers from built-in and custom definitions.
 * @param {Array<{name:string, host?:any, title?:any, path?:any, color?:string}>} userRules
 */
function buildRuleMatchers(userRules) {
  const matchers = [];
  let counter = 0;
  for (const rule of userRules || []) {
    const matcher = createRuleMatcher(rule, `user-${counter++}`);
    if (matcher) matchers.push(matcher);
  }
  for (const rule of DEFAULT_RULE_DEFINITIONS) {
    const matcher = createRuleMatcher(rule, `default-${counter++}`);
    if (matcher) matchers.push(matcher);
  }
  return matchers;
}

/**
 * Build a single rule matcher instance.
 * @param {{name?:string, host?:any, title?:any, path?:any, color?:string}} rule
 * @param {string} key
 */
function createRuleMatcher(rule, key) {
  if (!rule || typeof rule !== 'object') return null;
  const name = typeof rule.name === 'string' ? rule.name.trim() : '';
  if (!name) return null;
  const host = compileRulePattern(rule.host ?? rule.hostname ?? rule.hostPattern);
  const title = compileRulePattern(rule.title ?? rule.titlePattern);
  const path = compileRulePattern(rule.path ?? rule.pathname ?? rule.pathPattern);
  if (!host && !title && !path) return null;
  const color = sanitizeGroupColor(rule.color);
  return {
    key,
    baseName: truncateLabel(name),
    color: color || undefined,
    host,
    title,
    path
  };
}

/**
 * Convert any pattern descriptor into a RegExp instance.
 * @param {any} descriptor
 * @returns {RegExp|null}
 */
function compileRulePattern(descriptor) {
  const normalized = normalizeRulePattern(descriptor);
  if (!normalized) return null;
  try {
    return new RegExp(normalized.pattern, normalized.flags || 'i');
  } catch (error) {
    return null;
  }
}

/**
 * Match a tab against prioritized rule matchers.
 * @param {Array<{key:string, baseName:string, color?:string, host?:RegExp|null, title?:RegExp|null, path?:RegExp|null}>} ruleMatchers
 * @param {TabSnapshot} tab
 * @param {{host: string, path: string}} parts
 */
function matchRule(ruleMatchers, tab, parts) {
  for (const matcher of ruleMatchers) {
    if (matcher.host && !matcher.host.test(parts.host)) continue;
    if (matcher.title && !matcher.title.test(tab.title || '')) continue;
    if (matcher.path && !matcher.path.test(parts.path)) continue;
    return {
      key: matcher.key,
      baseName: matcher.baseName,
      color: matcher.color,
      source: 'rule',
      sourceValue: matcher.baseName
    };
  }
  return null;
}

/**
 * Assign a tab to the correct bucket, enforcing max tabs per group when present.
 * @param {{ buckets: Map<string, any[]>, ordered: any[] }} state
 * @param {{ key?: string, baseName: string, color?: string, source?: string, sourceValue?: string }} descriptor
 * @param {TabSnapshot} tab
 * @param {number} maxTabsPerGroup
 */
function assignTabToBucket(state, descriptor, tab, maxTabsPerGroup) {
  const key = descriptor.key || `${descriptor.source || 'rule'}:${descriptor.baseName}:${descriptor.color || ''}`;
  let bucketList = state.buckets.get(key);
  if (!bucketList) {
    bucketList = [];
    state.buckets.set(key, bucketList);
  }
  const limit = maxTabsPerGroup && maxTabsPerGroup >= 2 ? maxTabsPerGroup : 0;
  let bucket = bucketList[bucketList.length - 1];
  if (!bucket || (limit && bucket.tabIds.length >= limit)) {
    const index = bucketList.length;
    const baseName = descriptor.baseName || 'Group';
    const label = index === 0 ? baseName : truncateLabel(`${baseName} (${index + 1})`);
    bucket = {
      name: truncateLabel(label),
      color: descriptor.color,
      source: descriptor.source || 'rule',
      sourceValue: descriptor.sourceValue || baseName,
      tabIds: [],
      tabs: []
    };
    bucketList.push(bucket);
    state.ordered.push(bucket);
  }
  bucket.tabIds.push(tab.id);
  bucket.tabs.push({ id: tab.id, title: tab.title, url: tab.url });
}

/**
 * Provide host/path parts for a URL.
 * @param {string} rawUrl
 */
function getUrlParts(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    const path = url.pathname || '/';
    return { host, path };
  } catch (error) {
    return { host: '', path: '' };
  }
}

/**
 * Convert a hostname into a compact grouping label.
 * @param {string} domain
 */
function domainToLabel(domain) {
  if (!domain) return 'Other';
  const parts = domain.split('.');
  if (parts.length <= 2) return domain;
  return parts.slice(-2).join('.');
}
