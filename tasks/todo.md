# 2026-02-23: Backreferences Sort Controls (v1)

Goal: Add sortable backreferences with per-page saved preferences in local storage. Ship v1 with requested sort options and document persistence tradeoffs.

## Plan

- [x] Confirm SDK capabilities + plugin architecture constraints and finalize v1 scope with user
- [x] Record implementation plan before coding
- [x] Implement sort state model (per-panel + per-page persistence in localStorage)
- [x] Implement sort UI controls (sort menu + Asc/Desc) in footer header
- [x] Implement sorting comparators for Property References and Linked References groups
- [x] Add per-page preference sync across open panels for the same record
- [x] Update docs with sorting behavior + persistence tradeoffs + future options
- [x] Verify behavior (manual checklist + syntax check)
- [x] Commit completed subtasks incrementally

## Review

- Added v1 sort menu with options: Page Last Edited, Reference Activity, Reference Count, Page Title, Page Created Date.
- Added Ascending/Descending controls and live re-ordering without re-fetching.
- Persisted sort preferences per record GUID in localStorage, with cross-panel sync for panels showing the same page.
- Documented persistence tradeoff (local per-device) and deferred workspace-sync/default-sort roadmap.
- Verification:
  - `node -e "const fs=require('fs'); const src=fs.readFileSync('plugin.js','utf8'); new Function(src);"` (syntax parse)
  - Node sanity check with stubbed `AppPlugin` for sort helper methods.
  - Manual Thymer UI checks still required for final visual/interaction confirmation.

---

# 2026-02-23: Install/Update Troubleshooting Docs

Goal: Clarify manual copy/paste install behavior so users do not need a "weird save order" workaround.

## Plan

- [x] Compare install order guidance across SDK/examples and current README
- [x] Identify ambiguity in Backreferences setup instructions
- [x] Add explicit install/update note (paste order not required; save after both tabs)
- [x] Add troubleshooting section with known recovery steps

## Review

- SDK/examples use mixed orders (config->code and code->config), indicating no strict order dependency.
- Updated README to reduce ambiguity and document reliable update recovery flow (re-paste both, save once, disable/enable, refresh).

---

# 2026-02-23: Sort/Search Header UI Fixes

Goal: Fix sort button visibility and prevent header layout shifts when opening search.

## Plan

- [x] Reproduce issues from user screenshots and identify root causes
- [x] Replace fragile sort icon dependency with a deterministic in-plugin glyph
- [x] Keep sort control pinned to the right of the search field when search is open
- [x] Normalize control heights and nowrap behavior to reduce header text shifting
- [x] Verify deployment state after MCP push

## Review

- Sort control now uses an internal CSS glyph instead of a missing icon font class.
- Header control order was adjusted so sort stays to the right when search opens.
- Search wrapper/button sizing was normalized and title/count nowrap was enforced to reduce visual shifting.
- Deployed via MCP to workspace plugin `Backreferences` and verified `version=0.3.1` plus code markers for glyph and control order.
