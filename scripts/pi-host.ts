/**
 * A shared pi host, as a systemd user unit starts it, one per realm and
 * kind:
 *
 *   node scripts/pi-host.ts attended|background
 *
 * PI_PACKAGE_DIR names the host's patched pi install, and MYCELIUM_REALM
 * or PI_HOME_REALM its realm. Node runs it as it stands, stripping the
 * types, so it needs no loader. It serves until a stop signal, then
 * exits once every conversation is parked and every hold kept. It exits
 * 78 when its configuration is refused, which no restart would change,
 * and 1 on any other failure to start, which a restart might.
 */

import {
	EXIT_MISCONFIGURED,
	HostMisconfigured,
	startHostProgram,
} from "../host/service/program.ts";
import { reportToJournal } from "../host/service/run.ts";

try {
	const run = await startHostProgram({
		argv: process.argv.slice(2),
		env: process.env,
		execPath: process.execPath,
	});
	await run.stopped;
	// A screen's timers or a viewer's socket can outlive the host's stop;
	// every conversation is parked and held by now, so nothing is lost.
	process.exit(0);
} catch (error) {
	if (error instanceof HostMisconfigured) {
		// What was given is wrong, not the code, so the message is the whole story.
		process.stderr.write(`pi-host: ${error.message}\n`);
		process.exit(EXIT_MISCONFIGURED);
	}
	reportToJournal(error);
	process.exit(1);
}
