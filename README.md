# figmore

A Figma-like visual editor for **HTML & CSS**. Build pages from real HTML tags,
lay them out with CSS flexbox, edit `:hover` styles, and manage several projects.

- **Go backend** (stdlib `net/http` + SQLite via `modernc.org/sqlite`, no cgo) stores projects and serves the UI.
- **Vanilla JS front-end** (ES modules, no build step), embedded in the binary.

## Run

```sh
go run . -addr 127.0.0.1:8080 -db figmore.db
```

Open <http://127.0.0.1:8080>.

## Features

- **Projects**: create, rename, duplicate, delete, autosave.
- **Import / export**: a project exports to `*.figmore.json` and can be imported back (button or drop the file on the project list).
- **Elements**: div, section, header, nav, main, article, aside, footer, form, h1–h6, p, span, a, ul/ol/li, img, button, input, textarea, label, hr, plus ready-made flex Row / Column. Click to add, or drag onto the canvas or layers panel.
- **Layers**: tree with drag-and-drop reordering/nesting (HTML content-model aware: `li` only in lists, etc.).
- **Properties**: flexbox (direction, wrap, justify, align, gap, grow/shrink/basis, align-self, order), grid basics, size, margin/padding per side, position, typography, background, border, effects, and a free-form "Custom CSS" editor.
- **Hover editing**: switch the panel to `:hover` to edit the hover style; the canvas forces the hover look on the selected element. **Preview** mode shows real hover.
- Undo/redo, copy/paste, duplicate, wrap, responsive canvas widths.

Shortcuts: `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo, `Ctrl+D` duplicate, `Ctrl+G` wrap, `Ctrl+C`/`Ctrl+V`, `Del`, `Alt+↑/↓` reorder, `Esc` select parent.

## Test

```sh
go test ./...
```
