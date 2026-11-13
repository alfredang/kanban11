# kanban11 — IT PMO Project Kanban (Demo)

**Live demo:** https://alfredang.github.io/kanban11/

A single-file Kanban board demo for an IT PMO, built with vanilla HTML/CSS/JS. All markup, styles and script live in `index.html`.

## Placeholder content
Tasks are seed/demo data (IDs `UOB-ITPM-0001`–`0008`; due dates are computed relative to today). The notification email is the placeholder `YOUR_EMAIL@example.com`.

## Run locally
Open `index.html` in a browser (`Start-Process index.html` on Windows). No server or build needed.

## Configuration
Set your notification address in **one place only**: `FORMSUBMIT_ENDPOINT` in the config section at the top of the `<script>`. FormSubmit requires a one-time email activation per address (see the HTML comment above the script); until activated, new-task notifications are not delivered (the board still works, a warning toast is shown).

## Deployment
GitHub Actions (`.github/workflows/pages.yml`) deploys the repo root to GitHub Pages on every push to `main`.

## Conventions
- Vanilla only: no frameworks, CDNs, web fonts or image assets.
- No persistence (`localStorage`, cookies, etc.); a refresh resets to seed data.
- No `!important`; colours/spacing come from `:root` custom properties.
- Every user string goes through `escapeHtml()`; board DOM is built only in `renderBoard()`/`renderCard()`; events are delegated on `#board`.

## Testing
There is no test suite. Syntax check of the script block:
```bash
sed -n '/^<script>/,/^<\/script>/p' index.html | sed '1d;$d' > "$TEMP/k.js" && node --check "$TEMP/k.js"
```
