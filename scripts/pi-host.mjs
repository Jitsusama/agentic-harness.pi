/**
 * A shared pi host's entry, as its unit starts it:
 *
 *   node scripts/pi-host.mjs attended|background|--child
 *
 * It starts the stripped-source cache before node loads any of the
 * host's TypeScript, this program's own included, so a start after an
 * install's first reads back what node stripped rather than loading
 * node's stripper (lib/internal/stripped-source.mjs). Then it runs
 * pi-host.ts, which says what each command line does.
 */

import "../lib/internal/stripped-source-start.mjs";

await import("./pi-host.ts");
