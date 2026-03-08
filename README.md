# Backreferences for Thymer

When you are writing a note, one of the first questions is: where else is this referenced?
Backreferences solves that problem by adding an always-available references panel to the active note, so you can quickly see incoming mentions and navigate to context.

Backreferences are useful for finding notes that reference the note you are writing. With Backreferences, you can see all references for the active note in one place, plus places where your note is referenced as a property value in other notes (grouped by property itself, shown as `Property in...`).

A backreference is a link from another note to the note you are currently viewing. This plugin shows both classic linked mentions and property-based references.

Built for [Thymer](https://thymer.com/) using the [Thymer Plugin SDK](https://github.com/thymerapp/thymer-plugin-sdk).

## Screenshot

![Backreferences footer screenshot](screenshot-2026-02-28_21-57-17.png)

## What It Shows

- **Property References**: references to the active note through record-link properties, grouped by property name.
- **Linked References**: line-level mentions grouped by source note.
- **Unlinked References**: text-only mentions of the active note title, grouped by source note, kept visually consistent with linked references, and loaded only after you expand that section.
- **Live Activity**: new references added after a page opens are marked in place, and remote edits are called out inline.

## Options

- **Collapse results**
  - Use the header toggle (`-` / `+`) to collapse or expand the Backreferences section.
  - Each subsection also has its own `-` / `+` toggle for hiding Property, Linked, or Unlinked references independently.
  - Default behavior is open and expanded.

- **Change sort order**
  - `Page Last Edited`: sort by most recently edited source note.
  - `Reference Activity`: sort by most recent matching reference activity.
  - `Reference Count`: sort by number of matching references per source note.
  - `Page Title`: sort alphabetically by source note title.
  - `Page Created Date`: sort by source note creation date.
  - Direction can be `Ascending` or `Descending`.

- **Use advanced filter presets**
  - `All References`: show the full footer.
  - `Tasks`: only show task backlinks.
  - `Recently Active`: only show sources updated in the last 7 days.
  - `This Collection`: only show source notes from the same collection as the active note.
  - `Mentions`: only show backlinks whose line contains a person mention.
  - `Journal Pages`: only show sources that come from journal pages.
  - Presets stack with the text search, so you can narrow first by preset and then by text.

- **Show search filter**
  - Clicking the search icon toggles a text field.
  - Typing filters mentions and highlights matching text.

- **Expand linked context**
  - Each linked mention starts with a compact `Show more context` control.
  - Clicking it expands the full child subtree for that mention and exposes up/down controls for nearby sibling lines.

- **Review unlinked mentions**
  - Text mentions of the current note title appear in a separate `Unlinked References` section.
  - That section starts collapsed and only runs its title-search query after you expand it.
  - The section reuses the existing search, sort, grouping, and context controls instead of adding a separate interaction model.

- **Compact empty state**
  - When a page has no references yet, the footer stays minimal until you click `Show sections`.

- **Live activity mode**
  - The status bar shows the active page's current backreference count.
  - `New` marks references that appeared since the page was opened.
  - `Changed` marks references updated remotely after the footer had already loaded.

## Command

- `Backreferences: Refresh (Active Page)`

## Setup

1. In Thymer, open Command Palette (`Ctrl/Cmd+P`) and choose `Plugins`.
2. Create (or open) a **Global Plugin** entry.
3. Paste `plugin.json` into Configuration.
4. Paste `plugin.js` into Custom Code.
5. Save once after both tabs are updated.

Note: this plugin injects CSS at runtime; there is no separate `plugin.css` file.

## Configuration

Edit `custom` in `plugin.json`:

- `maxResults` (number): cap for search results.
- `showSelf` (boolean): include references originating from the active note.

## Verification Checklist

1. Open a note that is referenced elsewhere.
2. Confirm Backreferences appears at the bottom.
3. Confirm Property References are grouped by property when applicable.
4. Confirm Linked References are grouped by source note.
5. Confirm Unlinked References appear separately when the note title is mentioned without a record link.
6. Choose an advanced preset and verify the footer narrows to the expected sources.
7. Toggle search and verify filtering/highlighting.
8. Change sort field and direction and verify order updates.
9. Expand a linked or unlinked reference and verify descendants load first, then above/below context can be added with the arrow controls.
10. Make or receive a new reference while the page stays open and verify `New` / `Changed` badges update.
11. Confirm the status bar count matches the footer.
12. Click a source note to navigate; Ctrl/Cmd-click to open in a new panel.
