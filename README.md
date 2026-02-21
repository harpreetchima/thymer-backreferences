# Backreferences (Linked + Property References)

Adds a Roam-style **Linked References** section to the bottom of each record/page, plus Tana-style **Property References** grouped by the property name ("[Property] in...").

Built for [Thymer](https://thymer.com/) using the [Thymer Plugin SDK](https://github.com/thymerapp/thymer-plugin-sdk).

## Screenshot

![Backreferences footer screenshot](screenshot-2026-02-20_16-48-44.png)

How it works:

- Uses the Thymer search index via `data.searchByQuery()` with `@linkto = "<recordGuid>"`.
- Scans `data.getAllRecords()` and inspects record-link properties to find property references to the current record.
- Renders property-based references grouped by property name, then renders matching line items grouped by source record.

## Setup

1. In Thymer, open Command Palette (Ctrl/Cmd+P) and select `Plugins`
2. Create (or open) a **Global Plugin**
3. Paste `plugin.json` into Configuration
4. Paste `plugin.js` into Custom Code
5. Save

Note: This plugin injects its own CSS at runtime; no `plugin.css` is needed.

## Usage

- Scroll to the bottom of a page to see **Linked References**.
- If other records link to this record via a record-link property, you'll also see **Property References** grouped as "[Property] in...".
- Click a property group header to collapse/expand it (saved locally).
- Click a record header to open the source record.
- Click a reference line to open the source record and (best-effort) focus that line.
- Hold Ctrl/Cmd while clicking to open in a new panel.

Command palette:

- `Backlinks: Refresh (Active Page)` (Thymer command palette label)

## Configuration

Edit `custom` in `plugin.json`:

- `maxResults` (number): cap for search results (SDK default is 100; plugin defaults to 200)
- `collapsedByDefault` (boolean): start the footer collapsed
- `showSelf` (boolean): include references from the current record (default false)

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
4. Click "Refresh" and confirm linked reference results render and are grouped by source record.
5. Click a source record header and confirm it navigates to that record.
6. Ctrl/Cmd-click a source record header and confirm it opens in a new panel.
