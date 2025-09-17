# Tab Organizer AI

Tab Organizer AI is a Manifest V3 Chrome extension that keeps the current browser window under control. It removes duplicate tabs, builds meaningful Chrome tab groups, and can do it either with your own OpenAI API key or with a deterministic offline mode. The project is intentionally lightweight—plain HTML, CSS, and JavaScript—so you can inspect, customize, and ship it quickly.

![Alt text](/TabOrgAI.png)

## Key features

- **Bring-your-own OpenAI key** – Store your API key and preferred model securely in `chrome.storage.sync`; nothing leaves your machine except the request to OpenAI.
- **Smart deduplication** – Close redundant tabs while keeping the most relevant version (active, pinned, or most recently used).
- **AI or deterministic grouping** – Let the LLM craft intent-based group names, or switch to the built-in rules engine for an entirely offline organizer.
- **Dry-run previews** – Inspect the proposed changes before they touch your tabs in either mode.
- **Pinned and per-domain safety rails** – Respect pinned tabs, keep at least one tab per domain, and cap group sizes.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions` in Google Chrome.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the project directory.

## Configuration

1. In Chrome's extensions list, open **Details** for Tab Organizer AI and click **Extension options**.
2. Enter your OpenAI API key (starts with `sk-`) and optionally choose a model (default: `gpt-4o-mini`).
3. Review the organizer preferences:
   - Keep at least one tab per domain.
   - Preserve pinned tabs.
   - Maximum tabs per group.
   - Default dry-run behavior for AI and No-LLM modes.
4. Click **Save changes**. Your key and settings are stored locally via `chrome.storage.sync` and are only used when the service worker calls the OpenAI API.

## Organizing your tabs

1. Open the popup from the extensions toolbar.
2. Add optional guidance in the multiline text box (for example, “Group by client projects” or “Separate research from entertainment”).
3. Choose how to run the organizer:
   - **Organize (LLM)** calls OpenAI with the context from your current window. If dry-run is enabled, review the preview before confirming **Apply plan**.
   - **Organize (No-LLM)** relies entirely on deterministic rules. Toggle *Dry-run (No-LLM)* in the popup to inspect the plan first.
   - **Close duplicates** immediately removes redundant tabs using your saved preferences for pinned tabs and per-domain safeguards.
4. Status and error messages appear at the bottom of the popup (for example, `Closed 4 dupes · Organized 3 groups`).

## No-LLM organizer

- Configure the offline rules under **No-LLM organizer** on the options page:
  - Enforce at-least-one-per-domain, pinned-tab preservation, and maximum group size.
  - Set the default dry-run preference.
  - Supply custom JSON rules. Each rule can include `name`, `host`, `title`, and `path` fields (strings or regular expressions), plus an optional `color` for the resulting tab group.
- The popup's *Dry-run (No-LLM)* checkbox temporarily overrides the saved preference.
- Example rule set:

  ```json
  [
    { "name": "GitHub PRs", "host": "github\\.com", "path": "/pull" },
    { "name": "Docs", "host": "(docs|drive)\\.google\\.com" }
  ]
  ```

- During a dry run, the popup lists which tabs would close and how remaining tabs would be grouped.

### How the offline logic works

- URLs are normalized (HTTPS enforced, tracking parameters stripped) while preserving important identifiers such as GitHub repos, Google Docs IDs, YouTube video IDs, and Jira tickets.
- A catalog of 200+ built-in patterns covers common developer, productivity, finance, shopping, and media sites. Patterns can define priorities, Chrome tab group colors, and granular host/path/title matching.
- Tabs not matched by the catalog are scored with lightweight keyword analysis to infer categories such as "CI/CD", "Docs", or "Finance". Remaining tabs fall back to eTLD+1 “By Domain” groups.
- Custom rules from the options page run ahead of built-in patterns so you can override behavior for specific sites.
- Pinned tabs and maximum-group limits are always honored. Dry-run responses surface both the dedupe candidates and the planned tab groups for review.

## Permissions

- `storage` – Save your API key, model choice, and organizer preferences.
- `tabs` – Read tab metadata (title, URL, pinned, active) and close duplicates in the current window.
- `tabGroups` – Create, update, and clean up Chrome tab groups while organizing.
- `host_permissions` (`<all_urls>`) – Required to read tab URLs for deduplication and grouping context; no page content is modified.

## Privacy and network behavior

- The extension uses your API key solely for requests to `https://api.openai.com/v1/chat/completions`.
- No analytics, telemetry, or third-party network calls.
- All processing runs in the background service worker; the extension never injects content scripts into web pages.

## Development notes

- Plain HTML, CSS, and JavaScript—no bundlers or frameworks.
- Manifest V3 extension with an ES module service worker.
- Module organization: `llm.js` handles OpenAI requests, `tab_utils.js` analyzes tabs, and the popup/options scripts drive the UI.

