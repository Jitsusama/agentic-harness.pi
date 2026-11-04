# Link Click Widget

Opens what a plain click lands on in pi's fullscreen, when the text
there names a place.

## Why It Exists

pi runs fullscreen, which turns mouse reporting on, so the terminal
hands pi every click. pi opens a click only when the cell holds an
OSC 8 link, and it draws one only for a markdown link, and only when
it believes the terminal shows hyperlinks. A URL in a code span or a
tool's output, a path, a pull request or a quest id opened nothing.
Joel, 4 November 2026: "clicking on links in pi does not work at all".

## What It Opens

| Clicked text                          | Opens                                           |
| ------------------------------------- | ----------------------------------------------- |
| an `http` or `https` URL              | the URL, as it is                               |
| an absolute or `~/` path that exists  | the file, as `file://`, a `:line` dropped       |
| `owner/repo#N`                        | its issue or pull request on GitHub             |
| a bare `#N`                           | the same, in the session's GitHub repo only     |
| a quest id (`QEST-...`)               | the quest's README                              |
| a document id (`PLAN-`, `RSCH-`, ...) | the document's file under its quest             |

pi's own opener (`xdg-open`, `open` on macOS) takes it from there, so
a markdown file opens in its reader and anything else in its default
program. A link pi drew itself is pi's to open, as before.

## How It Works

pi-tui offers no way to add to what a click opens, so its press is
wrapped once, on the prototype, in `lib/internal/links/press.ts`.
After pi's own press, when pi found no link under a plain left click,
the plain text of the screen pi last drew is read around the cell:
the clicked row, and the rows a word too long for its row was broken
across. The widest place the clicked character falls in that names
somewhere real becomes the link, and pi's own release opens it.

Nothing is drawn differently, so a selection copies what it did and
the model sees what it did, and the cost is a read of a few rows a
click rather than any work a frame. When pi-tui's press is not the
shape this expects, the wrap is not made, or makes no answer, and pi
behaves as it would without it.

A word broken across rows is put back together when each row but the
last is one word starting the row's text and ending in the same
column, and the next row carries on in that column. A URL or GitHub
reference is read that way only when the rows reach the screen's
right edge too; a path is read that way when the joined path exists.
