// A host's loop held in miniature, run as module source by threads-as-source.test.ts.
//
// The watch armed, profiling into the folder it is given, the loop spun
// past its hold and the profile's start, then let go long enough for the
// thread to say how long it held. Its arguments are the hold watch's
// module and the folder.
const [holdWatch, folder] = process.argv.slice(-2);
if (holdWatch === undefined || folder === undefined) {
	throw new Error("usage: hold-as-source.mjs HOLD_WATCH FOLDER");
}
const { watchHolds } = await import(holdWatch);
const stop = watchHolds({
	fd: 1,
	every: 20,
	after: 200,
	still: 60_000,
	profile: { folder, after: 300, for: 200 },
});
// Time for the thread to start and see the loop move before it is held.
setTimeout(() => {
	const until = Date.now() + 1200;
	while (Date.now() < until) {
		// Held, as a loop doing synchronous work is.
	}
	// Time, once the loop turns again, for the thread to say the hold ended.
	setTimeout(() => {
		stop();
		process.exit(0);
	}, 600);
}, 300);
