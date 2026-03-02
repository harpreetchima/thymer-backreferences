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

## Options

- **Collapse results**
  - Use the header toggle (`-` / `+`) to collapse or expand the Backreferences section.
  - Default behavior is open and expanded.

- **Change sort order**
  - `Page Last Edited`: sort by most recently edited source note.
  - `Reference Activity`: sort by most recent matching reference activity.
  - `Reference Count`: sort by number of matching references per source note.
  - `Page Title`: sort alphabetically by source note title.
  - `Page Created Date`: sort by source note creation date.
  - Direction can be `Ascending` or `Descending`.

- **Show search filter**
  - Clicking the search icon toggles a text field.
  - Typing filters mentions and highlights matching text.

- **Ignore a linked reference (shared)**
  - `Alt+Click` a linked reference line to toggle ignore on that source line.
  - Ignored lines are marked `Ignored` in the list.
  - Ignore state is written to line-item metadata key `plugin.refs.v1.ignore`, so other plugins can honor it.

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
5. Toggle search and verify filtering/highlighting.
6. Change sort field and direction and verify order updates.
7. Click a source note to navigate; Ctrl/Cmd-click to open in a new panel.
