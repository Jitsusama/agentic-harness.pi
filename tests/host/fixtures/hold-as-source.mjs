// A host's loop held in miniature, run as module source by threads-as-source.test.ts.
//
// The watch armed, profiling into the folder it is given and saying what
// it sees into a file there, the loop spun past its hold and the
// profile's start, then let go until the watch has said its last lines:
// how long the loop held and that it kept the profile, or that its thread
// failed. What it said is
// then printed, so a slow machine waits for the lines rather than
// failing on a timetable. Its arguments are the hold watch's module and
// the folder.
import { openSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [holdWatch, folder] = process.argv.slice(-2);
if (holdWatch === undefined || folder === undefined) {
	throw new Error("usage: hold-as-source.mjs HOLD_WATCH FOLDER");
}
/** Whether the watch has said all it will, whichever way it went. */
const done = (text) =>
	/the hold watch's thread failed/.test(text) ||
	(/the loop held /.test(text) &&
		/kept the held loop's profile in /.test(text));
/** How long to wait for it before printing what there is, in ms. */
const MOST_MS = 15_000;
/** How often to look for it, in ms. */
const LOOK_MS = 50;
const said = join(folder, "said");
const { watchHolds } = await import(holdWatch);
const stop = watchHolds({
	fd: openSync(said, "w"),
	every: 20,
	after: 200,
	still: 60_000,
	profile: { folder, after: 300, for: 200 },
});
const until = Date.now() + MOST_MS;
const look = () => {
	const text = readFileSync(said, "utf8");
	if (done(text) || Date.now() > until) {
		stop();
		process.stdout.write(text);
		process.exit(0);
	}
	// Not said yet: the thread profiles and keeps off this loop, so look again.
	setTimeout(look, LOOK_MS);
};
// Time for the thread to start and see the loop move before it is held.
setTimeout(() => {
	const held = Date.now() + 1200;
	while (Date.now() < held) {
		// Held, as a loop doing synchronous work is.
	}
	look();
}, 300);
