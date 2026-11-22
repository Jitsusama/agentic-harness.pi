/**
 * A shared pi host, as a systemd user unit starts it, one per realm and
 * kind:
 *
 *   node scripts/pi-host.ts attended|background
 *
 * PI_PACKAGE_DIR names the host's patched pi install, and MYCELIUM_REALM
 * or PI_HOME_REALM its realm. Node runs it as it stands, stripping the
 * types, so it needs no loader; every pi import the harness makes is
 * bound to that install before the host's code loads, and what node
 * compiles of it is kept for the install's next start. It serves until a
 * stop signal, then exits once every conversation is parked and every
 * hold kept. It exits 78 when its configuration is refused, which no
 * restart would change, and 1 on any other failure to start, which a
 * restart might. A Mac's, which launchd runs, exits 75 once it stopped
 * to be started again on a new harness or pi, or for its heap, and 0 once
 * a stop signal came. launchd starts it again after any exit but 0, 78
 * and 1 included, the start script waiting ten minutes after three starts
 * in ten, so only a stop that parks cleanly, or a bootout, keeps it down.
 *
 * A supervisor starts a child host for one conversation the same way:
 *
 *   node scripts/pi-host.ts --child
 *
 * with PI_HOST_CHILD_KEY and PI_HOST_CHILD_SOCKET naming its slot
 * (host/service/child.ts). It exits once its conversation ends, 0 when
 * it was parked, closed or released, and 1 when it failed or its stop ran
 * out of time before the conversation parked. It exits 78 when its slot
 * or environment is refused, before it listens or says any ending.
 */

import { flushCompileCache, registerHooks } from "node:module";
import { dirname, isAbsolute } from "node:path";
import { startCompileCache } from "../host/service/compile-cache.ts";
import { piFromHost } from "../host/service/pi-resolution.ts";
import { keepCompileCacheOutOfReach } from "../lib/internal/fence/compile-cache-place.ts";

// First, so every module the host loads after is compiled once an install.
const compiled = startCompileCache({
	argv: process.argv.slice(2),
	env: process.env,
	harnessRoot: dirname(import.meta.dirname),
});
if (compiled.state === "off")
	process.stderr.write(`pi-host: no compile cache: ${compiled.reason}\n`);
// Every pi the host starts compiles where the fence can't write either.
keepCompileCacheOutOfReach({
	set: (name, value) => {
		process.env[name] = value;
	},
});

const packageDir = process.env.PI_PACKAGE_DIR;
// Without an absolute install there is nothing to bind to; the program
// refuses that itself, with the status a unit reads.
if (packageDir && isAbsolute(packageDir))
	registerHooks({ resolve: piFromHost(packageDir) });

// Loaded only now, so the host's code binds pi through the hook above.
const {
	EXIT_MISCONFIGURED,
	exitStatusOf,
	HostMisconfigured,
	startHostProgram,
} = await import("../host/service/program.ts");
const { reportToJournal } = await import("../host/service/run.ts");

try {
	const run = await startHostProgram({
		argv: process.argv.slice(2),
		env: process.env,
	});
	// Node writes its cache at exit, which a killed host never reaches.
	if (compiled.state === "on") flushCompileCache();
	await run.stopped;
	// A child's ending is settled before its stop begins.
	const failed = (await run.ending) === "failed";
	// A screen's timers or a viewer's socket can outlive the host's stop;
	// every conversation is parked and held by now, so nothing is lost.
	process.exit(exitStatusOf({ failed, restarts: run.restarts?.() ?? false }));
} catch (error) {
	if (error instanceof HostMisconfigured) {
		// What was given is wrong, not the code, so the message is the whole story.
		process.stderr.write(`pi-host: ${error.message}\n`);
		process.exit(EXIT_MISCONFIGURED);
	}
	reportToJournal(error);
	process.exit(1);
}
