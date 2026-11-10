<p align="center">
  <img src="icon.svg" width="88" height="88" alt="Selection Reader icon" />
</p>

<h1 align="center">Selection Reader · 划词解读</h1>

<p align="center">
  <b>Select any text in a DeepSeek Harness conversation. Get an explanation that fits the current context.</b>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
  <br />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg" />
  <img alt="version" src="https://img.shields.io/badge/version-1.1.0-green.svg" />
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness-4d6bfe.svg" />
</p>

---

A plugin for DeepSeek Harness (DSH) that explains selected words or passages **in the context of the current conversation** — not as a dictionary lookup, but as "what does this mean here".

Terminology such as `SP-API`, `LGPD`, `PIPL`, platform policies or `SaaS` is hard to look up without losing your place. Selection Reader adds an **Interpret** button next to the built-in Quote action, opens a draggable result window, shows a structured explanation, and keeps a searchable history that can jump back to the original conversation.

## Features

- **Context-aware interpretation** — the selected text and the current turn are sent together, so the model explains what the passage means in this conversation.
- **Structured result, not a wall of text** — the reply is split into "Meaning here / Evidence / Notes" cards, with the selected term highlighted inline.
- **Readable, movable window** — draggable header, skeleton loading state, retryable error state, copy button, and the model actually used.
- **Persistent highlight** — selections are highlighted in the chat. Click a highlight to reopen the interpretation; right-click to delete it (which also removes its history entry).
- **History that goes somewhere** — entries are titled by the interpreted text, searchable by text or conversation title, and can jump back to the original message.
- **Explicit settings save** — edit settings in a draft, then click **Save settings**; unsaved changes are marked, and Discard changes resets the draft.
- **Model choices** — follow the current conversation's model, pick a specific Harness model, or use any **OpenAI-compatible** third-party API (endpoint, API key, model) with a built-in connection test.
- **Sensible defaults** — same-conversation same-turn text is cached (no second model call); reinterpreting the same turn with different text overwrites that turn's entry; history has a configurable cap.

## Requirements

- DeepSeek Harness (DSH) desktop `0.2.2-rc.1` or a compatible profile with plugin-bundle and web-server support.
- Git, to clone the repository.
- Node.js is only needed if you want to run the checks or tests.

## Installation

The plugin is a DSH **bundle**: a Host half that exposes local HTTP routes and a browser half that renders the UI.

### 1. Clone

```powershell
git clone https://github.com/ShiroiSkyy/dsh-selection-reader.git
```

### 2. Install into your DSH profile

In a DSH session, ask the agent to install the bundle from the cloned directory, for example:

> Install this DSH plugin bundle: `D:\path\to\dsh-selection-reader` (use `plugin_manager` with `install_bundle`).

The agent calls `plugin_manager(action: "install_bundle", target: "<absolute path>")`. The plugin then becomes enabled in your profile; the tool writes the profile entry itself, so do not edit the profile `cordis.patch.yml` by hand.

### 3. Refresh the page

Reload the Harness Web GUI once. A **划词解读 / Selection Reader** icon appears at the top of the sidebar.

### Upgrade

```powershell
cd dsh-selection-reader
git pull
```

Reinstall the bundle (or restart DSH) so the new Host half loads.

### Uninstall

Ask the agent to remove the bundle:

> Remove the DSH bundle `@local/dsh-selection-reader` (`plugin_manager` with `remove_bundle`).

## Usage

1. Select text in a finished assistant reply or a displayed user message.
2. In the floating menu, click **解读** next to **引用文本**.
3. The selection is highlighted immediately, and the result window opens near it. Wait for the skeleton to resolve into the structured explanation.
4. Click the highlight later to reopen the interpretation; right-click it and choose **删除解读** to remove both the highlight and the history entry.
5. Open the sidebar icon to browse **History** and **Settings**.

### History

- Entries are stored per conversation and per turn. Reinterpreting identical text in the same turn reuses the cached result.
- Interpreting different text in the same turn replaces that turn's entry (the previous one is overwritten, matching "show only the latest interpretation for this turn").
- The list can be searched by interpreted text or conversation title. The detail view can copy the result or return to the original conversation; if that conversation no longer exists, a notice is shown instead of an error page.

### Settings

| Section | Option | Default |
| --- | --- | --- |
| Interpretation | Interpretation prompt (editable, restore default) | built-in Chinese prompt |
| Interpretation | Model: follow conversation / specific model / custom API | follow conversation |
| Interpretation | Custom API: endpoint, API key, model; **Test connection** | empty |
| Interpretation | Maximum characters per interpretation | 500 |
| Selection & display | Show **解读** in the selection menu | on |
| Selection & display | Highlight style: soft fill / underline | soft fill |
| Selection & display | Highlight color: theme / amber / blue | theme |
| History | History limit | 200 entries |
| History | Clear history (two-step confirmation) | — |

Settings are saved explicitly with **Save settings**. Draft changes survive switching between History and Settings; **Discard changes** restores saved values.

### Custom API

- Works with services that expose an OpenAI-compatible `POST {base}/chat/completions` endpoint. The endpoint may stop at `/v1` or point at the full path.
- **Test connection** sends a minimal request and reports success plus latency, or the provider's error message.
- The API key is stored only in your browser's `localStorage` and is sent to the local DSH Host when interpreting; it is not written into the DSH profile or any repository.
- Non-OpenAI-compatible protocols (Anthropic native, Gemini native, …) are not supported yet.

## Data & privacy

- Settings and history live in the browser: `selection-reader:settings:v1` and `selection-reader:history:v1`. They are per browser profile and are not synced.
- Interpreted text and the current turn are sent to the configured model endpoint. With a custom API, they go to the endpoint you configured.
- No telemetry is collected. `GET /selection-reader/api/diag` only exposes counters and the client build marker.
- Host routes accept same-origin JSON requests only (cross-site `Origin` and non-JSON `POST`s are rejected), so an unrelated web page cannot drive the interpretation endpoint or use it as a proxy.

## How it works

| Half | Responsibility |
| --- | --- |
| Host (`index.js`) | Local HTTP API: `POST /interpret`, `POST /custom/test`, `GET /models`, `GET /health`, `GET/POST /diag`. Calls `ctx.llm` for Harness models or an OpenAI-compatible endpoint for custom APIs. |
| Client (`client.js`) | Floating Interpret button, result window, DOM-based highlights, history and settings pages. Uses `sidebar.panellist`, `main`, `shell.overlay` and `conversation.input.dock` slots. |

- The Interpret button is positioned next to the official Quote pill by measuring its rectangle; the official interaction slot is not modified, so DSH starts normally.
- Highlights are real `<mark data-si-record>` elements. A `MutationObserver` re-applies them after chat re-renders.
- Pure logic (cache, overwrite, history cap, search, section parsing, term splitting) is unit-tested by extracting a marked region from `client.js`.

## Development

```powershell
node --check client.js
node --check index.js
node test\selection-reader.test.mjs
```

The test file extracts the marked pure-logic region from `client.js`, so the same source stays testable without a build step.

For development, install the working directory as a bundle and reload the page after changes. Host changes require restarting the bundle entry (ask the agent to toggle the bundle, or restart DSH).

### Project structure

| File | Purpose |
| --- | --- |
| `index.js` | Host half: HTTP routes, `ctx.llm` / OpenAI-compatible calls |
| `client.js` | Browser half: UI, selection handling, highlights, storage |
| `cordis.patch.yml` | Inserts the plugin row into the DSH profile |
| `package.json` | Bundle manifest, `dsh.bundle` and `dsh.client` declarations |
| `locale/` | Plugin Manager title and description |
| `icon.svg` | Plugin icon |
| `test/` | Pure-logic unit tests |

## Limitations

- Custom APIs must be OpenAI-compatible.
- History and settings are local to one browser profile.
- Only finished assistant text and displayed user messages can be selected; streaming text is not interactive.
- Read-only or unaddressable sessions do not show the official selection surface, so the Interpret button is unavailable there.
- Highlight marks live inside React-managed message content; if the host re-renders a message, marks are re-applied on the next DOM change (there can be a brief flicker).
- The dragged window position is not persisted; reopening places the window next to the selection again.
- Interpretation consumes model quota (reasoning is turned off, output is capped around 800 tokens).

## Changelog

- **1.1.0** — explicit save bar and draft settings, custom OpenAI-compatible API with connection test, draggable result window, structured result cards, improved highlights and button alignment, model-list loading fix.
- **1.0.0** — initial release: selection interpretation, highlights, history, search, jump back, settings.

## License

[MIT](LICENSE) © 2026 ShiroiSkyy
