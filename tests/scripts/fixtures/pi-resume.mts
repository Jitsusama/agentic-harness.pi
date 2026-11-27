// `pi --session <id>` as pi's own session manager opens it at startup, run by node for tests/scripts/pi-carry.test.ts.
//
// Run in the folder a carried session's node enters before it starts pi,
// it finds the session as pi does: in the session folder pi derives from
// the folder it runs in, by the id in each log's header. It prints the
// session it would resume, and the folder it would resume it in, and
// fails as pi does where pi couldn't resume it unattended: no session by
// that id, one stored only for another folder (pi asks to fork it), one
// whose log opens as another session, or one whose folder is gone (pi
// asks where to run it). A held start answers no question, so each of
// those is a carry that landed and never came back to life.

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";

function fail(why: string): never {
	process.stderr.write(`${why}\n`);
	process.exit(1);
}

const { values } = parseArgs({ options: { session: { type: "string" } } });
const id = values.session ?? fail("Say which session, with --session.");
const here = process.cwd();
const file = SessionManager.findById(here, id);
if (file === undefined) {
	const elsewhere = (await SessionManager.listAll()).find(
		(session) => session.id === id,
	);
	fail(
		elsewhere === undefined
			? `No session found matching '${id}'`
			: `Session found in different project: ${elsewhere.cwd}, where pi asks to fork it into ${here}`,
	);
}
const session = SessionManager.open(file);
if (session.getSessionId() !== id) {
	fail(`${file} opened as session ${session.getSessionId()}, not ${id}`);
}
if (!existsSync(session.getCwd())) {
	fail(
		`session ${id}'s folder ${session.getCwd()} is gone, so pi asks where to run it`,
	);
}
process.stdout.write(
	`${JSON.stringify({ session: id, file, cwd: session.getCwd() })}\n`,
);
