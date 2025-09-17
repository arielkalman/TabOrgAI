/*
 * Deterministic tab utilities for Tab Organizer AI.
 * The no-LLM mode relies entirely on the helpers in this file.
 */

const DEBUG = false;

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

const TRACKING_PARAM_PREFIXES = ['utm_', 'vero_', 'mc_'];
const TRACKING_PARAM_NAMES = new Set([
  'gclid',
  'fbclid',
  'igshid',
  'yclid',
  'vero_conv',
  'vero_id',
  'mc_cid',
  'mc_eid',
  'spm',
  'camp',
  'campaign',
  'aff',
  'ref',
  'ref_src',
  'referrer',
  'si',
  's',
  'feature',
  't',
  'dclid'
]);

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'the',
  'to',
  'was',
  'with',
  'via',
  'that',
  'this',
  'your',
  'you',
  'me',
  'we',
  'our',
  'they',
  'their',
  'them',
  'http',
  'https',
  'www'
]);

const MULTI_LEVEL_TLDS = new Set([
  'co.uk',
  'ac.uk',
  'gov.uk',
  'ltd.uk',
  'me.uk',
  'org.uk',
  'plc.uk',
  'sch.uk',
  'co.jp',
  'ne.jp',
  'or.jp',
  'ac.jp',
  'ad.jp',
  'co.kr',
  'or.kr',
  'go.kr',
  'co.nz',
  'gov.nz',
  'ac.nz',
  'com.au',
  'gov.au',
  'edu.au',
  'net.au',
  'org.au',
  'com.br',
  'com.cn',
  'com.hk',
  'co.in',
  'firm.in',
  'gen.in',
  'ind.in',
  'co.za'
]);

const lastClassification = new Map();

/**
 * Escape regex special characters.
 * @param {string} value
 * @returns {string}
 */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a host matcher that supports subdomains.
 * @param {string} host
 * @returns {RegExp}
 */
function hostPattern(host) {
  return new RegExp(`(?:^|\\.)${escapeRegex(host)}$`, 'i');
}

/**
 * Normalize host casing and strip www.
 * @param {string} host
 * @returns {string}
 */
function normalizeHost(host) {
  return host.replace(/^www\./i, '').toLowerCase();
}

/**
 * Normalize a path to remove trailing slashes.
 * @param {string} pathname
 * @returns {string}
 */
function normalizePath(pathname) {
  if (!pathname) return '/';
  let cleaned = pathname.replace(/\/+$/, '');
  if (!cleaned.startsWith('/')) {
    cleaned = `/${cleaned}`;
  }
  return cleaned === '/' ? '/' : cleaned;
}

/**
 * Remove accents from a string.
 * @param {string} value
 * @returns {string}
 */
function deburr(value) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .normalize('NFC');
}

/**
 * Ensure display labels remain short.
 * @param {string} label
 * @returns {string}
 */
function truncateLabel(label) {
  const trimmed = (label || '').trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 28) return trimmed;
  return `${trimmed.slice(0, 25)}…`;
}

/**
 * Safely parse a URL string.
 * @param {string} rawUrl
 * @returns {URL|null}
 */
function safeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    return new URL(rawUrl);
  } catch (error) {
    return null;
  }
}

/**
 * Canonicalize URLs for dedupe.
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function canonicalizeUrl(rawUrl) {
  const url = safeUrl(rawUrl);
  if (!url) return null;
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return rawUrl;
  }

  const normalizedHost = normalizeHost(url.hostname);
  const normalizedPath = normalizePath(url.pathname);
  const sanitizedParams = sanitizeQueryParams(url.searchParams, normalizedHost, normalizedPath);

  const base = {
    protocol: 'https',
    host: normalizedHost,
    path: normalizedPath,
    params: sanitizedParams
  };

  const specialized = applyServiceCanonicalization(url, base);
  const final = specialized || base;
  const queryString = final.params && final.params.toString ? final.params.toString() : '';
  const path = final.path === '/' ? '' : final.path;
  return queryString ? `https://${final.host}${path}?${queryString}` : `https://${final.host}${path}`;
}

/**
 * Remove tracking parameters from query strings.
 * @param {URLSearchParams} searchParams
 * @param {string} host
 * @param {string} path
 * @returns {URLSearchParams}
 */
function sanitizeQueryParams(searchParams, host, path) {
  const params = new URLSearchParams();
  if (!searchParams) return params;

  for (const key of searchParams.keys()) {
    const lower = key.toLowerCase();
    const hasPrefix = TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix));
    if (hasPrefix || TRACKING_PARAM_NAMES.has(lower)) {
      continue;
    }

    if (host.includes('google.') && lower !== 'q' && (path === '/' || path.startsWith('/search'))) {
      continue;
    }

    if ((host.endsWith('youtube.com') || host.endsWith('youtu.be')) && lower !== 'v' && lower !== 'list') {
      continue;
    }

    if (host.includes('amazon.') && lower !== 'k' && lower !== 'node') {
      continue;
    }

    const values = searchParams.getAll(key);
    for (const value of values) {
      params.append(key, value);
    }
  }

  const sorted = new URLSearchParams();
  const sortedKeys = Array.from(params.keys()).sort((a, b) => a.localeCompare(b));
  for (const key of sortedKeys) {
    const values = params.getAll(key);
    for (const value of values) {
      sorted.append(key, value);
    }
  }
  return sorted;
}

/**
 * Service-specific canonicalization rules.
 * @param {URL} original
 * @param {{protocol:string, host:string, path:string, params:URLSearchParams}} base
 * @returns {{protocol:string, host:string, path:string, params:URLSearchParams}|null}
 */
function applyServiceCanonicalization(original, base) {
  const host = base.host;
  const path = base.path;

  if (host.endsWith('youtu.be')) {
    const id = original.pathname.replace(/^\//, '').split(/[?&#]/)[0];
    if (id) {
      const params = new URLSearchParams();
      params.set('v', id);
      return { protocol: 'https', host: 'youtube.com', path: '/watch', params };
    }
  }

  if (host.endsWith('youtube.com')) {
    const params = new URLSearchParams();
    const originalParams = original.searchParams;
    if (path.startsWith('/watch')) {
      const videoId = originalParams.get('v');
      if (videoId) {
        params.set('v', videoId);
        const list = originalParams.get('list');
        if (list) params.set('list', list);
        return { protocol: 'https', host: 'youtube.com', path: '/watch', params };
      }
    }
    if (path.startsWith('/playlist')) {
      const list = originalParams.get('list');
      if (list) {
        params.set('list', list);
        return { protocol: 'https', host: 'youtube.com', path: '/playlist', params };
      }
    }
  }

  if (host === 'docs.google.com') {
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'document' && parts[1] === 'd' && parts[2]) {
      return { protocol: 'https', host, path: `/document/d/${parts[2]}`, params: new URLSearchParams() };
    }
    if (parts[0] === 'spreadsheets' && parts[1] === 'd' && parts[2]) {
      return { protocol: 'https', host, path: `/spreadsheets/d/${parts[2]}`, params: new URLSearchParams() };
    }
    if (parts[0] === 'presentation' && parts[1] === 'd' && parts[2]) {
      return { protocol: 'https', host, path: `/presentation/d/${parts[2]}`, params: new URLSearchParams() };
    }
    if (parts[0] === 'forms' && parts[1] === 'd' && parts[2]) {
      return { protocol: 'https', host, path: `/forms/d/${parts[2]}`, params: new URLSearchParams() };
    }
  }

  if (host === 'drive.google.com') {
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'file' && parts[1] === 'd' && parts[2]) {
      return { protocol: 'https', host, path: `/file/d/${parts[2]}`, params: new URLSearchParams() };
    }
    if (parts[0] === 'drive' && parts[1] === 'folders' && parts[2]) {
      return { protocol: 'https', host, path: `/drive/folders/${parts[2]}`, params: new URLSearchParams() };
    }
  }

  if (host === 'mail.google.com') {
    const params = new URLSearchParams();
    const view = original.searchParams.get('view');
    const tab = original.searchParams.get('tab');
    if (view) params.set('view', view);
    if (tab) params.set('tab', tab);
    return { protocol: 'https', host, path: '/mail', params };
  }

  if (host.endsWith('github.com')) {
    const repoMatch = /^\/(.+?)\/(.+?)(?:\/|$)/.exec(path);
    if (repoMatch) {
      const owner = repoMatch[1];
      const repo = repoMatch[2];
      const tail = path.slice(repoMatch[0].length - 1);
      if (/^\/pull\//.test(tail)) {
        const pr = tail.split('/')[2];
        if (pr) {
          return { protocol: 'https', host: 'github.com', path: `/${owner}/${repo}/pull/${pr}`, params: new URLSearchParams() };
        }
      }
      if (/^\/issues\//.test(tail)) {
        const issue = tail.split('/')[2];
        if (issue) {
          return { protocol: 'https', host: 'github.com', path: `/${owner}/${repo}/issues/${issue}`, params: new URLSearchParams() };
        }
      }
      if (/^\/discussions\//.test(tail)) {
        const discussion = tail.split('/')[2];
        if (discussion) {
          return { protocol: 'https', host: 'github.com', path: `/${owner}/${repo}/discussions/${discussion}`, params: new URLSearchParams() };
        }
      }
      if (/^\/commit\//.test(tail)) {
        const commit = tail.split('/')[2];
        if (commit) {
          return { protocol: 'https', host: 'github.com', path: `/${owner}/${repo}/commit/${commit}`, params: new URLSearchParams() };
        }
      }
      if (/^\/(?:blob|tree)\//.test(tail)) {
        const segments = tail.split('/').slice(1, 3);
        return { protocol: 'https', host: 'github.com', path: `/${owner}/${repo}/${segments[0]}/${segments[1] || 'main'}`, params: new URLSearchParams() };
      }
    }
  }

  if (host.includes('atlassian.net') || host.endsWith('jira.com')) {
    const issueMatch = /\/(?:browse|jira\/software\/c\/projects\/[^/]+\/boards\/[^/]+)\/([A-Z0-9]+-\d+)/i.exec(original.pathname);
    if (issueMatch) {
      return { protocol: 'https', host, path: `/browse/${issueMatch[1].toUpperCase()}`, params: new URLSearchParams() };
    }
  }

  if (host.endsWith('linear.app')) {
    const issueMatch = /\/issue\/([A-Z]+-\d+)/.exec(original.pathname);
    if (issueMatch) {
      return { protocol: 'https', host, path: `/issue/${issueMatch[1].toUpperCase()}`, params: new URLSearchParams() };
    }
  }

  if (host.endsWith('youtrack.cloud') || host.endsWith('myjetbrains.com')) {
    const issueMatch = /\/issue\/([A-Z0-9_]+-\d+)/i.exec(original.pathname);
    if (issueMatch) {
      return { protocol: 'https', host, path: `/issue/${issueMatch[1].toUpperCase()}`, params: new URLSearchParams() };
    }
  }

  if (host.includes('google.') && (path === '/' || path.startsWith('/search'))) {
    const query = original.searchParams.get('q');
    if (query) {
      const params = new URLSearchParams();
      params.set('q', query);
      return { protocol: 'https', host: 'google.com', path: '/search', params };
    }
  }

  if (host.includes('amazon.')) {
    const dpMatch = /\/dp\/([A-Z0-9]{6,})/.exec(original.pathname);
    if (dpMatch) {
      return { protocol: 'https', host, path: `/dp/${dpMatch[1]}`, params: new URLSearchParams() };
    }
    const productMatch = /\/gp\/product\/([A-Z0-9]{6,})/.exec(original.pathname);
    if (productMatch) {
      return { protocol: 'https', host, path: `/dp/${productMatch[1]}`, params: new URLSearchParams() };
    }
    if (original.pathname.startsWith('/s')) {
      const keyword = original.searchParams.get('k');
      const params = new URLSearchParams();
      if (keyword) params.set('k', keyword);
      return { protocol: 'https', host, path: '/s', params };
    }
  }

  if (host.endsWith('ebay.com')) {
    const itemMatch = /\/itm\/(\d+)/.exec(original.pathname);
    if (itemMatch) {
      return { protocol: 'https', host, path: `/itm/${itemMatch[1]}`, params: new URLSearchParams() };
    }
    if (original.pathname.startsWith('/sch')) {
      const query = original.searchParams.get('_nkw');
      const params = new URLSearchParams();
      if (query) params.set('_nkw', query);
      return { protocol: 'https', host, path: '/sch', params };
    }
  }

  if (host.endsWith('airbnb.com')) {
    if (original.pathname.startsWith('/rooms')) {
      const roomId = original.pathname.split('/')[2];
      if (roomId) {
        return { protocol: 'https', host, path: `/rooms/${roomId}`, params: new URLSearchParams() };
      }
    }
  }

  if (host.endsWith('booking.com')) {
    if (/\/hotel\//.test(original.pathname)) {
      return { protocol: 'https', host, path: original.pathname.replace(/\/$/, ''), params: new URLSearchParams() };
    }
  }

  if (host.endsWith('skyscanner.net') || host.endsWith('skyscanner.com')) {
    const segments = original.pathname.split('/').filter(Boolean).slice(0, 5);
    return { protocol: 'https', host, path: `/${segments.join('/')}`, params: new URLSearchParams() };
  }

  if (host.endsWith('open.spotify.com')) {
    const segments = original.pathname.split('/').filter(Boolean).slice(0, 2);
    return { protocol: 'https', host, path: `/${segments.join('/')}`, params: new URLSearchParams() };
  }

  if (host.endsWith('music.apple.com')) {
    const segments = original.pathname.split('/').filter(Boolean).slice(0, 4);
    return { protocol: 'https', host, path: `/${segments.join('/')}`, params: new URLSearchParams() };
  }

  return null;
}

/**
 * Extract an eTLD+1 domain from a URL.
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function extractDomain(rawUrl) {
  const url = safeUrl(rawUrl);
  if (!url) return null;
  const host = normalizeHost(url.hostname);
  return getEffectiveDomain(host);
}

/**
 * Compute the effective domain using a limited suffix list.
 * @param {string} host
 * @returns {string|null}
 */
function getEffectiveDomain(host) {
  if (!host) return null;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  const lastThree = parts.slice(-3).join('.');
  if (MULTI_LEVEL_TLDS.has(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  if (MULTI_LEVEL_TLDS.has(lastThree)) {
    return parts.slice(-4).join('.');
  }
  return lastTwo;
}

/**
 * Parse custom rules JSON.
 * @param {string} jsonString
 * @returns {Array<{name:string,host?:{pattern:string,flags:string},path?:{pattern:string,flags:string},title?:{pattern:string,flags:string},color?:string,priority?:number}>}
 */
export function parseUserRulesJSON(jsonString) {
  if (!jsonString) return [];
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (error) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const results = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) continue;
    const host = normalizeRulePattern(entry.host || entry.hostname || entry.hostPattern);
    const path = normalizeRulePattern(entry.path || entry.pathname || entry.pathPattern);
    const title = normalizeRulePattern(entry.title || entry.titlePattern);
    const color = sanitizeGroupColor(entry.color);
    const priority = Number.isFinite(entry.priority) ? Number(entry.priority) : 10000;
    if (!host && !path && !title) continue;
    results.push({ name, host, path, title, color, priority });
  }
  return results;
}

/**
 * Normalize a rule pattern entry.
 * @param {any} value
 * @returns {{pattern:string,flags:string}|null}
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
 * Ensure group colors are valid Chrome colors.
 * @param {any} value
 * @returns {string|null}
 */
function sanitizeGroupColor(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return VALID_GROUP_COLORS.has(normalized) ? normalized : null;
}

/**
 * Snapshot a Chrome tab.
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
    groupId:
      typeof tab.groupId === 'number'
        ? tab.groupId
        : chrome.tabGroups
        ? chrome.tabGroups.TAB_GROUP_ID_NONE
        : -1,
    index: typeof tab.index === 'number' ? tab.index : 0,
    lastAccessed: typeof tab.lastAccessed === 'number' ? tab.lastAccessed : undefined
  };
}

/**
 * Fetch tabs from the current window.
 * @returns {Promise<{windowId:number,tabs:TabSnapshot[]}>}
 */
export async function fetchCurrentWindowTabs() {
  const win = await chrome.windows.getCurrent({ populate: true });
  if (!win || !Array.isArray(win.tabs)) {
    throw new Error('Unable to read tabs for the current window.');
  }
  const snapshots = win.tabs.filter((tab) => typeof tab.id === 'number').map((tab) => snapshotTab(tab));
  return { windowId: win.id ?? -1, tabs: snapshots };
}

/**
 * Determine duplicates.
 * @param {TabSnapshot[]} tabs
 * @param {{ preservePinned: boolean, keepAtLeastOnePerDomain: boolean }} preferences
 * @returns {{ tabsToClose: Array<{id:number,title:string,url:string,reason:string,duplicateOf:number,domain:string|null}>, survivors: TabSnapshot[], duplicateSets: Array<{canonical: string|null, keeper: TabSnapshot, closing: TabSnapshot[]}> }}
 */
export function computeDedupePlan(tabs, preferences) {
  const canonicalGroups = new Map();
  for (const tab of tabs) {
    const canonical = canonicalizeUrl(tab.url);
    const key = canonical || `id-${tab.id}`;
    if (!canonicalGroups.has(key)) {
      canonicalGroups.set(key, []);
    }
    canonicalGroups.get(key).push(tab);
  }

  const keepers = new Set();
  const tabsToClose = [];
  const duplicateSets = [];

  for (const [key, groupTabs] of canonicalGroups.entries()) {
    if (groupTabs.length === 1) {
      keepers.add(groupTabs[0].id);
      continue;
    }
    const sorted = groupTabs.slice().sort((a, b) => scoreTab(b, preferences.preservePinned) - scoreTab(a, preferences.preservePinned));
    const keeper = sorted[0];
    keepers.add(keeper.id);
    const duplicates = sorted.slice(1);
    duplicateSets.push({ canonical: key.startsWith('id-') ? null : key, keeper, closing: duplicates });
    for (const dup of duplicates) {
      if (preferences.preservePinned && dup.pinned) {
        keepers.add(dup.id);
        continue;
      }
      tabsToClose.push({
        id: dup.id,
        title: dup.title,
        url: dup.url,
        reason: `Duplicate of "${keeper.title}"`,
        duplicateOf: keeper.id,
        domain: extractDomain(dup.url)
      });
    }
  }

  if (preferences.keepAtLeastOnePerDomain) {
    const survivorDomains = new Map();
    for (const tab of tabs) {
      if (!keepers.has(tab.id)) continue;
      const domain = extractDomain(tab.url);
      if (!domain) continue;
      survivorDomains.set(domain, (survivorDomains.get(domain) || 0) + 1);
    }

    const filtered = [];
    for (const item of tabsToClose) {
      if (!item.domain) {
        filtered.push(item);
        continue;
      }
      const count = survivorDomains.get(item.domain) || 0;
      if (count <= 0) {
        keepers.add(item.id);
      } else {
        survivorDomains.set(item.domain, count - 1);
        filtered.push(item);
      }
    }
    tabsToClose.length = 0;
    tabsToClose.push(...filtered);
  }

  const survivors = tabs.filter((tab) => keepers.has(tab.id) && !tabsToClose.some((item) => item.id === tab.id));
  return { tabsToClose, survivors, duplicateSets };
}

/**
 * Score tabs when selecting which duplicate to keep.
 * @param {TabSnapshot} tab
 * @param {boolean} preferPinned
 * @returns {number}
 */
function scoreTab(tab, preferPinned) {
  let score = 0;
  if (tab.active) score += 10000;
  if (tab.audible) score += 400;
  if (preferPinned && tab.pinned) score += 8000;
  if (!preferPinned && tab.pinned) score += 2000;
  if (typeof tab.lastAccessed === 'number') score += tab.lastAccessed / 1000;
  score += 100 - tab.index;
  return score;
}

/**
 * Convenience wrapper for dedupe.
 * @param {Array<chrome.tabs.Tab|TabSnapshot>} tabs
 * @param {{ preservePinned?: boolean, keepAtLeastOnePerDomain?: boolean }} preferences
 * @returns {ReturnType<typeof computeDedupePlan>}
 */
export function dedupeTabs(tabs, preferences = {}) {
  const snapshots = ensureSnapshots(tabs);
  return computeDedupePlan(snapshots, {
    preservePinned: preferences.preservePinned !== false,
    keepAtLeastOnePerDomain: preferences.keepAtLeastOnePerDomain !== false
  });
}

/**
 * Convert chrome.tab.Tab entries into snapshots.
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
 * Convert host entry into a RegExp matcher.
 * @param {string|RegExp|undefined} value
 * @returns {RegExp|undefined}
 */
function resolveHostRegex(value) {
  if (!value) return undefined;
  if (value instanceof RegExp) return value;
  if (typeof value === 'string') {
    return hostPattern(value);
  }
  return undefined;
}

/**
 * Convert an arbitrary pattern into a RegExp.
 * @param {string|RegExp|undefined} value
 * @param {string} [flags]
 * @returns {RegExp|undefined}
 */
function resolveRegex(value, flags = 'i') {
  if (!value) return undefined;
  if (value instanceof RegExp) return value;
  if (typeof value === 'string') {
    return new RegExp(value, flags);
  }
  return undefined;
}

/**
 * Helper to push batches of simple rule definitions.
 * @param {Array} target
 * @param {Array} entries
 * @param {{ priority?: number, color?: string }} [defaults]
 */
function pushSimpleRules(target, entries, defaults = {}) {
  for (const entry of entries) {
    target.push({
      name: entry.name,
      color: entry.color || defaults.color,
      priority: entry.priority ?? defaults.priority ?? 400,
      match: {
        hostRegex: resolveHostRegex(entry.host || entry.hostRegex),
        pathRegex: resolveRegex(entry.path || entry.pathRegex),
        titleRegex: resolveRegex(entry.title || entry.titleRegex)
      },
      deriveName: entry.deriveName
    });
  }
}

/**
 * Prepare a tab snapshot for classification.
 * @param {TabSnapshot} tab
 * @returns {{
 *   tab: TabSnapshot,
 *   id: number,
 *   host: string,
 *   domain: string,
 *   path: string,
 *   pathSegments: string[],
 *   canonical: string|null,
 *   title: string,
 *   normalizedTitle: string,
 *   tokenFrequency: Map<string, number>,
 *   tokens: Set<string>,
 *   url: URL|null,
 *   searchParams: URLSearchParams
 * }}
 */
function prepareTabForClassification(tab) {
  const url = safeUrl(tab.url);
  const host = url ? normalizeHost(url.hostname) : '';
  const path = url ? normalizePath(url.pathname) : '/';
  const pathSegments = path.split('/').filter(Boolean).map((segment) => safeDecodeURIComponent(segment));
  const domain = getEffectiveDomain(host) || host;
  const canonical = canonicalizeUrl(tab.url);
  const title = tab.title || '';
  const normalizedTitle = deburr(title.toLowerCase());
  const tokenFrequency = buildTokenFrequency(title, host, path);
  const tokens = new Set(tokenFrequency.keys());
  return {
    tab,
    id: tab.id,
    host,
    domain,
    path,
    pathSegments,
    canonical,
    title,
    normalizedTitle,
    tokenFrequency,
    tokens,
    url,
    searchParams: url ? url.searchParams : new URLSearchParams()
  };
}

/**
 * Decode URL segments safely.
 * @param {string} value
 * @returns {string}
 */
function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}

/**
 * Build a token frequency map from host, path, and title data.
 * @param {string} title
 * @param {string} host
 * @param {string} path
 * @returns {Map<string, number>}
 */
function buildTokenFrequency(title, host, path) {
  const text = `${host.replace(/\./g, ' ')} ${path.replace(/\//g, ' ')} ${title}`;
  const normalized = deburr(text.toLowerCase());
  const tokens = normalized.replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
  const freq = new Map();
  for (let token of tokens) {
    if (STOP_WORDS.has(token)) continue;
    token = stemToken(token);
    if (!token || STOP_WORDS.has(token)) continue;
    freq.set(token, (freq.get(token) || 0) + 1);
  }
  return freq;
}

/**
 * Light stemming for English tokens.
 * @param {string} token
 * @returns {string}
 */
function stemToken(token) {
  if (token.length <= 3) return token;
  if (token.endsWith('ing')) token = token.slice(0, -3);
  if (token.endsWith('ers')) token = token.slice(0, -3);
  if (token.endsWith('er')) token = token.slice(0, -2);
  if (token.endsWith('ed')) token = token.slice(0, -2);
  if (token.endsWith('es')) token = token.slice(0, -2);
  if (token.endsWith('s')) token = token.slice(0, -1);
  return token;
}

/**
 * Assign a tab to the target group map while respecting size limits.
 * @param {Map<string, number[]>} groups
 * @param {Map<string, string>} colorMap
 * @param {Map<string, number>} counters
 * @param {string} baseName
 * @param {string|undefined} color
 * @param {number} tabId
 * @param {number} limit
 * @returns {string}
 */
function assignTabToGroupMap(groups, colorMap, counters, baseName, color, tabId, limit) {
  const resolvedName = resolveGroupName(groups, counters, baseName, limit);
  if (!groups.has(resolvedName)) {
    groups.set(resolvedName, []);
  }
  const list = groups.get(resolvedName);
  list.push(tabId);
  if (color && !colorMap.has(resolvedName)) {
    colorMap.set(resolvedName, color);
  }
  return resolvedName;
}

/**
 * Pick the appropriate group label given a base name and limit.
 * @param {Map<string, number[]>} groups
 * @param {Map<string, number>} counters
 * @param {string} baseName
 * @param {number} limit
 * @returns {string}
 */
function resolveGroupName(groups, counters, baseName, limit) {
  const clean = truncateLabel(baseName || 'Group');
  if (!limit || limit < 2) {
    return clean;
  }
  let index = counters.get(clean) || 0;
  let candidate = index === 0 ? clean : `${clean} (${index + 1})`;
  while (groups.has(candidate) && groups.get(candidate).length >= limit) {
    index += 1;
    candidate = `${clean} (${index + 1})`;
  }
  counters.set(clean, index);
  return candidate;
}

/**
 * Extract repository details from GitHub paths.
 * @param {string[]} segments
 * @returns {{ owner: string, repo: string }|null}
 */
function extractGitHubRepo(segments) {
  if (!segments || segments.length < 2) return null;
  const owner = segments[0];
  const repo = segments[1];
  if (!owner || !repo || owner === 'topics') return null;
  return {
    owner: owner,
    repo: repo.replace(/\.git$/i, '')
  };
}

/**
 * Build a GitHub-specific derived group name.
 * @param {{ pathSegments: string[] }} tabInfo
 * @param {string} fallback
 * @param {string} suffix
 * @param {string|undefined} color
 * @returns {{ name: string, key?: string, color?: string }}
 */
function deriveGitHubName(tabInfo, fallback, suffix, color) {
  const repo = extractGitHubRepo(tabInfo.pathSegments);
  if (!repo) {
    return { name: fallback, color };
  }
  const label = `${repo.owner}/${repo.repo}`;
  return {
    name: `GitHub – ${label} – ${suffix}`,
    key: `github:${suffix.toLowerCase()}:${label.toLowerCase()}`,
    color
  };
}

/**
 * Extract project identifiers from Jira style URLs.
 * @param {{ pathSegments: string[] }} tabInfo
 * @returns {string|null}
 */
function extractJiraKey(tabInfo) {
  for (const segment of tabInfo.pathSegments) {
    const match = /([A-Z][A-Z0-9]+-\d+)/.exec(segment.toUpperCase());
    if (match) return match[1];
  }
  return null;
}

/**
 * Derive Slack workspace/channel names from tab titles.
 * @param {{ title: string }} tabInfo
 * @returns {{ name: string, key?: string }|null}
 */
function deriveSlackName(tabInfo) {
  const title = tabInfo.title || '';
  const match = /(.*?)\s+(?:[-|])\s+Slack/i.exec(title);
  if (match && match[1]) {
    const channel = match[1].trim();
    return { name: `Slack – ${truncateLabel(channel)}`, key: `slack:${channel.toLowerCase()}` };
  }
  const workspaceMatch = /(.*?)\s+-\s+Slack/i.exec(title);
  if (workspaceMatch && workspaceMatch[1]) {
    const workspace = workspaceMatch[1].trim();
    return { name: `Slack – ${truncateLabel(workspace)}`, key: `slack:${workspace.toLowerCase()}` };
  }
  return null;
}

/**
 * Extract subreddit names from Reddit URLs.
 * @param {{ pathSegments: string[] }} tabInfo
 * @returns {string|null}
 */
function extractSubreddit(tabInfo) {
  const segments = tabInfo.pathSegments;
  const index = segments.indexOf('r');
  if (index !== -1 && segments[index + 1]) {
    return segments[index + 1];
  }
  if (segments[0] === 'r' && segments[1]) {
    return segments[1];
  }
  return null;
}

/**
 * Derive LinkedIn sub-views from path segments.
 * @param {{ pathSegments: string[] }} tabInfo
 * @returns {string}
 */
function deriveLinkedInSuffix(tabInfo) {
  const segments = tabInfo.pathSegments;
  if (!segments.length) return 'Feed';
  if (segments[0] === 'jobs') return 'Jobs';
  if (segments[0] === 'in') return 'Profiles';
  if (segments[0] === 'messaging') return 'Messaging';
  if (segments[0] === 'notifications') return 'Notifications';
  return 'Feed';
}

const RULES_CATALOG = buildRulesCatalog();
const COMPILED_RULES = compileRuleCatalog(RULES_CATALOG);

/**
 * Build the comprehensive rules catalog covering 200+ services.
 */
function buildRulesCatalog() {
  const rules = [];

  // GitHub detailed views.
  rules.push(
    {
      name: 'GitHub – Pull Requests',
      color: 'green',
      priority: 1200,
      match: { hostRegex: hostPattern('github.com'), pathRegex: /\/[^/]+\/[^/]+\/pull\//i },
      deriveName: (tabInfo) => deriveGitHubName(tabInfo, 'GitHub – Pull Requests', 'PRs', 'green')
    },
    {
      name: 'GitHub – Issues',
      color: 'orange',
      priority: 1180,
      match: { hostRegex: hostPattern('github.com'), pathRegex: /\/[^/]+\/[^/]+\/issues\//i },
      deriveName: (tabInfo) => deriveGitHubName(tabInfo, 'GitHub – Issues', 'Issues', 'orange')
    },
    {
      name: 'GitHub – Discussions',
      color: 'purple',
      priority: 1170,
      match: { hostRegex: hostPattern('github.com'), pathRegex: /\/[^/]+\/[^/]+\/discussions\//i },
      deriveName: (tabInfo) => deriveGitHubName(tabInfo, 'GitHub – Discussions', 'Discussions', 'purple')
    },
    {
      name: 'GitHub – Code',
      color: 'blue',
      priority: 1150,
      match: { hostRegex: hostPattern('github.com'), pathRegex: /\/[^/]+\/[^/]+\/(?:blob|tree)\//i },
      deriveName: (tabInfo) => deriveGitHubName(tabInfo, 'GitHub – Code', 'Code', 'blue')
    },
    {
      name: 'GitHub – Releases',
      color: 'grey',
      priority: 1140,
      match: { hostRegex: hostPattern('github.com'), pathRegex: /\/[^/]+\/[^/]+\/releases/i },
      deriveName: (tabInfo) => deriveGitHubName(tabInfo, 'GitHub – Releases', 'Releases', 'grey')
    },
    {
      name: 'GitHub – Actions',
      color: 'cyan',
      priority: 1130,
      match: { hostRegex: hostPattern('github.com'), pathRegex: /\/[^/]+\/[^/]+\/actions/i },
      deriveName: (tabInfo) => deriveGitHubName(tabInfo, 'GitHub – Actions', 'CI/CD', 'cyan')
    },
    {
      name: 'GitHub – Projects',
      color: 'yellow',
      priority: 1120,
      match: { hostRegex: hostPattern('github.com'), pathRegex: /\/[^/]+\/[^/]+\/projects/i },
      deriveName: (tabInfo) => deriveGitHubName(tabInfo, 'GitHub – Projects', 'Projects', 'yellow')
    },
    {
      name: 'GitHub – Wiki',
      color: 'blue',
      priority: 1110,
      match: { hostRegex: hostPattern('github.com'), pathRegex: /\/[^/]+\/[^/]+\/wiki/i },
      deriveName: (tabInfo) => deriveGitHubName(tabInfo, 'GitHub – Wiki', 'Wiki', 'blue')
    },
    {
      name: 'GitHub – Gists',
      color: 'green',
      priority: 1090,
      match: { hostRegex: hostPattern('gist.github.com') },
      deriveName: () => ({ name: 'GitHub – Gists', color: 'green' })
    },
    {
      name: 'GitHub – Notifications',
      color: 'purple',
      priority: 1080,
      match: { hostRegex: hostPattern('github.com'), pathRegex: /^\/notifications/i },
      deriveName: () => ({ name: 'GitHub – Notifications', color: 'purple' })
    }
  );

  // GitLab and other code hosts.
  pushSimpleRules(
    rules,
    [
      {
        name: 'GitLab – Merge Requests',
        host: 'gitlab.com',
        path: /\/([^/]+\/[^/]+\/)?-\/merge_requests/i,
        color: 'green',
        priority: 1050,
        deriveName: (tabInfo) => {
          const repo = extractGitHubRepo(tabInfo.pathSegments);
          if (repo) {
            return { name: `GitLab – ${repo.owner}/${repo.repo} – MRs`, color: 'green' };
          }
          return { name: 'GitLab – Merge Requests', color: 'green' };
        }
      },
      {
        name: 'GitLab – Issues',
        host: 'gitlab.com',
        path: /\/([^/]+\/[^/]+\/)?-\/issues/i,
        color: 'orange',
        priority: 1040
      },
      {
        name: 'GitLab – Pipelines',
        host: 'gitlab.com',
        path: /\/([^/]+\/[^/]+\/)?-\/pipelines/i,
        color: 'cyan',
        priority: 1030
      },
      {
        name: 'GitLab – Snippets',
        host: 'gitlab.com',
        path: /\/snippets/i,
        color: 'blue',
        priority: 1020
      }
    ],
    { priority: 1020 }
  );

  pushSimpleRules(
    rules,
    [
      { name: 'Bitbucket – Pull Requests', host: 'bitbucket.org', path: /\/pull-requests\//i, color: 'green', priority: 990 },
      { name: 'Bitbucket – Issues', host: 'bitbucket.org', path: /\/issues\//i, color: 'orange', priority: 980 },
      { name: 'Bitbucket – Pipelines', host: 'bitbucket.org', path: /\/pipelines\//i, color: 'cyan', priority: 970 }
    ]
  );

  pushSimpleRules(
    rules,
    [
      { name: 'Azure DevOps – Repos', host: 'dev.azure.com', path: /\/[^/]+\/[^/]+\/(?:_git|_build)/i, color: 'blue', priority: 960 },
      { name: 'Azure DevOps – Boards', host: 'dev.azure.com', path: /\/board/i, color: 'yellow', priority: 950 },
      { name: 'Azure DevOps – Pipelines', host: 'dev.azure.com', path: /\/pipeline/i, color: 'cyan', priority: 940 },
      { name: 'Azure DevOps – Artifacts', host: 'dev.azure.com', path: /\/artifacts/i, color: 'purple', priority: 930 }
    ]
  );

  const STACK_SITES = [
    'stackoverflow.com',
    'serverfault.com',
    'superuser.com',
    'askubuntu.com',
    'mathoverflow.net',
    'stackapps.com',
    'gaming.stackexchange.com',
    'math.stackexchange.com',
    'stats.stackexchange.com',
    'unix.stackexchange.com',
    'security.stackexchange.com',
    'tex.stackexchange.com',
    'travel.stackexchange.com',
    'physics.stackexchange.com',
    'dba.stackexchange.com',
    'electronics.stackexchange.com',
    'softwareengineering.stackexchange.com',
    'codereview.stackexchange.com',
    'webmasters.stackexchange.com',
    'stackprinter.appspot.com'
  ];
  pushSimpleRules(
    rules,
    STACK_SITES.map((host) => ({
      name: `Stack Exchange – ${host.replace('.stackexchange.com', '').replace('.com', '')}`,
      host,
      color: 'green',
      priority: 920
    })),
    { priority: 920 }
  );

  // Developer documentation and registries.
  pushSimpleRules(rules, [
    { name: 'MDN Web Docs', host: 'developer.mozilla.org', color: 'blue', priority: 900 },
    { name: 'npm Registry', host: 'www.npmjs.com', path: /\/package\//i, color: 'orange', priority: 890 },
    { name: 'PyPI', host: 'pypi.org', path: /\/project\//i, color: 'orange', priority: 890 },
    { name: 'RubyGems', host: 'rubygems.org', path: /\/gems\//i, color: 'red', priority: 880 },
    { name: 'pkg.go.dev', host: 'pkg.go.dev', color: 'blue', priority: 880 },
    { name: 'crates.io', host: 'crates.io', path: /\/crates\//i, color: 'orange', priority: 880 },
    { name: 'Docker Hub', host: 'hub.docker.com', path: /\/(?:r|_\/)\//i, color: 'cyan', priority: 870 },
    { name: 'Packagist', host: 'packagist.org', path: /\/packages\//i, color: 'orange', priority: 860 },
    { name: 'Maven Central', host: 'search.maven.org', color: 'orange', priority: 850 },
    { name: 'NuGet', host: 'www.nuget.org', path: /\/packages\//i, color: 'purple', priority: 850 },
    { name: 'Homebrew Formulae', host: 'formulae.brew.sh', color: 'green', priority: 830 },
    { name: 'Helm Hub', host: 'artifacthub.io', path: /\/packages\//i, color: 'cyan', priority: 830 },
    { name: 'Terraform Registry', host: 'registry.terraform.io', path: /\/providers\//i, color: 'green', priority: 820 },
    { name: 'Ansible Galaxy', host: 'galaxy.ansible.com', color: 'yellow', priority: 820 },
    { name: 'Conda Forge', host: 'anaconda.org', color: 'green', priority: 810 },
    { name: 'Kubernetes Docs', host: 'kubernetes.io', path: /\/docs\//i, color: 'cyan', priority: 810 },
    { name: 'Helm Docs', host: 'helm.sh', path: /\/docs\//i, color: 'cyan', priority: 800 },
    { name: 'Terraform Docs', host: 'developer.hashicorp.com', path: /\/terraform\//i, color: 'green', priority: 800 },
    { name: 'Ansible Docs', host: 'docs.ansible.com', color: 'yellow', priority: 790 },
    { name: 'Prometheus Docs', host: 'prometheus.io', path: /\/docs\//i, color: 'orange', priority: 790 },
    { name: 'Grafana Docs', host: 'grafana.com', path: /\/docs\//i, color: 'purple', priority: 780 },
    { name: 'Sentry Docs', host: 'docs.sentry.io', color: 'purple', priority: 780 },
    { name: 'New Relic Docs', host: 'docs.newrelic.com', color: 'green', priority: 780 }
  ]);

  pushSimpleRules(rules, [
    { name: 'Python Docs', host: 'docs.python.org', color: 'blue', priority: 790 },
    { name: 'Node.js Docs', host: 'nodejs.org', path: /\/docs\//i, color: 'green', priority: 790 },
    { name: 'React Docs', host: 'react.dev', color: 'cyan', priority: 780 },
    { name: 'Next.js Docs', host: 'nextjs.org', path: /\/docs\//i, color: 'cyan', priority: 780 },
    { name: 'Angular Docs', host: 'angular.io', path: /\/docs\//i, color: 'red', priority: 780 },
    { name: 'Vue Docs', host: 'vuejs.org', path: /\/guide/i, color: 'green', priority: 770 },
    { name: 'Svelte Docs', host: 'svelte.dev', path: /\/docs\//i, color: 'orange', priority: 770 },
    { name: 'Django Docs', host: 'docs.djangoproject.com', color: 'green', priority: 760 },
    { name: 'Flask Docs', host: 'flask.palletsprojects.com', color: 'orange', priority: 760 },
    { name: 'Rails Guides', host: 'guides.rubyonrails.org', color: 'red', priority: 750 },
    { name: 'Spring Docs', host: 'docs.spring.io', color: 'green', priority: 750 },
    { name: 'Java Docs', host: 'docs.oracle.com', path: /\/javase/i, color: 'blue', priority: 740 },
    { name: 'Kotlin Docs', host: 'kotlinlang.org', path: /\/docs\//i, color: 'purple', priority: 740 },
    { name: 'Scala Docs', host: 'docs.scala-lang.org', color: 'red', priority: 730 },
    { name: 'Rust Docs', host: 'doc.rust-lang.org', color: 'orange', priority: 730 },
    { name: 'Go Docs', host: 'go.dev', path: /\/doc\//i, color: 'blue', priority: 720 },
    { name: 'C++ Reference', host: 'en.cppreference.com', color: 'grey', priority: 720 },
    { name: 'Microsoft Learn', host: 'learn.microsoft.com', color: 'blue', priority: 710 },
    { name: 'AWS Docs', host: 'docs.aws.amazon.com', color: 'orange', priority: 710 },
    { name: 'Google Cloud Docs', host: 'cloud.google.com', path: /\/docs\//i, color: 'blue', priority: 700 },
    { name: 'Azure Docs', host: 'learn.microsoft.com', path: /azure/i, color: 'blue', priority: 700 },
    { name: 'Oracle Cloud Docs', host: 'docs.oracle.com', path: /\/en\/cloud\//i, color: 'orange', priority: 700 },
    { name: 'IBM Cloud Docs', host: 'cloud.ibm.com', path: /\/docs\//i, color: 'blue', priority: 690 },
    { name: 'Salesforce Docs', host: 'developer.salesforce.com', path: /\/docs\//i, color: 'blue', priority: 690 },
    { name: 'Elastic Docs', host: 'www.elastic.co', path: /\/guide\//i, color: 'orange', priority: 680 },
    { name: 'MongoDB Docs', host: 'www.mongodb.com', path: /\/docs\//i, color: 'green', priority: 670 },
    { name: 'PostgreSQL Docs', host: 'www.postgresql.org', path: /\/docs\//i, color: 'blue', priority: 670 },
    { name: 'MySQL Docs', host: 'dev.mysql.com', path: /\/doc\//i, color: 'blue', priority: 660 },
    { name: 'Redis Docs', host: 'redis.io', path: /\/docs\//i, color: 'red', priority: 660 },
    { name: 'Kafka Docs', host: 'kafka.apache.org', path: /\/documentation/i, color: 'orange', priority: 650 },
    { name: 'Spark Docs', host: 'spark.apache.org', path: /\/docs\//i, color: 'orange', priority: 650 },
    { name: 'Hadoop Docs', host: 'hadoop.apache.org', path: /\/docs\//i, color: 'yellow', priority: 640 },
    { name: 'Prometheus Docs (Alt)', host: 'prometheus.io', path: /\/docs\/prometheus\//i, color: 'orange', priority: 630 },
    { name: 'Grafana Cloud Docs', host: 'grafana.com', path: /\/docs\/grafana-cloud/i, color: 'purple', priority: 630 }
  ]);

  // Work and project management.
  rules.push(
    {
      name: 'Jira – Issues',
      color: 'orange',
      priority: 880,
      match: { hostRegex: /atlassian\.net$/i, pathRegex: /\/browse\//i },
      deriveName: (tabInfo) => {
        const key = extractJiraKey(tabInfo);
        return key ? { name: `Jira – ${key}`, color: 'orange' } : { name: 'Jira – Issues', color: 'orange' };
      }
    },
    {
      name: 'Jira – Boards',
      color: 'blue',
      priority: 870,
      match: { hostRegex: /atlassian\.net$/i, pathRegex: /\/jira\/software/i },
      deriveName: () => ({ name: 'Jira – Boards', color: 'blue' })
    },
    {
      name: 'Jira – Roadmaps',
      color: 'cyan',
      priority: 860,
      match: { hostRegex: /atlassian\.net$/i, pathRegex: /\/jira\/core/i },
      deriveName: () => ({ name: 'Jira – Roadmaps', color: 'cyan' })
    },
    {
      name: 'Linear Issues',
      color: 'green',
      priority: 850,
      match: { hostRegex: hostPattern('linear.app'), pathRegex: /\/issue\//i },
      deriveName: (tabInfo) => {
        const match = /([A-Z]+-\d+)/.exec(tabInfo.path);
        return match ? { name: `Linear – ${match[1]}`, color: 'green' } : { name: 'Linear – Issues', color: 'green' };
      }
    },
    {
      name: 'Linear Views',
      color: 'cyan',
      priority: 840,
      match: { hostRegex: hostPattern('linear.app') },
      deriveName: () => ({ name: 'Linear – Workspace', color: 'cyan' })
    },
    {
      name: 'YouTrack Issues',
      color: 'orange',
      priority: 830,
      match: { hostRegex: /(youtrack\.cloud|myjetbrains\.com)$/i, pathRegex: /\/issue\//i },
      deriveName: (tabInfo) => {
        const match = /([A-Z0-9_]+-\d+)/i.exec(tabInfo.path);
        return match ? { name: `YouTrack – ${match[1].toUpperCase()}`, color: 'orange' } : { name: 'YouTrack – Issues', color: 'orange' };
      }
    }
  );

  pushSimpleRules(rules, [
    { name: 'Asana', host: 'app.asana.com', color: 'purple', priority: 820 },
    { name: 'Trello Boards', host: 'trello.com', path: /\/b\//i, color: 'green', priority: 820 },
    { name: 'Notion Workspace', host: 'notion.so', color: 'grey', priority: 810 },
    { name: 'ClickUp', host: 'app.clickup.com', color: 'cyan', priority: 810 },
    { name: 'Monday.com', host: 'monday.com', color: 'yellow', priority: 800 },
    { name: 'Basecamp', host: '3.basecamp.com', color: 'pink', priority: 800 },
    { name: 'Confluence', host: 'atlassian.net', path: /\/wiki\//i, color: 'blue', priority: 800 },
    { name: 'Airtable Bases', host: 'airtable.com', path: /\/app[a-z0-9]+/i, color: 'cyan', priority: 790 },
    { name: 'Coda Docs', host: 'coda.io', path: /\/docs\//i, color: 'blue', priority: 790 },
    { name: 'Quip Docs', host: 'quip.com', path: /\/doc\//i, color: 'blue', priority: 780 },
    { name: 'Miro Boards', host: 'miro.com', path: /\/app\//i, color: 'yellow', priority: 780 },
    { name: 'Figma Files', host: 'figma.com', path: /\/file\//i, color: 'purple', priority: 770 },
    { name: 'Lucidchart', host: 'lucid.app', path: /\/lucidchart\//i, color: 'orange', priority: 770 },
    { name: 'Smartsheet', host: 'app.smartsheet.com', color: 'green', priority: 760 }
  ]);

  // Docs and file storage.
  rules.push(
    {
      name: 'Google Docs',
      color: 'blue',
      priority: 780,
      match: { hostRegex: hostPattern('docs.google.com'), pathRegex: /\/document\//i },
      deriveName: () => ({ name: 'Google Docs', color: 'blue' })
    },
    {
      name: 'Google Sheets',
      color: 'green',
      priority: 780,
      match: { hostRegex: hostPattern('docs.google.com'), pathRegex: /\/(spreadsheets|sheet)\//i },
      deriveName: () => ({ name: 'Google Sheets', color: 'green' })
    },
    {
      name: 'Google Slides',
      color: 'yellow',
      priority: 780,
      match: { hostRegex: hostPattern('docs.google.com'), pathRegex: /\/presentation\//i },
      deriveName: () => ({ name: 'Google Slides', color: 'yellow' })
    },
    {
      name: 'Google Drive Folders',
      color: 'blue',
      priority: 770,
      match: { hostRegex: hostPattern('drive.google.com'), pathRegex: /\/drive\/folders/i },
      deriveName: () => ({ name: 'Google Drive – Folder', color: 'blue' })
    },
    {
      name: 'Google Drive Files',
      color: 'blue',
      priority: 770,
      match: { hostRegex: hostPattern('drive.google.com'), pathRegex: /\/file\/d\//i },
      deriveName: () => ({ name: 'Google Drive – File', color: 'blue' })
    }
  );

  pushSimpleRules(rules, [
    { name: 'Office 365 – Word', host: 'office.com', path: /\/word/i, color: 'blue', priority: 760 },
    { name: 'Office 365 – Excel', host: 'office.com', path: /\/excel/i, color: 'green', priority: 760 },
    { name: 'Office 365 – PowerPoint', host: 'office.com', path: /\/powerpoint/i, color: 'orange', priority: 760 },
    { name: 'SharePoint', host: 'sharepoint.com', color: 'blue', priority: 750 },
    { name: 'Dropbox Files', host: 'dropbox.com', path: /\/home/i, color: 'blue', priority: 750 },
    { name: 'Box Files', host: 'box.com', path: /\/file/i, color: 'blue', priority: 740 },
    { name: 'OneDrive', host: 'onedrive.live.com', color: 'blue', priority: 740 },
    { name: 'Evernote', host: 'evernote.com', color: 'green', priority: 730 },
    { name: 'Google Keep', host: 'keep.google.com', color: 'yellow', priority: 730 },
    { name: 'Notability', host: 'notability.com', color: 'purple', priority: 720 },
    { name: 'Simplenote', host: 'app.simplenote.com', color: 'blue', priority: 720 }
  ]);

  // Cloud consoles.
  pushSimpleRules(rules, [
    { name: 'AWS Console – EC2', host: 'console.aws.amazon.com', path: /ec2/i, color: 'orange', priority: 720 },
    { name: 'AWS Console – S3', host: 's3.console.aws.amazon.com', color: 'orange', priority: 720 },
    { name: 'AWS Console – IAM', host: 'console.aws.amazon.com', path: /iam/i, color: 'orange', priority: 720 },
    { name: 'AWS Console – CloudWatch', host: 'console.aws.amazon.com', path: /cloudwatch/i, color: 'orange', priority: 710 },
    { name: 'AWS Console – Lambda', host: 'console.aws.amazon.com', path: /lambda/i, color: 'orange', priority: 710 },
    { name: 'AWS Console – RDS', host: 'console.aws.amazon.com', path: /rds/i, color: 'orange', priority: 710 },
    { name: 'GCP Console', host: 'console.cloud.google.com', color: 'blue', priority: 720 },
    { name: 'GCP Cloud Run', host: 'console.cloud.google.com', path: /run/i, color: 'blue', priority: 710 },
    { name: 'GCP BigQuery', host: 'console.cloud.google.com', path: /bigquery/i, color: 'blue', priority: 710 },
    { name: 'Azure Portal', host: 'portal.azure.com', color: 'blue', priority: 720 },
    { name: 'Cloudflare Dashboard', host: 'dash.cloudflare.com', color: 'orange', priority: 700 },
    { name: 'Vercel Dashboard', host: 'vercel.com', path: /\/dashboard/i, color: 'grey', priority: 700 },
    { name: 'Netlify Dashboard', host: 'app.netlify.com', color: 'green', priority: 700 },
    { name: 'Render Dashboard', host: 'dashboard.render.com', color: 'purple', priority: 700 },
    { name: 'Fly.io Apps', host: 'fly.io', path: /\/apps/i, color: 'cyan', priority: 690 },
    { name: 'Firebase Console', host: 'console.firebase.google.com', color: 'yellow', priority: 700 },
    { name: 'Supabase Dashboard', host: 'app.supabase.com', color: 'green', priority: 690 },
    { name: 'Heroku Dashboard', host: 'dashboard.heroku.com', color: 'purple', priority: 690 },
    { name: 'Railway Dashboard', host: 'railway.app', path: /\/dashboard/i, color: 'purple', priority: 680 },
    { name: 'PlanetScale', host: 'app.planetscale.com', color: 'blue', priority: 680 },
    { name: 'Snowflake Console', host: 'app.snowflake.com', color: 'blue', priority: 680 },
    { name: 'DigitalOcean Control Panel', host: 'cloud.digitalocean.com', color: 'blue', priority: 680 }
  ]);

  // Observability, CI/CD, and on-call.
  pushSimpleRules(rules, [
    { name: 'Datadog', host: 'app.datadoghq.com', color: 'purple', priority: 670 },
    { name: 'Grafana', host: 'grafana.com', path: /\/a\/grafana\//i, color: 'purple', priority: 670 },
    { name: 'Kibana', host: 'kibana', color: 'orange', priority: 660 },
    { name: 'Elastic Cloud', host: 'cloud.elastic.co', color: 'orange', priority: 660 },
    { name: 'Sentry', host: 'sentry.io', color: 'purple', priority: 660 },
    { name: 'New Relic', host: 'one.newrelic.com', color: 'green', priority: 660 },
    { name: 'PagerDuty', host: 'pagerduty.com', color: 'red', priority: 650 },
    { name: 'Opsgenie', host: 'app.opsgenie.com', color: 'red', priority: 650 },
    { name: 'Honeycomb', host: 'ui.honeycomb.io', color: 'orange', priority: 640 },
    { name: 'Chronosphere', host: 'app.chronosphere.io', color: 'purple', priority: 640 },
    { name: 'Statuspage', host: 'statuspage.io', color: 'yellow', priority: 640 },
    { name: 'CircleCI', host: 'circleci.com', color: 'green', priority: 640 },
    { name: 'Jenkins', host: 'jenkins', color: 'green', priority: 640 },
    { name: 'GitHub Actions Jobs', host: 'github.com', path: /\/actions\//i, color: 'cyan', priority: 640 },
    { name: 'GitLab CI Pipelines', host: 'gitlab.com', path: /\/pipelines\//i, color: 'cyan', priority: 640 },
    { name: 'Buildkite', host: 'buildkite.com', color: 'green', priority: 640 },
    { name: 'Harness', host: 'app.harness.io', color: 'green', priority: 630 },
    { name: 'Argo CD', host: 'argocd', color: 'cyan', priority: 630 },
    { name: 'Prometheus Console', host: 'prometheus', color: 'orange', priority: 630 }
  ]);

  // Communication tools.
  rules.push(
    {
      name: 'Slack',
      color: 'green',
      priority: 760,
      match: { hostRegex: /slack\.com$/i },
      deriveName: (tabInfo) => {
        const derived = deriveSlackName(tabInfo);
        return derived ? { ...derived, color: 'green' } : { name: 'Slack – Workspace', color: 'green' };
      }
    },
    {
      name: 'Gmail',
      color: 'red',
      priority: 760,
      match: { hostRegex: hostPattern('mail.google.com') },
      deriveName: () => ({ name: 'Gmail', color: 'red' })
    },
    {
      name: 'Google Calendar',
      color: 'yellow',
      priority: 750,
      match: { hostRegex: hostPattern('calendar.google.com') },
      deriveName: () => ({ name: 'Google Calendar', color: 'yellow' })
    },
    {
      name: 'Google Meet',
      color: 'purple',
      priority: 740,
      match: { hostRegex: hostPattern('meet.google.com') },
      deriveName: () => ({ name: 'Google Meet', color: 'purple' })
    },
    {
      name: 'Zoom Meeting',
      color: 'purple',
      priority: 740,
      match: { hostRegex: hostPattern('zoom.us'), pathRegex: /\/j\//i },
      deriveName: () => ({ name: 'Zoom Meeting', color: 'purple' })
    },
    {
      name: 'Microsoft Teams',
      color: 'blue',
      priority: 740,
      match: { hostRegex: hostPattern('teams.microsoft.com') },
      deriveName: () => ({ name: 'Microsoft Teams', color: 'blue' })
    }
  );

  pushSimpleRules(rules, [
    { name: 'Outlook Mail', host: 'outlook.office.com', color: 'blue', priority: 730 },
    { name: 'Outlook Calendar', host: 'outlook.office.com', path: /calendar/i, color: 'yellow', priority: 730 },
    { name: 'Google Chat', host: 'chat.google.com', color: 'green', priority: 720 },
    { name: 'Discord', host: 'discord.com', path: /\/channels\//i, color: 'purple', priority: 720 },
    { name: 'WhatsApp Web', host: 'web.whatsapp.com', color: 'green', priority: 720 },
    { name: 'Telegram Web', host: 'web.telegram.org', color: 'blue', priority: 710 },
    { name: 'Signal Web', host: 'signal.org', path: /\/web/i, color: 'blue', priority: 700 },
    { name: 'Zoom Dashboard', host: 'zoom.us', path: /\/account/i, color: 'purple', priority: 710 },
    { name: 'Webex', host: 'webex.com', color: 'blue', priority: 700 },
    { name: 'Calendly', host: 'calendly.com', color: 'yellow', priority: 700 }
  ]);

  // Research and learning.
  pushSimpleRules(rules, [
    { name: 'Google Scholar', host: 'scholar.google.com', color: 'green', priority: 700 },
    { name: 'arXiv', host: 'arxiv.org', color: 'grey', priority: 700 },
    { name: 'Papers with Code', host: 'paperswithcode.com', color: 'blue', priority: 700 },
    { name: 'Semantic Scholar', host: 'semanticscholar.org', color: 'blue', priority: 690 },
    { name: 'ResearchGate', host: 'researchgate.net', color: 'green', priority: 690 },
    { name: 'IEEE Xplore', host: 'ieeexplore.ieee.org', color: 'blue', priority: 680 },
    { name: 'ACM Digital Library', host: 'dl.acm.org', color: 'blue', priority: 680 },
    { name: 'Springer Link', host: 'link.springer.com', color: 'purple', priority: 680 },
    { name: 'ScienceDirect', host: 'sciencedirect.com', color: 'orange', priority: 680 },
    { name: 'Coursera', host: 'coursera.org', color: 'blue', priority: 670 },
    { name: 'Udemy', host: 'udemy.com', color: 'purple', priority: 670 },
    { name: 'edX', host: 'edx.org', color: 'blue', priority: 670 },
    { name: 'Khan Academy', host: 'khanacademy.org', color: 'green', priority: 660 },
    { name: 'Brilliant', host: 'brilliant.org', color: 'yellow', priority: 660 },
    { name: 'Pluralsight', host: 'pluralsight.com', color: 'red', priority: 660 },
    { name: 'Codecademy', host: 'codecademy.com', color: 'green', priority: 650 },
    { name: 'FreeCodeCamp', host: 'freecodecamp.org', color: 'green', priority: 650 },
    { name: 'LeetCode', host: 'leetcode.com', color: 'orange', priority: 650 },
    { name: 'HackerRank', host: 'hackerrank.com', color: 'green', priority: 640 },
    { name: 'Brilliant Courses', host: 'brilliant.org', path: /\/courses\//i, color: 'yellow', priority: 640 }
  ]);

  // News and media outlets.
  pushSimpleRules(rules, [
    { name: 'BBC News', host: 'bbc.co.uk', color: 'purple', priority: 620 },
    { name: 'The Guardian', host: 'theguardian.com', color: 'purple', priority: 620 },
    { name: 'New York Times', host: 'nytimes.com', color: 'purple', priority: 620 },
    { name: 'Washington Post', host: 'washingtonpost.com', color: 'purple', priority: 620 },
    { name: 'Wall Street Journal', host: 'wsj.com', color: 'purple', priority: 620 },
    { name: 'Financial Times', host: 'ft.com', color: 'purple', priority: 620 },
    { name: 'Bloomberg', host: 'bloomberg.com', color: 'purple', priority: 620 },
    { name: 'Reuters', host: 'reuters.com', color: 'purple', priority: 620 },
    { name: 'CNBC', host: 'cnbc.com', color: 'purple', priority: 610 },
    { name: 'CNN', host: 'cnn.com', color: 'purple', priority: 610 },
    { name: 'Fox News', host: 'foxnews.com', color: 'purple', priority: 610 },
    { name: 'The Verge', host: 'theverge.com', color: 'purple', priority: 610 },
    { name: 'TechCrunch', host: 'techcrunch.com', color: 'purple', priority: 610 },
    { name: 'Ars Technica', host: 'arstechnica.com', color: 'purple', priority: 610 },
    { name: 'Wired', host: 'wired.com', color: 'purple', priority: 610 },
    { name: 'Engadget', host: 'engadget.com', color: 'purple', priority: 610 },
    { name: 'VentureBeat', host: 'venturebeat.com', color: 'purple', priority: 600 },
    { name: 'Slashdot', host: 'slashdot.org', color: 'purple', priority: 600 },
    { name: 'ZDNet', host: 'zdnet.com', color: 'purple', priority: 600 },
    { name: 'InfoWorld', host: 'infoworld.com', color: 'purple', priority: 600 },
    { name: 'Hacker News', host: 'news.ycombinator.com', color: 'orange', priority: 600 },
    { name: 'Product Hunt', host: 'producthunt.com', color: 'orange', priority: 590 },
    { name: 'Lobsters', host: 'lobste.rs', color: 'orange', priority: 590 },
    { name: 'Dev.to', host: 'dev.to', color: 'green', priority: 590 },
    { name: 'Medium', host: 'medium.com', color: 'green', priority: 590 },
    { name: 'Substack', host: 'substack.com', color: 'orange', priority: 590 },
    { name: 'Smashing Magazine', host: 'smashingmagazine.com', color: 'purple', priority: 590 },
    { name: 'StackShare', host: 'stackshare.io', color: 'blue', priority: 590 },
    { name: 'The Information', host: 'theinformation.com', color: 'purple', priority: 590 }
  ]);

  // Social platforms.
  rules.push(
    {
      name: 'LinkedIn',
      color: 'blue',
      priority: 620,
      match: { hostRegex: hostPattern('linkedin.com') },
      deriveName: (tabInfo) => ({ name: `LinkedIn – ${deriveLinkedInSuffix(tabInfo)}`, color: 'blue' })
    },
    {
      name: 'Twitter / X',
      color: 'blue',
      priority: 620,
      match: { hostRegex: /(twitter.com|x.com)$/i },
      deriveName: () => ({ name: 'Twitter / X', color: 'blue' })
    },
    {
      name: 'Facebook',
      color: 'blue',
      priority: 610,
      match: { hostRegex: hostPattern('facebook.com') },
      deriveName: () => ({ name: 'Facebook', color: 'blue' })
    },
    {
      name: 'Instagram',
      color: 'pink',
      priority: 610,
      match: { hostRegex: hostPattern('instagram.com') },
      deriveName: () => ({ name: 'Instagram', color: 'pink' })
    },
    {
      name: 'TikTok',
      color: 'pink',
      priority: 610,
      match: { hostRegex: hostPattern('tiktok.com') },
      deriveName: () => ({ name: 'TikTok', color: 'pink' })
    },
    {
      name: 'Reddit – Subreddit',
      color: 'orange',
      priority: 610,
      match: { hostRegex: hostPattern('reddit.com'), pathRegex: /\/r\/[^/]+/i },
      deriveName: (tabInfo) => {
        const subreddit = extractSubreddit(tabInfo);
        return subreddit ? { name: `Reddit – r/${subreddit}`, color: 'orange' } : { name: 'Reddit', color: 'orange' };
      }
    }
  );

  pushSimpleRules(rules, [
    { name: 'Mastodon', host: 'mastodon.', color: 'purple', priority: 600 },
    { name: 'Bluesky', host: 'bsky.app', color: 'blue', priority: 600 },
    { name: 'Threads', host: 'threads.net', color: 'pink', priority: 600 },
    { name: 'Pinterest', host: 'pinterest.com', color: 'red', priority: 590 },
    { name: 'Snapchat Web', host: 'web.snapchat.com', color: 'yellow', priority: 590 },
    { name: 'Quora', host: 'quora.com', color: 'red', priority: 590 }
  ]);

  // Maps and travel.
  rules.push(
    {
      name: 'Google Maps – Directions',
      color: 'green',
      priority: 600,
      match: { hostRegex: hostPattern('google.com'), pathRegex: /\/maps\/dir/i },
      deriveName: () => ({ name: 'Google Maps – Directions', color: 'green' })
    },
    {
      name: 'Google Maps – Places',
      color: 'green',
      priority: 600,
      match: { hostRegex: hostPattern('google.com'), pathRegex: /\/maps\/place/i },
      deriveName: () => ({ name: 'Google Maps – Places', color: 'green' })
    }
  );

  pushSimpleRules(rules, [
    { name: 'Google Travel', host: 'google.com', path: /\/travel/i, color: 'green', priority: 600 },
    { name: 'Booking.com', host: 'booking.com', color: 'blue', priority: 590 },
    { name: 'Airbnb Stays', host: 'airbnb.com', path: /\/rooms\//i, color: 'pink', priority: 590 },
    { name: 'Expedia', host: 'expedia.com', color: 'blue', priority: 590 },
    { name: 'Skyscanner', host: 'skyscanner.net', color: 'blue', priority: 590 },
    { name: 'Kayak', host: 'kayak.com', color: 'orange', priority: 580 },
    { name: 'Delta Airlines', host: 'delta.com', color: 'blue', priority: 580 },
    { name: 'United Airlines', host: 'united.com', color: 'blue', priority: 580 },
    { name: 'American Airlines', host: 'aa.com', color: 'blue', priority: 580 },
    { name: 'Southwest Airlines', host: 'southwest.com', color: 'blue', priority: 580 },
    { name: 'Lufthansa', host: 'lufthansa.com', color: 'blue', priority: 580 },
    { name: 'British Airways', host: 'britishairways.com', color: 'blue', priority: 580 },
    { name: 'Air France', host: 'airfrance.com', color: 'blue', priority: 580 },
    { name: 'easyJet', host: 'easyjet.com', color: 'orange', priority: 580 },
    { name: 'Ryanair', host: 'ryanair.com', color: 'blue', priority: 580 },
    { name: 'SeatGuru', host: 'seatguru.com', color: 'orange', priority: 570 },
    { name: 'Trainline', host: 'thetrainline.com', color: 'green', priority: 570 },
    { name: 'Uber Trips', host: 'riders.uber.com', color: 'grey', priority: 570 },
    { name: 'Lyft Rides', host: 'ride.lyft.com', color: 'pink', priority: 570 }
  ]);

  // Shopping.
  rules.push(
    {
      name: 'Amazon – Product',
      color: 'orange',
      priority: 580,
      match: { hostRegex: /amazon\./i, pathRegex: /\/dp\//i },
      deriveName: () => ({ name: 'Amazon – Product', color: 'orange' })
    },
    {
      name: 'Amazon – Search',
      color: 'orange',
      priority: 580,
      match: { hostRegex: /amazon\./i, pathRegex: /^\/s/i },
      deriveName: () => ({ name: 'Amazon – Search', color: 'orange' })
    },
    {
      name: 'Amazon – Cart',
      color: 'orange',
      priority: 580,
      match: { hostRegex: /amazon\./i, pathRegex: /\/gp\/cart/i },
      deriveName: () => ({ name: 'Amazon – Cart', color: 'orange' })
    }
  );

  pushSimpleRules(rules, [
    { name: 'eBay – Listings', host: 'ebay.com', path: /\/itm\//i, color: 'yellow', priority: 570 },
    { name: 'AliExpress', host: 'aliexpress.com', color: 'red', priority: 570 },
    { name: 'Etsy', host: 'etsy.com', color: 'orange', priority: 570 },
    { name: 'Walmart', host: 'walmart.com', color: 'blue', priority: 560 },
    { name: 'Target', host: 'target.com', color: 'red', priority: 560 },
    { name: 'Best Buy', host: 'bestbuy.com', color: 'blue', priority: 560 },
    { name: 'Costco', host: 'costco.com', color: 'blue', priority: 560 },
    { name: 'Newegg', host: 'newegg.com', color: 'yellow', priority: 560 },
    { name: 'Home Depot', host: 'homedepot.com', color: 'orange', priority: 560 },
    { name: "Lowe's", host: 'lowes.com', color: 'blue', priority: 560 },
    { name: 'Shopify Admin', host: 'myshopify.com', color: 'green', priority: 550 },
    { name: 'Stripe Checkout', host: 'checkout.stripe.com', color: 'purple', priority: 550 }
  ]);

  // Finance and banking.
  pushSimpleRules(rules, [
    { name: 'PayPal', host: 'paypal.com', color: 'blue', priority: 560 },
    { name: 'Stripe Dashboard', host: 'dashboard.stripe.com', color: 'purple', priority: 560 },
    { name: 'Wise', host: 'wise.com', color: 'green', priority: 560 },
    { name: 'Revolut', host: 'revolut.com', color: 'blue', priority: 560 },
    { name: 'Coinbase', host: 'coinbase.com', color: 'blue', priority: 550 },
    { name: 'Binance', host: 'binance.com', color: 'yellow', priority: 550 },
    { name: 'Kraken', host: 'kraken.com', color: 'blue', priority: 550 },
    { name: 'Robinhood', host: 'robinhood.com', color: 'green', priority: 550 },
    { name: 'E*TRADE', host: 'etrade.com', color: 'purple', priority: 550 },
    { name: 'Vanguard', host: 'investor.vanguard.com', color: 'red', priority: 540 },
    { name: 'Fidelity', host: 'fidelity.com', color: 'green', priority: 540 },
    { name: 'Charles Schwab', host: 'schwab.com', color: 'blue', priority: 540 },
    { name: 'Chase Bank', host: 'chase.com', color: 'blue', priority: 540 },
    { name: 'Bank of America', host: 'bankofamerica.com', color: 'red', priority: 540 },
    { name: 'Wells Fargo', host: 'wellsfargo.com', color: 'red', priority: 540 },
    { name: 'Capital One', host: 'capitalone.com', color: 'blue', priority: 540 },
    { name: 'Mint', host: 'mint.intuit.com', color: 'green', priority: 530 },
    { name: 'QuickBooks', host: 'quickbooks.intuit.com', color: 'green', priority: 530 },
    { name: 'Xero', host: 'go.xero.com', color: 'blue', priority: 530 },
    { name: 'Plaid Dashboard', host: 'dashboard.plaid.com', color: 'blue', priority: 530 },
    { name: 'Yahoo Finance', host: 'finance.yahoo.com', color: 'purple', priority: 530 },
    { name: 'TradingView', host: 'tradingview.com', color: 'purple', priority: 530 }
  ]);

  // Music and entertainment.
  pushSimpleRules(rules, [
    { name: 'Spotify', host: 'open.spotify.com', color: 'green', priority: 520 },
    { name: 'Apple Music', host: 'music.apple.com', color: 'red', priority: 520 },
    { name: 'SoundCloud', host: 'soundcloud.com', color: 'orange', priority: 520 },
    { name: 'YouTube Music', host: 'music.youtube.com', color: 'red', priority: 520 },
    { name: 'Netflix', host: 'netflix.com', color: 'red', priority: 520 },
    { name: 'Prime Video', host: 'primevideo.com', color: 'blue', priority: 520 },
    { name: 'Disney+', host: 'disneyplus.com', color: 'blue', priority: 520 },
    { name: 'Hulu', host: 'hulu.com', color: 'green', priority: 520 },
    { name: 'Max', host: 'max.com', color: 'purple', priority: 520 },
    { name: 'Peacock', host: 'peacocktv.com', color: 'yellow', priority: 520 },
    { name: 'Paramount+', host: 'paramountplus.com', color: 'blue', priority: 520 },
    { name: 'Crunchyroll', host: 'crunchyroll.com', color: 'orange', priority: 520 },
    { name: 'Plex', host: 'plex.tv', color: 'orange', priority: 510 },
    { name: 'Letterboxd', host: 'letterboxd.com', color: 'green', priority: 510 },
    { name: 'IMDb', host: 'imdb.com', color: 'yellow', priority: 510 }
  ]);

  const EXTRA_DOCS = [
    'developer.android.com',
    'firebase.google.com/docs',
    'supabase.com/docs',
    'docs.expo.dev',
    'ionicframework.com/docs',
    'tailwindcss.com/docs',
    'storybook.js.org/docs',
    'jestjs.io/docs',
    'babeljs.io/docs',
    'webpack.js.org/concepts',
    'eslint.org/docs',
    'docs.cypress.io',
    'playwright.dev/docs',
    'vitejs.dev/guide',
    'astro.build/docs',
    'redwoodjs.com/docs',
    'remix.run/docs',
    'swr.vercel.app/docs',
    'tanstack.com/query/latest/docs',
    'graphql.org/learn',
    'apollographql.com/docs',
    'docs.nestjs.com',
    'fastapi.tiangolo.com',
    'flask-restful.readthedocs.io',
    'pytest.org/en/latest',
    'docs.sqlalchemy.org',
    'typeorm.io/#/docs',
    'sequelize.org/docs',
    'symfony.com/doc',
    'laravel.com/docs',
    'adonisjs.com/docs',
    'hasura.io/docs',
    'docs.aws.amazon.com/cdk',
    'docs.aws.amazon.com/cloudformation',
    'registry.terraform.io/providers/hashicorp/aws/latest/docs',
    'docs.pulumi.com',
    'developer.okta.com/docs',
    'auth0.com/docs',
    'stripe.com/docs',
    'docs.github.com/en/actions',
    'docs.gitlab.com/ee/ci',
    'developer.paypal.com/docs',
    'developer.adobe.com',
    'docs.mapbox.com',
    'leafletjs.com/reference',
    'threejs.org/docs',
    'd3js.org',
    'echarts.apache.org/en/option',
    'plotly.com/javascript',
    'docs.databricks.com',
    'docs.docker.com',
    'learn.hashicorp.com/terraform',
    'docs.microsoft.com/azure/devops',
    'docs.microsoft.com/powershell',
    'docs.python.org/3/library',
    'docs.rust-embedded.org',
    'developer.apple.com/documentation',
    'docs.oracle.com/javase',
    'docs.aws.amazon.com/cli',
    'docs.microsoft.com/dotnet',
    'dev.mysql.com/doc',
    'redis.io/docs/stack',
    'docs.mongodb.com/manual'
  ];
  pushSimpleRules(
    rules,
    EXTRA_DOCS.map((entry) => {
      const [host, ...pathParts] = entry.split('/');
      const path = pathParts.length
        ? new RegExp('/' + pathParts.join('/').split('#')[0].split('?')[0].split('/').map((segment) => escapeRegex(segment)).join('/'), 'i')
        : undefined;
      return {
        name: `Docs – ${host.replace(/^www\\./, '')}`,
        host,
        path: path,
        color: 'blue',
        priority: 500
      };
    }),
    { priority: 500, color: 'blue' }
  );

  if (DEBUG) {
    console.log('[tab_utils] Rules catalog size:', rules.length);
  }

  return rules;
}

/**
 * Compile rule definitions into ready-to-match structures.
 * @param {Array} catalog
 * @returns {Array}
 */
function compileRuleCatalog(catalog) {
  return catalog
    .map((rule, index) => compileSingleRule(rule, index))
    .filter(Boolean)
    .sort((a, b) => b.priority - a.priority || a.index - b.index);
}

/**
 * Compile a single rule definition.
 * @param {any} rule
 * @param {number} index
 */
function compileSingleRule(rule, index) {
  if (!rule || typeof rule !== 'object') return null;
  const name = typeof rule.name === 'string' ? rule.name : '';
  const priority = Number.isFinite(rule.priority) ? Number(rule.priority) : 0;
  const color = sanitizeGroupColor(rule.color) || undefined;
  const host = rule.match && rule.match.hostRegex ? rule.match.hostRegex : resolveHostRegex(rule.match && rule.match.host);
  const path = rule.match && rule.match.pathRegex ? rule.match.pathRegex : resolveRegex(rule.match && rule.match.path);
  const title = rule.match && rule.match.titleRegex ? rule.match.titleRegex : resolveRegex(rule.match && rule.match.title);
  if (!host && !path && !title) return null;
  return {
    index,
    name,
    color,
    priority,
    host,
    path,
    title,
    deriveName: typeof rule.deriveName === 'function' ? rule.deriveName : null
  };
}

/**
 * Compile user supplied rules into the standard format.
 * @param {Array} userRules
 */
function compileUserRules(userRules) {
  const compiled = [];
  let counter = 0;
  for (const rule of userRules || []) {
    const host = rule.host ? new RegExp(rule.host.pattern, rule.host.flags || 'i') : undefined;
    const path = rule.path ? new RegExp(rule.path.pattern, rule.path.flags || 'i') : undefined;
    const title = rule.title ? new RegExp(rule.title.pattern, rule.title.flags || 'i') : undefined;
    if (!host && !path && !title) continue;
    const name = truncateLabel(rule.name);
    compiled.push({
      index: counter++,
      name,
      color: sanitizeGroupColor(rule.color) || undefined,
      priority: Number.isFinite(rule.priority) ? Number(rule.priority) : 1500,
      host,
      path,
      title,
      deriveName: () => ({ name, key: `user:${name.toLowerCase()}` })
    });
  }
  return compiled;
}

const TOKEN_DICTIONARY = [
  {
    id: 'github_prs',
    label: 'GitHub – PRs',
    color: 'green',
    keywords: ['github', 'pull', 'pr', 'merge'],
    hostHints: ['github.com'],
    threshold: 3
  },
  {
    id: 'github_issues',
    label: 'GitHub – Issues',
    color: 'orange',
    keywords: ['github', 'issue', 'bug', 'ticket'],
    hostHints: ['github.com'],
    threshold: 3
  },
  {
    id: 'docs_google',
    label: 'Docs – Google',
    color: 'blue',
    keywords: ['google', 'doc', 'sheet', 'slide', 'drive'],
    hostHints: ['docs.google.com', 'drive.google.com'],
    threshold: 3
  },
  {
    id: 'docs_general',
    label: 'Docs – Reference',
    color: 'blue',
    keywords: ['docs', 'documentation', 'reference', 'guide', 'manual'],
    threshold: 4
  },
  {
    id: 'ci_cd',
    label: 'CI/CD',
    color: 'cyan',
    keywords: ['pipeline', 'build', 'deploy', 'ci', 'workflow', 'job'],
    threshold: 3
  },
  {
    id: 'observability',
    label: 'Observability',
    color: 'purple',
    keywords: ['metric', 'dashboard', 'alert', 'monitor', 'trace', 'log'],
    threshold: 3
  },
  {
    id: 'communication',
    label: 'Communication',
    color: 'green',
    keywords: ['inbox', 'mail', 'calendar', 'meeting', 'chat', 'message'],
    threshold: 4
  },
  {
    id: 'project_management',
    label: 'Project Management',
    color: 'cyan',
    keywords: ['task', 'project', 'board', 'kanban', 'sprint'],
    threshold: 3
  },
  {
    id: 'research',
    label: 'Research & Papers',
    color: 'purple',
    keywords: ['paper', 'scholar', 'arxiv', 'citation', 'abstract'],
    threshold: 3
  },
  {
    id: 'news',
    label: 'News – Tech',
    color: 'purple',
    keywords: ['news', 'article', 'tech', 'startup', 'review'],
    threshold: 3
  },
  {
    id: 'shopping',
    label: 'Shopping',
    color: 'orange',
    keywords: ['cart', 'product', 'buy', 'price', 'deal'],
    threshold: 3
  },
  {
    id: 'travel',
    label: 'Travel',
    color: 'blue',
    keywords: ['flight', 'hotel', 'booking', 'ticket', 'itinerary'],
    threshold: 3
  },
  {
    id: 'finance',
    label: 'Finance',
    color: 'green',
    keywords: ['bank', 'account', 'invoice', 'payment', 'portfolio', 'trade'],
    threshold: 3
  },
  {
    id: 'media',
    label: 'Media & Streaming',
    color: 'red',
    keywords: ['video', 'stream', 'music', 'playlist', 'episode'],
    threshold: 3
  },
  {
    id: 'social',
    label: 'Social & Community',
    color: 'pink',
    keywords: ['social', 'profile', 'comment', 'follow', 'thread'],
    threshold: 3
  }
];

function classifyWithTokens(tabInfo) {
  const frequency = tabInfo.tokenFrequency;
  if (!frequency || frequency.size === 0) return null;
  let best = null;
  for (const category of TOKEN_DICTIONARY) {
    let score = 0;
    for (const keyword of category.keywords) {
      score += frequency.get(keyword) || 0;
    }
    if (category.hostHints && category.hostHints.some((hint) => tabInfo.host.includes(hint))) {
      score += 2;
    }
    if (score >= (category.threshold || 3)) {
      if (!best || score > best.score) {
        best = { category, score };
      }
    }
  }
  if (!best) return null;
  return { name: best.category.label, color: best.category.color };
}

function matchCompiledRule(rules, tabInfo) {
  for (const rule of rules) {
    if (rule.host && !rule.host.test(tabInfo.host)) continue;
    if (rule.title && !rule.title.test(tabInfo.title)) continue;
    if (rule.path && !rule.path.test(tabInfo.path)) continue;
    const derived = rule.deriveName ? rule.deriveName(tabInfo) : null;
    const baseName = derived && derived.name ? truncateLabel(derived.name) : truncateLabel(rule.name);
    const color = derived && derived.color ? sanitizeGroupColor(derived.color) || rule.color : rule.color;
    const key = derived && derived.key ? derived.key : null;
    return { name: baseName, color, key, ruleName: rule.name };
  }
  return null;
}

export function groupByRules(tabs, options = {}) {
  let opts = options;
  let userRulesInput = [];
  if (Array.isArray(options)) {
    userRulesInput = options;
    opts = {};
  } else if (Array.isArray(options.userRules)) {
    userRulesInput = options.userRules;
  }

  const preservePinned = opts.preservePinned !== false;
  const limitVal = Number(opts.maxTabsPerGroup);
  const maxTabsPerGroup = Number.isFinite(limitVal) && limitVal >= 2 ? Math.floor(limitVal) : 0;

  const compiledRules = [...compileUserRules(userRulesInput), ...COMPILED_RULES];
  const snapshots = ensureSnapshots(tabs).slice().sort((a, b) => a.index - b.index);
  const groups = new Map();
  const colorMap = new Map();
  const counters = new Map();
  const diagnostics = new Map();
  const unmatchedInfos = [];

  for (const tab of snapshots) {
    if (preservePinned && tab.pinned) {
      diagnostics.set(tab.id, { group: null, reason: 'pinned' });
      continue;
    }
    const info = prepareTabForClassification(tab);
    const match = matchCompiledRule(compiledRules, info);
    if (match) {
      const groupName = assignTabToGroupMap(groups, colorMap, counters, match.name, match.color, tab.id, maxTabsPerGroup);
      diagnostics.set(tab.id, { group: groupName, reason: 'rule', rule: match.ruleName });
      continue;
    }
    unmatchedInfos.push(info);
  }

  const domainBuckets = new Map();

  for (const info of unmatchedInfos) {
    const tokenMatch = classifyWithTokens(info);
    if (tokenMatch) {
      const groupName = assignTabToGroupMap(groups, colorMap, counters, tokenMatch.name, tokenMatch.color, info.id, maxTabsPerGroup);
      diagnostics.set(info.id, { group: groupName, reason: 'tokens', category: tokenMatch.name });
      continue;
    }
    const domain = info.domain || info.host || 'unknown';
    if (!domainBuckets.has(domain)) {
      domainBuckets.set(domain, []);
    }
    domainBuckets.get(domain).push(info);
  }

  for (const [domain, infos] of domainBuckets.entries()) {
    const label = `By Domain – ${domain}`;
    for (const info of infos) {
      const groupName = assignTabToGroupMap(groups, colorMap, counters, label, undefined, info.id, maxTabsPerGroup);
      diagnostics.set(info.id, { group: groupName, reason: 'domain', domain });
    }
  }

  lastClassification.clear();
  for (const [id, detail] of diagnostics.entries()) {
    lastClassification.set(id, detail);
  }

  groups.colors = colorMap;
  groups.diagnostics = diagnostics;

  return groups;
}

export function explainClassification(tab) {
  const id = typeof tab === 'number' ? tab : tab && typeof tab === 'object' ? tab.id : null;
  if (typeof id !== 'number') return null;
  return lastClassification.get(id) || null;
}

