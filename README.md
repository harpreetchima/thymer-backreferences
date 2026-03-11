# Backreferences for Thymer

When you are writing a note, one of the first questions is: where else is this referenced?
Backreferences solves that problem by adding an always-available references panel to the active note, so you can quickly see incoming mentions and navigate to context.

Backreferences are useful for finding notes that reference the note you are writing. With Backreferences, you can see all references for the active note in one place, plus places where your note is referenced as a property value in other notes (grouped by property itself, shown as `Property in...`).

A backreference is a link from another note to the note you are currently viewing. This plugin shows both classic linked mentions and property-based references.

Built for [Thymer](https://thymer.com/) using the [Thymer Plugin SDK](https://github.com/thymerapp/thymer-plugin-sdk).

## Screenshot

![Backreferences footer screenshot](screenshots/screenshot-2026-03-09_17-20-23.png)

## Credits

- Credit to [@ahpatel](https://github.com/ahpatel) and the fork [ahpatel/thymer-backreferences](https://github.com/ahpatel/thymer-backreferences) for the unlinked references and collapsible header work that informed this plugin.

## What It Shows

- **Property References**: references to the active note through record-link properties, grouped by property name.
- **Linked References**: line-level mentions grouped by source note.
- **Unlinked References**: text-only mentions of the active note title, grouped by source note, kept visually consistent with linked references, and loaded only after you expand that section.
- **Direct line navigation**: clicking a linked, unlinked, or expanded-context row asks Thymer to scroll to and highlight the exact source line, including when Ctrl/Cmd-click opens it in a new panel.
- **Live Activity**: new references added after a page opens are marked in place, and remote edits are called out inline.

## Options

- **Collapse results**
  - Use the header chevron to collapse or expand the Backreferences section.
  - Each subsection also has its own chevron toggle for hiding Property, Linked, or Unlinked references independently.
  - Pages remember footer + section collapse choices individually.
  - Without a saved page override, the full footer starts collapsed when there are no linked/property references yet, and `Property References` / `Linked References` start collapsed when they have zero matches.

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
  - The input placeholder now shows that you can either type plain text or a Thymer query.
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
  - Source-note groups in both `Linked References` and `Unlinked References` can be collapsed per page.

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

## Local Checks

- `node --check plugin.js`
- `node scripts/refactor-smoke.js`

## Verification Checklist

1. Open a note that is referenced elsewhere.
2. Confirm Backreferences appears at the bottom.
3. Confirm the top summary stays compact while each section header shows its own ref count.
4. Open a note with no linked/property refs and confirm the full footer starts collapsed by default.
5. Open notes with zero property refs or zero linked refs and confirm those empty sections start collapsed by default.
6. Change the footer or section collapse state for one note, navigate away, return, and confirm that page-specific choice persists.
7. Confirm Property References are grouped by property with an outside-chevron collapse toggle when applicable.
8. Confirm property records and linked rows sit visibly nested under their parent property/source headers.
9. Confirm Linked References are grouped by source note.
10. Confirm Unlinked References appear separately when the note title is mentioned without a record link.
11. Confirm linked rows hover/focus as a single row while the context controls remain independently clickable.
12. Confirm only the Filter and Sort buttons appear in the header's top-right before the filter bar is opened.
13. Click `Filter` and verify the query bar appears on its own row below the header.
14. Confirm the query bar copy makes it clear that plain text and Thymer query syntax are both supported.
15. Focus the query bar and verify the accent outline appears only while focused.
16. Type `@Sources`, accept the collection autocomplete, and verify the query remains `@Sources` rather than `@@Sources`.
17. Type `@Sources.` and verify all properties are available in a scrollable autocomplete list.
18. Type plain text and verify the footer filters/highlights matching titles and lines.
19. Type query syntax such as `@task`, `@Journey`, and `foo AND bar` and verify only matching backreferences remain.
20. Expand `Unlinked References`, repeat a query, and verify that section joins the scoped results.
21. Change sort field and direction and verify order updates.
22. Collapse and re-expand a linked group and an unlinked group and verify the per-page toggle only hides that group's rows.
23. Expand a linked or unlinked reference and verify descendants load first, then above/below context can be added with the arrow controls.
24. Make or receive a new reference while the page stays open and verify `New` / `Changed` badges update.
25. Confirm the status bar count matches the footer.
26. Click a source note to navigate; Ctrl/Cmd-click to open in a new panel.
27. Click a linked, unlinked, or context line row and verify Thymer scrolls to and highlights the exact source line.
28. Ctrl/Cmd-click a linked, unlinked, or context line row and verify the new panel opens with the exact source line highlighted.
