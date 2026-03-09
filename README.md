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

- **Use the filter button + query bar**
  - The header keeps `Filter` and `Sort` pinned in the top-right.
  - Clicking `Filter` reveals the query bar on its own row below the header.
  - The query bar borrows Thymer's native collection-filter styling and only shows the accent outline while focused.
  - Query autocomplete supports collections, built-in keys, users, and collection properties; long property lists stay scrollable in a native-style dropdown.
  - Plain text keeps the lightweight local filter behavior.
  - Query syntax like `@task`, `@Journey`, `"exact phrase"`, and `foo AND bar` uses Thymer's search language, but stays scoped to the current page's backreferences.
  - Record-level queries narrow Property References and Linked References together.
  - Unlinked References join the scoped query only when that section is expanded.
  - Plain-text matches still highlight inside rendered titles and lines.

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
6. Confirm only the Filter and Sort buttons appear in the header's top-right before the filter bar is opened.
7. Click `Filter` and verify the query bar appears on its own row below the header.
8. Focus the query bar and verify the accent outline appears only while focused.
9. Type `@Sources`, accept the collection autocomplete, and verify the query remains `@Sources` rather than `@@Sources`.
10. Type `@Sources.` and verify all properties are available in a scrollable autocomplete list.
11. Type plain text and verify the footer filters/highlights matching titles and lines.
12. Type query syntax such as `@task`, `@Journey`, and `foo AND bar` and verify only matching backreferences remain.
13. Expand `Unlinked References`, repeat a query, and verify that section joins the scoped results.
14. Change sort field and direction and verify order updates.
15. Expand a linked or unlinked reference and verify descendants load first, then above/below context can be added with the arrow controls.
16. Make or receive a new reference while the page stays open and verify `New` / `Changed` badges update.
17. Confirm the status bar count matches the footer.
18. Click a source note to navigate; Ctrl/Cmd-click to open in a new panel.
