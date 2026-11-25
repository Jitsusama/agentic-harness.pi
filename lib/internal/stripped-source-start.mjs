/**
 * Starts the stripped-source cache as a module node imports first: the
 * host's entry imports it before its TypeScript, and a reviewer's
 * supervisor is started with it given to `--import`. A cache that
 * failed to start is said on stderr, and node strips as it always has.
 */

import { startStrippedSourceCache } from "./stripped-source.mjs";

const started = startStrippedSourceCache();
if (started.state === "failed")
	process.stderr.write(`no stripped-source cache: ${started.reason}\n`);
