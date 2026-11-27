/**
 * Say what pi install the unit suite is running under.
 *
 * Nothing here launches a subagent, but the subagent library
 * checks at each dispatch whether the pi that started this
 * process still exists on disk, and refuses to dispatch when it
 * does not. It reads that install from a snapshot taken on first
 * use, which would read PI_PACKAGE_DIR, a variable a pi session
 * exports and every child process inherits, this test runner
 * included.
 *
 * So upgrading pi mid-session turned seventy tests red at once:
 * the variable still named the old package directory, the
 * upgrade had deleted it, and the library correctly reported a
 * stale install to tests that were asking about something else
 * entirely. The check was right and the tests were wrong to be
 * consulting it.
 *
 * Seeding that snapshot says the parent is this process. The
 * seed names no package folder, so the heal at each dispatch,
 * which looks for a package only when the folder named has gone,
 * leaves it alone and never writes PI_PACKAGE_DIR. The tests of
 * the check and the heal put their own install in its place, case
 * by case, so nothing is hidden by this.
 */
const STARTUP_INSTALL_KEY = Symbol.for("pi.subagent.startupPiInstall");

(globalThis as Record<symbol, unknown>)[STARTUP_INSTALL_KEY] = {
	node: process.execPath,
	entry: process.execPath,
};
