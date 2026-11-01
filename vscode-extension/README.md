# JARVIS VS Code extension

Sidebar client for the local JARVIS coding agent (`/api/agent`). It holds no AI logic: it sends task requests plus capped editor context, polls task state, and renders approvals, checks and diffs.

## Build

```sh
cd vscode-extension
npm install
npm run typecheck   # tsc --noEmit
npm run compile     # emits ./out
npm test            # node:test via tsx; client tests use a real loopback HTTP server
npm run package     # produces jarvis-coding-agent-0.1.0.vsix (needs network for npx @vscode/vsce)
```

## Install

`code --install-extension jarvis-coding-agent-0.1.0.vsix`, or in VS Code: Extensions → `…` → *Install from VSIX…*.
For development, open `vscode-extension/` in VS Code and press F5.

## Connect

1. Start the JARVIS app from the repo root (`npm run dev`) and open the repo as your VS Code workspace folder.
2. The backend creates `.jarvis/agent-token` (mode 0600) only when `/api/agent` first receives a request — starting the app alone does not. Bootstrap it once: `curl -i http://127.0.0.1:3000/api/agent` (a `401` reply is expected and still creates the token). The extension reads that file; nothing is hardcoded or stored in settings.
3. Settings: `jarvis.serverUrl` (loopback only, default `http://127.0.0.1:3000`), `jarvis.tokenPath` (optional override), `jarvis.pollIntervalMs`.
4. Make sure `.jarvis/` is git-ignored.

## Security notes

- Only loopback server URLs are accepted; the bearer token is read from disk per request and never logged.
- Editor context is capped before sending (selection 2000 chars, file 4000 chars, 20 diagnostics).
- Webview uses a per-render CSP nonce; all repo-derived text is HTML-escaped.
- Revert asks for modal confirmation. The `snapshot` endpoint only serves files the task changed.
