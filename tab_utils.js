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
  'dclid',
  'msclkid',
  'scid',
  'oly_enc_id',
  'oly_anon_id'
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

function firstDefined(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return undefined;
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
    id: typeof tab.id === 'number' ? tab.id : -1,
    title: typeof tab.title === 'string' ? tab.title : 'Untitled',
    url: typeof tab.url === 'string' ? tab.url : '',
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
  const windowId = typeof win.id === 'number' ? win.id : -1;
  return { windowId, tabs: snapshots };
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
      priority: firstDefined(entry.priority, defaults.priority, 400),
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

const CATEGORY_ORDER = [
  'Work/PM',
  'Dev/Code',
  'Cloud/Infra',
  'Docs/Files',
  'Comms',
  'Research/Learning',
  'Maps/Travel',
  'Shopping',
  'News/Media',
  'Other'
];

const CATEGORY_COLOR_MAP = new Map([
  ['Work/PM', 'yellow'],
  ['Dev/Code', 'blue'],
  ['Cloud/Infra', 'purple'],
  ['Docs/Files', 'green'],
  ['Comms', 'cyan'],
  ['Research/Learning', 'pink'],
  ['Maps/Travel', 'orange'],
  ['Shopping', 'red'],
  ['News/Media', 'pink'],
  ['Other', 'grey']
]);

const CATEGORY_PRIORITY = new Map(
  CATEGORY_ORDER.map((name, index) => [name, CATEGORY_ORDER.length - index])
);

const CATEGORY_RULE_DEFINITIONS = {
  'Work/PM': {
    hosts: [
      ['Jira', 'atlassian.net'],
      ['Jira', 'jira.com'],
      ['Linear', 'linear.app'],
      ['Trello', 'trello.com'],
      ['Asana', 'asana.com'],
      ['Monday', 'monday.com'],
      ['ClickUp', 'clickup.com'],
      ['Notion', 'notion.so'],
      ['Notion', 'notion.site'],
      ['Confluence', 'confluence.com'],
      ['Shortcut', 'app.shortcut.com'],
      ['Productboard', 'productboard.com']
    ]
  },
  'Dev/Code': {
    hosts: [
      ['GitHub', 'github.com'],
      ['GitHub Gist', 'gist.github.com'],
      ['GitLab', 'gitlab.com'],
      ['Bitbucket', 'bitbucket.org'],
      ['Azure DevOps', 'dev.azure.com'],
      ['Sourcegraph', 'sourcegraph.com'],
      ['npm', 'npmjs.com'],
      ['PyPI', 'pypi.org'],
      ['RubyGems', 'rubygems.org'],
      ['pkg.go.dev', 'pkg.go.dev'],
      ['crates.io', 'crates.io'],
      ['Docker Hub', 'hub.docker.com']
    ]
  },
  'Cloud/Infra': {
    hosts: [
      ['AWS Console', 'console.aws.amazon.com'],
      ['GCP Console', 'console.cloud.google.com'],
      ['GCP', 'cloud.google.com'],
      ['Azure Portal', 'portal.azure.com'],
      ['Cloudflare', 'cloudflare.com'],
      ['Vercel', 'vercel.com'],
      ['Render', 'render.com'],
      ['Railway', 'railway.app'],
      ['Fly.io', 'fly.io'],
      ['Heroku', 'heroku.com'],
      ['Supabase', 'supabase.com'],
      ['PlanetScale', 'planetscale.com'],
      ['Datadog', 'datadoghq.com'],
      ['New Relic', 'newrelic.com'],
      ['Grafana', 'grafana.com'],
      ['Sentry', 'sentry.io'],
      ['PagerDuty', 'pagerduty.com'],
      ['CircleCI', 'circleci.com'],
      ['Buildkite', 'buildkite.com']
    ],
    hostRegexes: [
      ['AWS', 'aws\\.amazon\\.com$'],
      ['AWS', 'amazonaws\\.com$']
    ]
  },
  'Docs/Files': {
    hosts: [
      ['Google Docs', 'docs.google.com'],
      ['Google Drive', 'drive.google.com'],
      ['Dropbox', 'dropbox.com'],
      ['Box', 'box.com'],
      ['OneDrive', 'onedrive.live.com'],
      ['SharePoint', 'sharepoint.com'],
      ['Office 365', 'office.com']
    ]
  },
  'Comms': {
    hosts: [
      ['Gmail', 'mail.google.com'],
      ['Outlook', 'outlook.office.com'],
      ['Outlook', 'outlook.live.com'],
      ['Teams', 'teams.microsoft.com'],
      ['Slack', 'slack.com'],
      ['Discord', 'discord.com'],
      ['Telegram', 'web.telegram.org'],
      ['WhatsApp', 'web.whatsapp.com'],
      ['Zoom', 'zoom.us'],
      ['Google Meet', 'meet.google.com'],
      ['Google Calendar', 'calendar.google.com'],
      ['Calendly', 'calendly.com']
    ]
  },
  'Research/Learning': {
    hosts: [
      ['Google Scholar', 'scholar.google.com'],
      ['arXiv', 'arxiv.org'],
      ['Stack Overflow', 'stackoverflow.com'],
      ['Stack Exchange', 'stackexchange.com'],
      ['MDN', 'developer.mozilla.org'],
      ['Wikipedia', 'wikipedia.org'],
      ['Medium', 'medium.com'],
      ['Dev.to', 'dev.to'],
      ['freeCodeCamp', 'freecodecamp.org']
    ],
    paths: [
      { label: 'Google Search', host: 'google.com', path: '^/(?:search|webhp)' }
    ]
  },
  'Maps/Travel': {
    hosts: [
      ['Google Maps', 'maps.google.com'],
      ['Booking', 'booking.com'],
      ['Airbnb', 'airbnb.com'],
      ['Expedia', 'expedia.com'],
      ['Kayak', 'kayak.com'],
      ['Skyscanner', 'skyscanner.com'],
      ['Skyscanner', 'skyscanner.net'],
      ['Uber', 'uber.com'],
      ['Lyft', 'lyft.com'],
      ['Tripadvisor', 'tripadvisor.com']
    ],
    paths: [
      { label: 'Google Maps', host: 'google.com', path: '^/maps' }
    ]
  },
  'Shopping': {
    hosts: [
      ['Amazon', 'amazon.com'],
      ['eBay', 'ebay.com'],
      ['AliExpress', 'aliexpress.com'],
      ['Etsy', 'etsy.com'],
      ['Walmart', 'walmart.com'],
      ['Target', 'target.com'],
      ['Best Buy', 'bestbuy.com'],
      ['Costco', 'costco.com']
    ],
    hostRegexes: [
      ['Amazon', 'amazon\\.[a-z.]+$']
    ],
    paths: [
      { label: 'Amazon Search', host: 'amazon.com', path: '^/s' }
    ]
  },
  'News/Media': {
    hosts: [
      ['Hacker News', 'news.ycombinator.com'],
      ['Reddit', 'reddit.com'],
      ['TechCrunch', 'techcrunch.com'],
      ['The Verge', 'theverge.com'],
      ['NYTimes', 'nytimes.com'],
      ['Washington Post', 'washingtonpost.com'],
      ['BBC', 'bbc.com'],
      ['CNN', 'cnn.com'],
      ['YouTube', 'youtube.com'],
      ['Netflix', 'netflix.com'],
      ['Hulu', 'hulu.com'],
      ['Spotify', 'spotify.com']
    ]
  }
};

const CATEGORY_KEYWORD_DEFINITIONS = {
  'Work/PM': {
    keywords: {
      jira: 4,
      issue: 3,
      ticket: 3,
      board: 2,
      sprint: 2,
      backlog: 2,
      project: 2,
      task: 2,
      kanban: 2,
      roadmap: 2,
      story: 2,
      milestone: 2,
      notion: 1.5,
      asana: 3,
      trello: 3,
      monday: 3,
      clickup: 3,
      productboard: 2
    },
    hostHints: ['jira', 'atlassian', 'linear', 'trello', 'asana', 'monday', 'notion', 'clickup', 'shortcut', 'productboard'],
    pathHints: ['board', 'sprint', 'project', 'kanban'],
    threshold: 4
  },
  'Dev/Code': {
    keywords: {
      git: 3,
      repo: 3,
      pull: 3,
      merge: 3,
      commit: 3,
      branch: 2,
      code: 2,
      diff: 2,
      issue: 2,
      pr: 3,
      review: 2,
      package: 2,
      library: 2,
      sdk: 2,
      api: 2,
      ci: 2
    },
    hostHints: ['github', 'gitlab', 'bitbucket', 'sourcegraph', 'npm', 'pypi', 'rubygems', 'crates', 'docker'],
    pathHints: ['pull', 'merge', 'commit', 'blob', 'tree'],
    threshold: 4
  },
  'Cloud/Infra': {
    keywords: {
      cloud: 3,
      aws: 3,
      gcp: 3,
      azure: 3,
      console: 2,
      cluster: 2,
      kube: 3,
      kubernet: 3,
      deploy: 2,
      infrastructure: 3,
      instance: 2,
      server: 2,
      pipeline: 2,
      metric: 2,
      monitor: 2,
      log: 2,
      alert: 2
    },
    hostHints: ['aws', 'amazonaws', 'cloud', 'azure', 'cloudflare', 'vercel', 'render', 'railway', 'fly.io', 'heroku', 'supabase', 'planetscale', 'datadog', 'newrelic', 'grafana', 'sentry', 'pagerduty', 'circleci', 'buildkite'],
    pathHints: ['deploy', 'pipeline', 'console'],
    threshold: 4
  },
  'Docs/Files': {
    keywords: {
      doc: 3,
      docs: 3,
      sheet: 3,
      slide: 3,
      drive: 3,
      file: 2,
      folder: 2,
      pdf: 2,
      presentation: 2,
      spreadsheet: 3,
      notebook: 2,
      note: 2
    },
    hostHints: ['docs.google', 'drive.google', 'dropbox', 'box.com', 'onedrive', 'sharepoint', 'office.com'],
    pathHints: ['document', 'presentation', 'spreadsheets'],
    threshold: 4
  },
  'Comms': {
    keywords: {
      mail: 3,
      inbox: 3,
      calendar: 3,
      meeting: 2,
      meet: 2,
      chat: 3,
      message: 3,
      call: 2,
      video: 2,
      slack: 3,
      teams: 3,
      invite: 2,
      reply: 2
    },
    hostHints: ['mail.google', 'outlook', 'teams', 'slack', 'discord', 'telegram', 'whatsapp', 'zoom', 'meet.google', 'calendar.google', 'calendly'],
    titleHints: ['meeting', 'standup', '1:1'],
    threshold: 4
  },
  'Research/Learning': {
    keywords: {
      search: 3,
      learn: 3,
      tutorial: 3,
      guide: 3,
      reference: 3,
      docs: 2,
      wiki: 3,
      stack: 2,
      question: 2,
      answer: 2,
      blog: 2,
      analysis: 2,
      how: 2
    },
    hostHints: ['google', 'scholar', 'arxiv', 'stackoverflow', 'stackexchange', 'mozilla', 'wikipedia', 'medium', 'dev.to', 'freecodecamp'],
    pathHints: ['search', 'learn'],
    threshold: 3
  },
  'Maps/Travel': {
    keywords: {
      map: 3,
      maps: 3,
      travel: 3,
      trip: 3,
      flight: 3,
      hotel: 3,
      booking: 3,
      airbnb: 3,
      route: 2,
      direction: 2,
      itinerary: 2,
      ride: 2,
      airport: 2
    },
    hostHints: ['maps.google', 'booking', 'airbnb', 'expedia', 'kayak', 'skyscanner', 'uber', 'lyft', 'tripadvisor'],
    pathHints: ['maps', 'travel'],
    threshold: 3
  },
  'Shopping': {
    keywords: {
      buy: 3,
      cart: 3,
      checkout: 3,
      order: 3,
      product: 3,
      price: 2,
      deal: 2,
      sale: 2,
      shop: 2,
      wishlist: 2,
      shipping: 2,
      basket: 2
    },
    hostHints: ['amazon', 'ebay', 'aliexpress', 'etsy', 'walmart', 'target', 'bestbuy', 'costco'],
    pathHints: ['cart', 'checkout'],
    threshold: 3
  },
  'News/Media': {
    keywords: {
      news: 3,
      headline: 3,
      article: 3,
      review: 3,
      reddit: 3,
      hn: 2,
      video: 3,
      watch: 3,
      stream: 3,
      episode: 2,
      podcast: 2,
      feed: 2,
      breaking: 3,
      story: 2
    },
    hostHints: ['news.ycombinator', 'reddit', 'techcrunch', 'verge', 'nytimes', 'washingtonpost', 'bbc', 'cnn', 'youtube', 'netflix', 'hulu', 'spotify'],
    titleHints: ['breaking', 'episode', 'season'],
    threshold: 3
  }
};

const RULES_CATALOG = buildRulesCatalog();
const COMPILED_RULES = compileRuleCatalog(RULES_CATALOG);
const KEYWORD_MAP = buildKeywordMap();

const CATEGORY_NEIGHBORS = new Map([
  ['Work/PM', ['Dev/Code', 'Docs/Files', 'Comms']],
  ['Dev/Code', ['Cloud/Infra', 'Research/Learning', 'Work/PM']],
  ['Cloud/Infra', ['Dev/Code', 'Comms', 'Work/PM']],
  ['Docs/Files', ['Work/PM', 'Comms', 'Research/Learning']],
  ['Comms', ['Work/PM', 'Docs/Files', 'Cloud/Infra']],
  ['Research/Learning', ['Dev/Code', 'Docs/Files', 'News/Media']],
  ['Maps/Travel', ['Shopping', 'News/Media', 'Other']],
  ['Shopping', ['News/Media', 'Maps/Travel', 'Other']],
  ['News/Media', ['Research/Learning', 'Comms', 'Other']],
  ['Other', ['News/Media', 'Shopping', 'Maps/Travel']]
]);
function buildRulesCatalog() {
  const rules = [];
  for (const [category, definition] of Object.entries(CATEGORY_RULE_DEFINITIONS)) {
    const color = CATEGORY_COLOR_MAP.get(category);
    const priority = firstDefined(definition.priority, 800);
    for (const [label, host] of definition.hosts || []) {
      rules.push({
        name: category,
        category,
        label,
        color,
        priority,
        match: { host }
      });
    }
    for (const [label, pattern] of definition.hostRegexes || []) {
      rules.push({
        name: category,
        category,
        label,
        color,
        priority,
        match: { hostRegex: new RegExp(pattern, 'i') }
      });
    }
    for (const entry of definition.paths || []) {
      rules.push({
        name: category,
        category,
        label: entry.label || category,
        color,
        priority,
        match: { host: entry.host || null, path: entry.path || null }
      });
    }
  }
  return rules;
}

function buildKeywordMap() {
  const map = new Map();
  for (const [category, definition] of Object.entries(CATEGORY_KEYWORD_DEFINITIONS)) {
    const keywords = new Map(Object.entries(definition.keywords || {}));
    map.set(category, {
      keywords,
      keywordSet: new Set(keywords.keys()),
      hostHints: definition.hostHints || [],
      pathHints: definition.pathHints || [],
      titleHints: (definition.titleHints || []).map((pattern) => new RegExp(pattern, 'i')),
      hostWeight: firstDefined(definition.hostWeight, 3),
      pathWeight: firstDefined(definition.pathWeight, 1.5),
      titleWeight: firstDefined(definition.titleWeight, 2),
      threshold: firstDefined(definition.threshold, 3),
      priority: firstDefined(definition.priority, CATEGORY_PRIORITY.get(category)) || 0
    });
  }
  return map;
}

function compileRuleCatalog(catalog) {
  return catalog
    .map((rule, index) => compileSingleRule(rule, index))
    .filter(Boolean)
    .sort((a, b) => b.priority - a.priority || a.index - b.index);
}

function compileSingleRule(rule, index) {
  if (!rule || typeof rule !== 'object') return null;
  const priority = Number.isFinite(rule.priority) ? Number(rule.priority) : 0;
  const color = sanitizeGroupColor(rule.color) || undefined;
  const category = typeof rule.category === 'string' ? rule.category : undefined;
  const label = typeof rule.label === 'string' ? rule.label : rule.name;
  const match = rule.match || {};
  const host = match.hostRegex || resolveHostRegex(match.host);
  const path = match.pathRegex || resolveRegex(match.path);
  const title = match.titleRegex || resolveRegex(match.title);
  if (!host && !path && !title) return null;
  return {
    index,
    name: typeof rule.name === 'string' ? rule.name : category || 'Group',
    color,
    priority,
    host,
    path,
    title,
    category,
    label,
    deriveName: typeof rule.deriveName === 'function' ? rule.deriveName : null
  };
}

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
      category: name,
      label: name,
      deriveName: () => ({ name, key: `user:${name.toLowerCase()}` })
    });
  }
  return compiled;
}

export function categorizeTabs(tabs, options = {}) {
  const infos = ensureTabInfos(tabs);
  const { groups, assignments } = categorizeTabInfos(infos, options);
  const map = new Map();
  const colors = new Map();
  const diagnostics = new Map();

  for (const group of groups) {
    if (!group.tabIds.length) continue;
    const sorted = sortTabIdsByIndex(group.tabIds, assignments);
    map.set(group.name, sorted);
    const color = CATEGORY_COLOR_MAP.get(group.name) || group.color;
    if (color) colors.set(group.name, color);
  }

  for (const [tabId, assignment] of assignments.entries()) {
    diagnostics.set(tabId, buildCategoryDiagnostic(assignment));
  }

  map.colors = colors;
  map.diagnostics = diagnostics;
  return map;
}
function categorizeTabInfos(tabInfos, options = {}) {
  const assignments = new Map();
  const unmatched = [];

  for (const info of tabInfos) {
    const ruleMatch = matchCategoryRule(info);
    if (ruleMatch) {
      const category = normalizeCategoryName(ruleMatch.category || ruleMatch.name);
      assignments.set(
        info.id,
        createCategoryAssignment(info, category, 'rule', {
          rule: ruleMatch.ruleName,
          color: ruleMatch.color || CATEGORY_COLOR_MAP.get(category)
        })
      );
    } else {
      unmatched.push(info);
    }
  }

  for (const info of unmatched) {
    const scored = scoreCategory(info);
    const category = normalizeCategoryName(scored.category);
    assignments.set(
      info.id,
      createCategoryAssignment(info, category, 'keyword', {
        score: scored.score,
        keywords: scored.keywords
      })
    );
  }

  limitCategoryAssignments(assignments, options.maxGroups || 5);
  const { groups } = collectCategoryGroupRecords(assignments);
  return { groups, assignments };
}

function ensureTabInfos(tabs) {
  const infos = [];
  for (const entry of tabs || []) {
    if (entry && typeof entry === 'object' && entry.host && entry.tokenFrequency) {
      infos.push(entry);
    } else if (entry && typeof entry === 'object') {
      infos.push(prepareTabForClassification(entry));
    }
  }
  return infos;
}

function normalizeCategoryName(name) {
  if (!name || typeof name !== 'string') return 'Other';
  const trimmed = name.trim();
  return CATEGORY_ORDER.includes(trimmed) ? trimmed : 'Other';
}

function createCategoryAssignment(info, category, method, details = {}) {
  return {
    id: info.id,
    info,
    category,
    initialCategory: category,
    method,
    rule: details.rule || null,
    color: details.color || CATEGORY_COLOR_MAP.get(category),
    score: details.score,
    keywords: details.keywords || [],
    mergeHistory: []
  };
}

function matchCategoryRule(tabInfo) {
  return matchCompiledRule(COMPILED_RULES, tabInfo);
}

function scoreCategory(tabInfo) {
  const frequency = tabInfo.tokenFrequency || new Map();
  let best = { category: 'Other', score: 0, keywords: [] };
  for (const [category, config] of KEYWORD_MAP.entries()) {
    if (category === 'Other') continue;
    let score = 0;
    const matches = [];
    for (const [keyword, weight] of config.keywords.entries()) {
      const freq = frequency.get(keyword);
      if (freq) {
        const contribution = freq * weight;
        score += contribution;
        matches.push({ keyword, weight: contribution });
      }
    }
    if (config.hostHints) {
      for (const hint of config.hostHints) {
        if (tabInfo.host.includes(hint)) {
          score += config.hostWeight;
        }
      }
    }
    if (config.pathHints) {
      for (const hint of config.pathHints) {
        if (tabInfo.path.includes(hint)) {
          score += config.pathWeight;
        }
      }
    }
    if (config.titleHints) {
      for (const regex of config.titleHints) {
        if (regex.test(tabInfo.title)) {
          score += config.titleWeight;
        }
      }
    }
    if (score >= config.threshold) {
      matches.sort((a, b) => b.weight - a.weight);
      const adjusted = score + (config.priority || 0) * 0.01;
      const bestConfig = best.category ? KEYWORD_MAP.get(best.category) : null;
      const bestPriority =
        bestConfig && bestConfig.priority !== null && bestConfig.priority !== undefined ? bestConfig.priority : 0;
      if (
        adjusted > best.score ||
        (Math.abs(adjusted - best.score) < 0.0001 && (config.priority || 0) > bestPriority)
      ) {
        best = {
          category,
          score: adjusted,
          keywords: matches.slice(0, 5)
        };
      }
    }
  }
  return best;
}

function limitCategoryAssignments(assignments, maxGroups) {
  const safeMax = Math.max(1, Math.min(5, Math.floor(maxGroups)));
  let changed = true;
  while (changed) {
    changed = false;
    const stats = computeCategoryStats(assignments);
    const entries = Array.from(stats.values()).filter((entry) => entry.count > 0);
    if (!entries.length) break;
    const otherEntry = stats.get('Other');
    const nonOther = entries.filter((entry) => entry.name !== 'Other');
    let totalGroups = entries.length;

    if (totalGroups > safeMax) {
      const reserveForOther = nonOther.length > safeMax || (otherEntry && otherEntry.count > 0) ? 1 : 0;
      let allowedNonOther = safeMax - reserveForOther;
      if (allowedNonOther < 0) allowedNonOther = 0;
      nonOther.sort((a, b) => b.count - a.count || CATEGORY_PRIORITY.get(b.name) - CATEGORY_PRIORITY.get(a.name));
      for (const entry of nonOther.slice(allowedNonOther)) {
        mergeAssignmentsForTabs(assignments, entry.tabIds, entry.name, 'Other', 'overflow');
        changed = true;
      }
      totalGroups = computeCategoryStats(assignments).size;
    }

    if (!changed && totalGroups >= 4) {
      const refreshed = computeCategoryStats(assignments);
      for (const entry of refreshed.values()) {
        if (entry.name === 'Other') continue;
        if (entry.count < 2) {
          const target = findNearestCategory(entry.name, refreshed) || 'Other';
          mergeAssignmentsForTabs(assignments, entry.tabIds, entry.name, target, 'small');
          changed = true;
          break;
        }
      }
    }

    if (!changed) {
      const refreshed = computeCategoryStats(assignments);
      if (refreshed.size > safeMax) {
        const candidate = findSmallestCategory(refreshed);
        if (candidate) {
          const target = findNearestCategory(candidate.name, refreshed) || 'Other';
          mergeAssignmentsForTabs(assignments, candidate.tabIds, candidate.name, target, 'limit');
          changed = true;
        }
      }
    }
  }
}
function computeCategoryStats(assignments) {
  const stats = new Map();
  for (const assignment of assignments.values()) {
    const name = assignment.category;
    if (!stats.has(name)) {
      stats.set(name, { name, count: 0, tabIds: [], assignments: [] });
    }
    const entry = stats.get(name);
    entry.count += 1;
    entry.tabIds.push(assignment.id);
    entry.assignments.push(assignment);
  }
  return stats;
}

function mergeAssignmentsForTabs(assignments, tabIds, fromName, toName, reason) {
  if (!tabIds || fromName === toName) return;
  for (const tabId of tabIds) {
    const assignment = assignments.get(tabId);
    if (!assignment || assignment.category === toName) continue;
    assignment.mergeHistory.push({ from: assignment.category, to: toName, reason });
    assignment.category = toName;
  }
}

function findSmallestCategory(stats) {
  let candidate = null;
  for (const entry of stats.values()) {
    if (entry.count === 0) continue;
    if (entry.name === 'Other') continue;
    if (!candidate || entry.count < candidate.count) {
      candidate = entry;
    }
  }
  if (!candidate) {
    candidate = stats.get('Other') || null;
  }
  return candidate;
}

function findNearestCategory(name, stats) {
  let best = null;
  let bestScore = -Infinity;
  for (const entry of stats.values()) {
    if (entry.name === name || entry.count === 0) continue;
    const score = computeCategorySimilarity(name, entry.name);
    const currentBestCount = best ? best.count : 0;
    if (score > bestScore || (score === bestScore && entry.count > currentBestCount)) {
      best = entry;
      bestScore = score;
    }
  }
  return best ? best.name : null;
}

function computeCategorySimilarity(a, b) {
  if (a === b) return Number.POSITIVE_INFINITY;
  const configA = KEYWORD_MAP.get(a);
  const configB = KEYWORD_MAP.get(b);
  if (!configA || !configB) return 0;
  let score = 0;
  for (const keyword of configA.keywordSet) {
    if (configB.keywordSet.has(keyword)) {
      score += Math.min(configA.keywords.get(keyword) || 1, configB.keywords.get(keyword) || 1);
    }
  }
    const neighborsA = CATEGORY_NEIGHBORS.get(a);
    if (Array.isArray(neighborsA) && neighborsA.includes(b)) score += 0.5;
    const neighborsB = CATEGORY_NEIGHBORS.get(b);
    if (Array.isArray(neighborsB) && neighborsB.includes(a)) score += 0.5;
  return score;
}

function collectCategoryGroupRecords(assignments) {
  const stats = computeCategoryStats(assignments);
  const groups = [];
  for (const entry of stats.values()) {
    const sorted = entry.assignments
      .slice()
      .sort((a, b) => a.info.tab.index - b.info.tab.index)
      .map((assignment) => assignment.id);
    groups.push({
      name: entry.name,
      tabIds: sorted,
      color: CATEGORY_COLOR_MAP.get(entry.name) || null,
      origin: 'category'
    });
  }
  groups.sort((a, b) => b.tabIds.length - a.tabIds.length || CATEGORY_PRIORITY.get(b.name) - CATEGORY_PRIORITY.get(a.name));
  return { groups, stats };
}

function sortTabIdsByIndex(tabIds, assignments) {
  return tabIds
    .slice()
    .sort((a, b) => {
      const assignmentA = assignments.get(a);
      const assignmentB = assignments.get(b);
      const infoA = assignmentA ? assignmentA.info : null;
      const infoB = assignmentB ? assignmentB.info : null;
      const indexA = infoA ? infoA.tab.index : 0;
      const indexB = infoB ? infoB.tab.index : 0;
      return indexA - indexB;
    });
}

function buildCategoryDiagnostic(assignment) {
  const diag = {
    group: assignment.category,
    reason: assignment.method === 'rule' ? 'category-rule' : 'category-keywords'
  };
  if (assignment.rule) {
    diag.rule = assignment.rule;
  }
  if (assignment.method === 'keyword') {
    const hasScore = typeof assignment.score === 'number';
    diag.score = hasScore ? Number(assignment.score.toFixed(2)) : 0;
    if (assignment.keywords && assignment.keywords.length) {
      diag.keywords = assignment.keywords.map((item) => item.keyword);
    }
  }
  if (assignment.mergeHistory.length) {
    diag.merge = assignment.mergeHistory.map((step) => ({ from: step.from, to: step.to, reason: step.reason }));
  }
  return diag;
}
function capTotalGroups(records, assignments, maxGroups) {
  const safeMax = Math.max(1, Math.min(5, Math.floor(maxGroups)));
  const working = records
    .map((record) => ({ ...record, tabIds: Array.from(new Set(record.tabIds)) }))
    .filter((record) => record.tabIds.length > 0);
  if (!working.length) return working;
  let other = working.find((record) => record.name === 'Other');
  while (working.length > safeMax) {
    const index = findSmallestRecordIndex(working);
    if (index < 0) break;
    const candidate = working[index];
    let target = selectTargetRecord(candidate, working);
    if (!target) {
      if (!other) {
        other = { name: 'Other', tabIds: [], color: CATEGORY_COLOR_MAP.get('Other'), origin: 'category' };
        working.push(other);
      }
      target = other;
    }
    if (target.name === candidate.name) break;
    mergeGroupRecords(candidate, target, assignments, 'limit');
    working.splice(index, 1);
  }
  return working.filter((record) => record.tabIds.length > 0);
}

function findSmallestRecordIndex(records) {
  let candidateIndex = -1;
  let bestKey = null;
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.name === 'Other' && records.length <= 1) continue;
    const prefer = record.origin === 'category' ? 0 : 1;
    const key = [prefer, record.tabIds.length, CATEGORY_PRIORITY.get(record.name) || 0];
    if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] > bestKey[2])))) {
      bestKey = key;
      candidateIndex = i;
    }
  }
  return candidateIndex;
}

function selectTargetRecord(candidate, records) {
  if (candidate.origin === 'category') {
    let best = null;
    let bestScore = -Infinity;
    for (const record of records) {
      if (record.name === candidate.name || record.tabIds.length === 0) continue;
      let score = 0;
      if (record.origin === 'category') {
        score = computeCategorySimilarity(candidate.name, record.name);
      }
      const bestLength = best ? best.tabIds.length : 0;
      if (score > bestScore || (score === bestScore && record.tabIds.length > bestLength)) {
        best = record;
        bestScore = score;
      }
    }
    if (best) return best;
  }
  return records.find((record) => record.name === 'Other');
}

function mergeGroupRecords(source, target, assignments, reason) {
  const uniqueIds = Array.from(new Set(source.tabIds));
  target.tabIds.push(...uniqueIds);
  mergeAssignmentsForTabs(assignments, uniqueIds, source.name, target.name, reason);
  source.tabIds = [];
}

function buildFinalDiagnostic(assignment) {
  if (!assignment) return null;
  if (assignment.method === 'user-rule') {
    const diag = { group: assignment.category, reason: 'rule' };
    if (assignment.rule) diag.rule = assignment.rule;
    if (assignment.mergeHistory.length) {
      diag.merge = assignment.mergeHistory.map((step) => ({ from: step.from, to: step.to, reason: step.reason }));
    }
    return diag;
  }
  return buildCategoryDiagnostic(assignment);
}

function matchCompiledRule(rules, tabInfo) {
  for (const rule of rules) {
    if (rule.host && !rule.host.test(tabInfo.host)) continue;
    if (rule.title && !rule.title.test(tabInfo.title)) continue;
    if (rule.path && !rule.path.test(tabInfo.path)) continue;
    const derived = rule.deriveName ? rule.deriveName(tabInfo, rule) : null;
    const category = normalizeCategoryName((derived && derived.category) || rule.category || rule.name);
    const baseName = derived && derived.name ? truncateLabel(derived.name) : truncateLabel(category || rule.name);
    const color = derived && derived.color ? sanitizeGroupColor(derived.color) || rule.color : rule.color;
    const key = derived && derived.key ? derived.key : null;
    const label = derived && derived.label ? derived.label : rule.label || rule.name;
    return { name: baseName, color, key, ruleName: label, category };
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

  const compiledUserRules = compileUserRules(userRulesInput);
  const snapshots = ensureSnapshots(tabs).slice().sort((a, b) => a.index - b.index);
  const userGroups = new Map();
  const colorMap = new Map();
  const counters = new Map();
  const assignments = new Map();
  const pinnedDiagnostics = new Map();
  const unmatchedInfos = [];

  for (const tab of snapshots) {
    if (preservePinned && tab.pinned) {
      pinnedDiagnostics.set(tab.id, { group: null, reason: 'pinned' });
      continue;
    }
    const info = prepareTabForClassification(tab);
    const match = matchCompiledRule(compiledUserRules, info);
    if (match) {
      const groupName = assignTabToGroupMap(userGroups, colorMap, counters, match.name, match.color, tab.id, maxTabsPerGroup);
      assignments.set(tab.id, {
        id: tab.id,
        info,
        category: groupName,
        initialCategory: groupName,
        method: 'user-rule',
        rule: match.ruleName,
        mergeHistory: []
      });
      continue;
    }
    unmatchedInfos.push(info);
  }

  let categoryAssignments = { groups: [], assignments: new Map() };
  if (unmatchedInfos.length) {
    const availableSlots = Math.max(1, 5 - userGroups.size);
    categoryAssignments = categorizeTabInfos(unmatchedInfos, { maxGroups: availableSlots });
    for (const [tabId, assignment] of categoryAssignments.assignments.entries()) {
      assignments.set(tabId, assignment);
    }
  }

  const records = [];
  for (const [name, ids] of userGroups.entries()) {
    if (!ids.length) continue;
    const sorted = sortTabIdsByIndex(ids, assignments);
    records.push({ name, tabIds: sorted, color: colorMap.get(name) || null, origin: 'user' });
  }
  records.push(...categoryAssignments.groups);

  const cappedRecords = capTotalGroups(records, assignments, 5);

  const finalColorMap = new Map();
  const finalDiagnostics = new Map();
  for (const [tabId, detail] of pinnedDiagnostics.entries()) {
    finalDiagnostics.set(tabId, detail);
  }

  const normalizedRecords = cappedRecords
    .map((record) => ({ ...record, tabIds: sortTabIdsByIndex(record.tabIds, assignments) }))
    .filter((record) => record.tabIds.length > 0)
    .sort((a, b) => b.tabIds.length - a.tabIds.length || CATEGORY_PRIORITY.get(b.name) - CATEGORY_PRIORITY.get(a.name));

  const finalGroups = new Map();
  for (const record of normalizedRecords) {
    finalGroups.set(record.name, record.tabIds);
    const color = record.origin === 'user' ? colorMap.get(record.name) || record.color : CATEGORY_COLOR_MAP.get(record.name) || record.color;
    if (color) finalColorMap.set(record.name, color);
  }

  for (const [tabId, assignment] of assignments.entries()) {
    finalDiagnostics.set(tabId, buildFinalDiagnostic(assignment));
  }

  finalGroups.colors = finalColorMap;
  finalGroups.diagnostics = finalDiagnostics;

  lastClassification.clear();
  for (const [id, detail] of finalDiagnostics.entries()) {
    lastClassification.set(id, detail);
  }

  return finalGroups;
}

export function explainClassification(tab) {
  const id = typeof tab === 'number' ? tab : tab && typeof tab === 'object' ? tab.id : null;
  if (typeof id !== 'number') return null;
  return lastClassification.get(id) || null;
}

