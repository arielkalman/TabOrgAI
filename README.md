# Tab Organizer AI

A minimal, production-ready Chrome extension (Manifest V3) that uses your own OpenAI API key to deduplicate and group the tabs in your current Chrome window.

## Features

- Securely stores your OpenAI API key and preferred model in `chrome.storage.sync`.
- Smart duplicate detection that keeps the most relevant tab (active/pinned/recent) and closes extras.
- AI-powered grouping that creates or updates Chrome tab groups using concise intent-based names.
- Dry-run preview option to inspect the plan before applying changes.
- Respect for pinned tabs and per-domain safeguards.
- Offline "No-LLM" organizer that applies deterministic rules, grouping, and dry-run previews without calling OpenAI.

## Installation

1. Clone or download this repository.
2. Open **chrome://extensions** in Chrome.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the folder containing this project.

## Configuration

1. In the extensions list, click **Details** for Tab Organizer AI and open the **Extension options** page.
2. Enter your OpenAI API key (starts with `sk-`) and optionally choose a model (defaults to `gpt-4o-mini`).
3. Adjust preferences:
   - Keep at least one tab per domain.
   - Preserve pinned tabs.
   - Maximum tabs per group.
   - Dry-run preview before applying changes.
4. Click **Save changes**. The key and settings are stored locally via `chrome.storage.sync` and only used to call the OpenAI API.

## Usage

1. Open the popup from the extension toolbar.
2. Provide optional guidance in the multiline field (e.g., "Group by project" or "Prioritize research vs entertainment").
3. Choose how to organize:
   - **Organize (LLM)** runs the OpenAI-powered planner. If dry-run is enabled you can review the preview and press **Apply plan**.
   - **Organize (No-LLM)** stays offline and applies your deterministic rules. Enable *Dry-run (No-LLM)* in the popup to inspect the plan before committing.
4. Status updates and any errors are shown at the bottom of the popup, e.g. `Closed 4 dupes · Organized 3 groups` or a dry-run summary.

## No-LLM mode: rules, dry-run, and examples

- Configure deterministic behaviour from the options page under **No-LLM organizer**:
  - Keep at least one tab per domain, preserve pinned tabs, and optionally cap group size.
  - Toggle the default *Dry-run (No-LLM)* behaviour.
  - Provide custom rules as JSON. Each rule can include `name`, `host`, `title`, `path`, and optional `color` fields (regular expressions are supported).
- The popup's *Dry-run (No-LLM)* checkbox temporarily overrides the saved preference.
- Example custom rules:

  ```json
  [
    { "name": "GitHub PRs", "host": "github\\.com", "path": "/pull" },
    { "name": "Docs", "host": "(docs|drive)\\.google\\.com" }
  ]
  ```

- When dry-run is enabled the popup renders the planned duplicates and tab groups so you can confirm before applying.

## Permissions rationale

- `storage`: save your API key, model, and organization preferences.
- `tabs`: read metadata (title, URL, pinned, active) and close duplicates in the current window.
- `tabGroups`: create, update, and clean up Chrome tab groups during organization.
- `host_permissions` (`<all_urls>`): required to read tab URLs for deduplication and grouping context; no network requests are made to page content.

## Privacy & network behavior

- The extension uses your API key exclusively to call `https://api.openai.com/v1/chat/completions`.
- No analytics, telemetry, or third-party network calls.
- All processing happens in the background service worker—no content scripts are injected into web pages.

## Development notes

- Built with plain HTML, CSS, and JavaScript (no bundlers).
- Manifest V3 with an ES module service worker.
- Code is organized into small modules: `llm.js` for OpenAI calls, `tab_utils.js` for tab analysis, and UI scripts for popup/options pages.
