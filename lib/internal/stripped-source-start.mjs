/**
 * Starts the stripped-source cache as a module node imports first: the
 * host's entry imports it before its TypeScript, and a reviewer's
 * supervisor is started with it given to `--import`. A cache that
 * failed to start, or can't keep what it strips, is said on stderr, and
 * node strips as it always has. A host's journal keeps what it says; a
 * supervisor's stderr is kept only as its run's tail, and a detached
 * one's nowhere; where a host runs, its own start judges and closes the
 * same folders above each install's, so what fails them is said there.
 */

import { startStrippedSourceCache } from "./stripped-source.mjs";

const started = startStrippedSourceCache({
	report: (said) => process.stderr.write(`${said}\n`),
});
if (started.state === "failed")
	process.stderr.write(`no stripped-source cache: ${started.reason}\n`);
