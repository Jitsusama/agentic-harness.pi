# Mermaid Widget

Renders Mermaid diagram source to a crisp SVG plus a vision-capped PNG
through the shared headless browser and returns them to the agent.

## What It Does

Registers one tool, `render_mermaid`, that the agent calls in
conversation. Given Mermaid source, it writes two files that share a
base name: an SVG (the vector artifact, crisp at any zoom, for a human
to read) and a PNG scaled toward the vision-model pixel budget without
crossing it. The result carries both paths plus the PNG inline, so a
vision model can see the diagram and the SVG can be embedded or opened.

When a human is at an interactive session, the PNG is opened in the OS
image viewer. A diagram cannot be shown in the terminal content viewer
or an nvim text buffer, and a PNG maps to an image viewer on every
desktop (the default SVG handler is often a text editor), so the
high-resolution PNG is what opens. The SVG path is returned alongside
for when a dense diagram wants infinite zoom in a browser. Subagent and
headless runs skip the open: they have no display and only want the
payload.

There is no slash command. The agent invokes the tool when asked to draw
or visualize something as a diagram.

## How It Works

Rendering loads the pinned Mermaid library into the shared `lib/web`
headless browser and renders the source to SVG. The SVG's intrinsic
size is read from its viewBox, the PNG scale is chosen so the rasterized
dimensions fill the pixel budget without crossing the long-edge or
megapixel cap, and the SVG is rasterized to PNG at that size. Both files
are written only after a successful capture, so a mid-render failure
leaves nothing behind. Because it rides the shared browser, it inherits
the hardened lifecycle from the web retrieval work rather than launching
and managing its own browser.

Rendering needs internet access to fetch the Mermaid library from
jsDelivr. Invalid diagram source returns a clear error rather than a
broken image.

## Category

Widget: it renders and displays agent content. It leans on `lib/web` for
the browser and returns the artifact as a file plus an inline image.
