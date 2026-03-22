# Content Viewer Extension

View files in a scrollable, themed overlay. It auto-detects the
content type (markdown, diff, code) and applies appropriate
colouring.

## Commands

| Command | Description |
|---------|-------------|
| `/view <path>` | View a file in a scrollable overlay |

## How It Works

The `/view` command reads the file, detects its content type
from the file extension and presents it using `showContent`
from the shared content renderer. Scroll with Shift+↑↓ or
PageUp/PageDown; dismiss with Escape or Enter on Close.

Content types:
- **Markdown** (`.md`): headers, lists, blockquotes, code
  fences with themed colouring.
- **Diff** (`.diff`, `.patch`): +/- line colouring, hunk
  headers.
- **Code** (`.ts`, `.py`, `.rs`, etc.): line numbers with
  gutter.
