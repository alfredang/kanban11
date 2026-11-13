# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file IT PMO Kanban demo app: everything lives in `index.html` (markup, `<style>`, `<script>`). There is no build, bundler, package manager, lint config or test suite. Run it by opening the file in a browser (double-click / `Start-Process index.html`); no server needed.

Quick syntax check of the script block (no test suite exists):
```bash
sed -n '/^<script>/,/^<\/script>/p' index.html | sed '1d;$d' > "$TEMP/k.js" && node --check "$TEMP/k.js"
```

## Hard constraints (from the original brief — keep honouring them)

- Vanilla HTML/CSS/JS only; no frameworks, CDNs, web fonts or image files. Icons are Unicode/inline SVG.
- **No persistence**: no `localStorage`, `sessionStorage`, IndexedDB or cookies. State is in memory and a refresh resets to seed data (the header note says so).
- No `!important` in CSS; colours/spacing come from the `:root` custom properties.
- Neutral "IT PMO" wordmark and blue palette; do not add real bank logos/trademarks. Task IDs use the required `UOB-ITPM-####` format.
- The only network call is FormSubmit (`notifyNewTask`). The notification email address must appear only in `FORMSUBMIT_ENDPOINT` (config section at the top of the script). FormSubmit needs one-time email activation per address; the activation note is an HTML comment above the `<script>`.

## Architecture

The `<script>` is divided into numbered, commented sections: config → `state` → utils → seed data → filtering → rendering → actions → form validation/FormSubmit → modal helpers → event wiring → `init()`.

Key design rules that span sections:
- `state = { tasks, filters, nextId, pendingDelete }` is the single source of truth. Mutating functions (`addTask`, `moveTask`, `deleteTask`, filter handlers) change state and then call `renderBoard()`; card/board DOM is built **only** in `renderBoard()`/`renderCard()` via string templates and a full `innerHTML` rebuild.
- Every user-supplied string must go through `escapeHtml()` before entering a template (attributes included). Toasts use `textContent`.
- Because the board is rebuilt on each render, events are **delegated** on `#board` (click, change, and all drag events) — do not attach listeners to individual cards. Focus is restored after re-render via `data-focus` keys on the Move select and delete buttons.
- The inline delete confirm ("Delete? Yes / No") is driven by `state.pendingDelete`, not a native `confirm()`.
- Move paths: native HTML5 drag-and-drop (`.drop-target` class on the hovered column) and the keyboard-accessible "Move ▸" `<select>` both end in `moveTask()`.
- Submit flow is optimistic: validate → `addTask()` (card shows immediately) → `notifyNewTask()` in try/catch. A FormSubmit failure only produces a warning toast and must never affect the board.
- Seed due dates are computed relative to today so some tasks are always overdue; seeding consumes IDs `0001`–`0008`, so new tasks start at `0009`.
