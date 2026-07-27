/**
 * Say what pi install the unit suite is running under.
 *
 * Nothing here launches a subagent, but the subagent library
 * decides at module load whether the pi that started this
 * process still exists on disk, and refuses to dispatch when it
 * does not. That check reads PI_PACKAGE_DIR, which a pi session
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
 * Seeding the slot the library caches into says the parent is
 * this process. Tests that want to exercise the stale-install
 * behaviour build their own probe through
 * createSubagentHealthCheck, so nothing is hidden by this.
 */
const STARTUP_INSTALL_KEY = Symbol.for("pi.subagent.startupPiInstall");

(globalThis as Record<symbol, unknown>)[STARTUP_INSTALL_KEY] = {
	node: process.execPath,
	entry: process.execPath,
};
