/**
 * Public surface of the terminal library.
 *
 * Opens shells in a window, a tab or a pane of whatever terminal the
 * person uses, types into them and asks whether they are still there.
 * The implementation lives in core (`lib/core/terminal`), its one
 * copy; this re-exports it so existing local imports keep working and
 * `agentic-harness.pi/terminal` stays what consumers import.
 */

export * from "../core/terminal/index.ts";
