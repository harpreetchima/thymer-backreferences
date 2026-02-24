# Backreferences (Linked + Property References)

Adds a Roam-style **Linked References** section to the bottom of each record/page, plus Tana-style **Property References** grouped by the property name ("[Property] in...").

Built for [Thymer](https://thymer.com/) using the [Thymer Plugin SDK](https://github.com/thymerapp/thymer-plugin-sdk).

## Screenshot

![Backreferences footer screenshot](screenshot-2026-02-22_15-40-24.png)

How it works:

- Uses the Thymer search index via `data.searchByQuery()` with `@linkto = "<recordGuid>"`.
- Scans `data.getAllRecords()` and inspects record-link properties to find property references to the current record.
- Renders property-based references grouped by property name, then renders matching line items grouped by source record.
- Supports in-footer sorting with page-level preferences saved locally per record.

## Setup

1. In Thymer, open Command Palette (Ctrl/Cmd+P) and select `Plugins`
2. Create (or open) a **Global Plugin**
3. Paste `plugin.json` into Configuration
4. Paste `plugin.js` into Custom Code
5. Save once after both tabs are updated

Note: This plugin injects its own CSS at runtime; no `plugin.css` is needed.

Install/update note:

- Paste order (Configuration vs Custom Code) does **not** matter.
- What matters is that both are updated before you click **Save**.
- Avoid saving after updating only one tab during upgrades, because that can briefly run mismatched code/config.

## Troubleshooting Install/Update

If Backreferences does not appear or behaves oddly after a manual paste/update:

1. Confirm plugin type is **Global Plugin**.
2. Open the same Backreferences plugin entry (avoid duplicate plugins with similar names).
3. Re-paste both files (`plugin.json` + `plugin.js`) and click **Save** once.
4. Disable the plugin, wait 2-3 seconds, then re-enable it.
5. If still stale, refresh the Thymer tab.

Common paste error:

- If you see syntax errors about `import` or `export`, make sure you pasted plain plugin code into Thymer's Custom Code field (`class Plugin ...`, no `import`/`export`).

## Usage

- Scroll to the bottom of a page to see **Linked References**.
- If other records link to this record via a record-link property, you'll also see **Property References** grouped as "[Property] in...".
- Click the search icon in the footer header to filter + highlight matches across Property References (record titles) and Linked References (line text).
- Click the sort icon (right of search) to choose ordering and Asc/Desc direction.
  - Sort By: `Page Last Edited` (default), `Reference Activity`, `Reference Count`, `Page Title`, `Page Created Date`
- Click a property group header to collapse/expand it (saved locally).
- Click a record header to open the source record.
- Click a reference line to open the source record and (best-effort) focus that line.
- Hold Ctrl/Cmd while clicking to open in a new panel.

Command palette:

- `Backreferences: Refresh (Active Page)`

## Configuration

Edit `custom` in `plugin.json`:

- `maxResults` (number): cap for search results (SDK default is 100; plugin defaults to 200)
- `collapsedByDefault` (boolean): start the footer collapsed
- `showSelf` (boolean): include references from the current record (default false)

## Sort Persistence (v1)

Current behavior:

- Sort choice is saved per page (record GUID) in browser `localStorage`.
- This keeps the preference personal and avoids changing shared workspace behavior in multiplayer setups.

Tradeoff:

- Preferences are local to the device/browser profile (not synced across devices).

Planned follow-up ideas (not in v1):

- Add an optional toggle to sync sort settings into workspace plugin config (shared across devices/users).
- Add an option to change the default sort behavior from plugin settings.

## UI Theming Guardrail

To keep Backreferences visually consistent with native Thymer popups/menus in future changes:

- Treat command-palette styling as the source of truth for menu/input surfaces.
- For popup/search colors, prefer Thymer command-palette CSS vars:
  - `--cmdpal-bg-color`
  - `--cmdpal-border-color`
  - `--cmdpal-hover-bg-color`
  - `--cmdpal-selected-bg-color`
  - `--cmdpal-selected-fg-color`
- Avoid hardcoded menu/search colors (use fallbacks only).
- Verify both dark and light themes before shipping UI style changes.

## UI Animation Notes

In the native Thymer editor, clicking the "open" arrow on an inline record reference (inserted via `@@`) triggers a short blink/flash effect on the selected link.

As of the current public Plugin SDK, that blink/flash behavior is not exposed as an API that plugins can call.

What plugins *can* use today:

- `this.ui.bounce(element)` to draw attention to a plugin-owned DOM element.
- `toaster.bounce()` on a toaster returned from `this.ui.addToaster()`.

Decision:

- Backreferences does not try to replicate the native blink effect; we'll revisit if the SDK adds a supported highlight/flash API.

## Transclude (Deferred)

Original goal: make each backlink row behave like a real transclusion so the line is editable/interactable (not just a click-only link).

Findings (SDK + official examples):

- The public Plugin SDK does not currently expose the editor's native per-line "..." menu / "Transclude" option, and it also does not provide an API to render an editable line item inside custom plugin DOM.

Known transclusion write-path (as used in the official examples):

```js
// sourceLineGuid = the GUID of the line item you want to transclude
const newItem = await record.createLineItem(null, null, 'ref', null, null);
if (newItem) await newItem.setMetaProperties({ itemref: sourceLineGuid });
```

Note: `itemref` is not currently typed in the public SDK; it is set via free-form meta properties.

Decision:

- Deferred for now (no code changes). If the SDK later exposes a supported way to embed editor-backed line items (or hook into the native line options menu), we can revisit.

## Verification Checklist

1. Open a record A that you know is referenced by other records.
2. Confirm the footer appears at the bottom with a "Backreferences" header.
3. If any records link to A via a record-link property, confirm you see a "Property References" section grouped as "[Property] in...".
4. Use Command Palette: `Backreferences: Refresh (Active Page)` and confirm linked reference results render and are grouped by source record.
5. Click a source record header and confirm it navigates to that record.
6. Ctrl/Cmd-click a source record header and confirm it opens in a new panel.
7. Open sort menu, switch sort mode and direction, and confirm order updates immediately.
8. Navigate away and back to the same page and confirm sort preference is restored.
