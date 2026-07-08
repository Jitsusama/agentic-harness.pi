# Mermaid Widget

Renders Mermaid diagram source to a PNG through the shared headless
browser and returns it to the agent.

## What It Does

Registers one tool, `render_mermaid`, that the agent calls in
conversation. Given Mermaid source, it renders the diagram to a PNG and
returns both the file path (to open or embed in a quest planning
document) and the image inline, so a vision model can see the result.

There is no slash command. The agent invokes the tool when asked to draw
or visualize something as a diagram.

## How It Works

Rendering loads the pinned Mermaid library into the shared `lib/web`
headless browser, renders the source to SVG, and rasterizes the SVG
element to PNG. Because it rides the shared browser, it inherits the
hardened lifecycle from the web retrieval work rather than launching and
managing its own browser.

Rendering needs internet access to fetch the Mermaid library from
jsDelivr. Invalid diagram source returns a clear error rather than a
broken image.

## Category

Widget: it renders and displays agent content. It leans on `lib/web` for
the browser and returns the artifact as a file plus an inline image.
