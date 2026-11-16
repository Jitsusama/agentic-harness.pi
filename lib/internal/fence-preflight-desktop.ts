/**
 * The pre-flight's checks of the person's desktop (`fence-preflight.ts`):
 * a fenced copy and paste, and a fenced window, each leaving his focus
 * and his workspace where they were.
 *
 * A check that touches the clipboard saves the person's selection first
 * and puts it back after, and works on the primary selection, so nothing
 * he copied is lost (ISXEG8, e0410496). A check that opens a window
 * opens one only on a niri that has the patch putting a sandbox's
 * windows behind (core's `sandboxed-windows-stay-behind.patch`), since
 * an older one would focus it on the workspace he's using.
 */

import { randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import {
	failed,
	fenced,
	outside,
	type PreflightContext,
	passed,
	tailOf,
	type Verdict,
} from "./fence-preflight.ts";

/**
 * Names niri's socket for `niri msg` where the environment doesn't: a pi
 * started outside the session (a host, or one restarted after a reboot)
 * has no `NIRI_SOCKET`, and every question to niri would go unanswered.
 * The session's niri names its socket for its own process ID.
 */
const NIRI_SOCKET_FOUND =
	'if [ -z "$NIRI_SOCKET" ]; then NIRI_SOCKET=$(find "$XDG_RUNTIME_DIR" -maxdepth 1 -type s -name "niri.*.$(pgrep -u "$(id -u)" -xa niri | awk \'NF == 3 && $3 == "--session" { print $1; exit }\').sock" -print -quit); export NIRI_SOCKET; fi; ';

/** The app ID of the window the window check opens. */
const PREFLIGHT_WINDOW = "pi.fence.preflight";

/** How long the fenced window stays open before it closes itself, in seconds. */
const WINDOW_OPEN_S = 4;

/** How long the window may take to appear in niri's list. */
const WINDOW_LIMIT_MS = 15_000;

/** How often niri's list is read while the window is awaited. */
const LOOK_EVERY_MS = 250;

/**
 * How long after the window appears its focus is read again: niri
 * settles an opening window's focus at its first commit, a frame or two
 * after it is listed.
 */
const SETTLE_MS = 500;

/** The JSON niri answers `script` with, or nothing when it doesn't. */
async function niriAnswer(script: string, cwd: string): Promise<unknown> {
	const ran = await outside(`${NIRI_SOCKET_FOUND}${script}`, cwd);
	if (ran.code !== 0) return undefined;
	try {
		return JSON.parse(ran.out);
	} catch {
		// Not JSON: niri answered something else, which says nothing.
		return undefined;
	}
}

/** A number field of a niri object, or nothing when it has none. */
function numberIn(value: unknown, field: string): number | undefined {
	if (typeof value !== "object" || value === null || !(field in value)) {
		return undefined;
	}
	const found: unknown = Reflect.get(value, field);
	return typeof found === "number" ? found : undefined;
}

/** The id of the focused window, or nothing when niri doesn't say. */
export async function focusedWindow(cwd: string): Promise<number | undefined> {
	return numberIn(await niriAnswer("niri msg -j focused-window", cwd), "id");
}

/** The windows niri has open, or nothing when it doesn't say. */
async function openWindows(cwd: string): Promise<unknown[] | undefined> {
	const windows = await niriAnswer("niri msg -j windows", cwd);
	return Array.isArray(windows) ? windows : undefined;
}

/** How many windows niri has open, or nothing when it doesn't say. */
async function windowCount(cwd: string): Promise<number | undefined> {
	return (await openWindows(cwd))?.length;
}

/** The id of the focused workspace, or nothing when niri doesn't say. */
async function focusedWorkspace(cwd: string): Promise<number | undefined> {
	const workspaces = await niriAnswer("niri msg -j workspaces", cwd);
	if (!Array.isArray(workspaces)) return undefined;
	const focused: unknown = workspaces.find(
		(workspace: unknown) =>
			typeof workspace === "object" &&
			workspace !== null &&
			"is_focused" in workspace &&
			workspace.is_focused === true,
	);
	return numberIn(focused, "id");
}

/** The window with `appId` in niri's list, once it is there. */
async function windowNamed(
	appId: string,
	cwd: string,
): Promise<unknown | undefined> {
	const deadline = Date.now() + WINDOW_LIMIT_MS;
	while (Date.now() < deadline) {
		const found = (await openWindows(cwd))?.find(
			(window: unknown) =>
				typeof window === "object" &&
				window !== null &&
				"app_id" in window &&
				window.app_id === appId,
		);
		if (found !== undefined) return found;
		await wait(LOOK_EVERY_MS);
	}
	return undefined;
}

/** Check (1): a fenced copy and paste, with the person's selection kept. */
export async function clipboardRoundTrip(
	context: PreflightContext,
): Promise<Verdict> {
	const { scratch, session } = context;
	const line = `preflight-${randomUUID().slice(0, 8)}`;
	const kept = join(scratch, "primary-kept");
	const saved = await outside(
		`wl-paste --primary -n > ${kept} 2>/dev/null`,
		scratch,
	);
	const focusBefore = await focusedWindow(scratch);
	const windowsBefore = await windowCount(scratch);
	try {
		const copy = await fenced(
			`printf %s '${line}' | wl-copy --primary > /dev/null 2>&1`,
			scratch,
			session,
		);
		const paste = await fenced("wl-paste --primary -n", scratch, session);
		const focusAfter = await focusedWindow(scratch);
		const windowsAfter = await windowCount(scratch);
		if (copy.code !== 0) return failed(`wl-copy failed: ${tailOf(copy)}`);
		if (paste.out !== line) {
			return failed(`wl-paste gave back ${JSON.stringify(paste.out)}`);
		}
		if (focusBefore === undefined) {
			return failed(
				"niri named no focused window, so a moved focus couldn't be told: run it with a window focused",
			);
		}
		if (focusBefore !== focusAfter) {
			return failed(`focus moved, from ${focusBefore} to ${focusAfter}`);
		}
		if (windowsBefore === undefined || windowsBefore !== windowsAfter) {
			return failed(`windows went from ${windowsBefore} to ${windowsAfter}`);
		}
		return passed(
			`round-tripped on the primary selection in ${copy.ms + paste.ms} ms, focus and windows unchanged`,
		);
	} finally {
		// setsid, so the copy serving his selection outlives this script
		// and anything that stops it.
		await outside(
			saved.code === 0
				? `setsid -f wl-copy --primary < ${kept} > /dev/null 2>&1`
				: "wl-copy --primary --clear",
			scratch,
		);
		rmSync(kept, { force: true });
	}
}

/**
 * The program the person's session runs as its niri, from what
 * `pgrep -xa niri` lists (a process ID, then its command line): the one
 * started with `--session` alone, never a client of it such as the
 * launcher's `niri msg event-stream`. Nothing when none is listed.
 *
 * It reads the command line rather than `/proc/<pid>/exe`, which niri,
 * keeping its capabilities, doesn't let its own account read, and it
 * goes by the process's name rather than its words (`pgrep -f`), which
 * the shell asking matches too (85PKB2, 22cea56d).
 */
export function sessionNiri(listing: string): string | undefined {
	for (const line of listing.split("\n")) {
		const [, program, ...words] = line.trim().split(/\s+/);
		if (program !== undefined && words.join(" ") === "--session") {
			return program;
		}
	}
	return undefined;
}

/** Where a path leads, or the path itself when it leads nowhere. */
function resolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// A program that's gone since it started is compared as named,
		// which can only make it differ from the one installed.
		return path;
	}
}

/**
 * Why the niri running the person's session isn't the one installed,
 * which has the patch putting a sandbox's windows behind, or nothing
 * when it is: a niri that started before the switch installing it is an
 * older one.
 */
async function whyNiriIsOlder(cwd: string): Promise<string | undefined> {
	const [listing, installed] = await Promise.all([
		outside('pgrep -u "$(id -u)" -xa niri', cwd),
		outside('readlink -f "$(command -v niri)"', cwd),
	]);
	const running = sessionNiri(listing.out);
	const wanted = installed.out.trim();
	if (running === undefined) return "no niri runs a session";
	if (wanted === "") return "no niri is installed";
	return resolved(running) === wanted
		? undefined
		: `running ${running}, installed ${wanted}`;
}

/** Check (1b): a fenced window opens behind, the person's focus unmoved. */
export async function windowBehind(
	context: PreflightContext,
): Promise<Verdict> {
	const { scratch, session } = context;
	const older = await whyNiriIsOlder(scratch);
	if (older !== undefined) {
		return failed(
			`niri is older than the one installed (${older}), so it would focus the window: log in again first`,
		);
	}
	const display = await fenced('test -S "$WAYLAND_DISPLAY"', scratch, session);
	if (display.code !== 0) return failed("no sandboxed display inside");
	const focusBefore = await focusedWindow(scratch);
	const workspaceBefore = await focusedWorkspace(scratch);
	const started = Date.now();
	const opening = fenced(
		`kitty --config NONE --class ${PREFLIGHT_WINDOW} sh -c 'sleep ${WINDOW_OPEN_S}'`,
		scratch,
		session,
	);
	const window = await windowNamed(PREFLIGHT_WINDOW, scratch);
	const appeared = Date.now() - started;
	await wait(SETTLE_MS);
	const focusAfter = await focusedWindow(scratch);
	const workspaceAfter = await focusedWorkspace(scratch);
	const ran = await opening;
	if (window === undefined) {
		return failed(`no fenced window appeared: ${tailOf(ran)}`);
	}
	if (focusBefore !== focusAfter) {
		return failed(`focus moved, from ${focusBefore} to ${focusAfter}`);
	}
	if (workspaceBefore === undefined || workspaceBefore !== workspaceAfter) {
		return failed(
			`the focused workspace went from ${workspaceBefore} to ${workspaceAfter}`,
		);
	}
	const on = numberIn(window, "workspace_id");
	if (on === undefined || on === workspaceBefore) {
		return failed(`the window opened on the focused workspace ${on}`);
	}
	return passed(
		`a fenced window opened on workspace ${on}, behind, in ${appeared} ms; focus and workspace unchanged`,
	);
}

/**
 * Tries X's display :0 both ways it listens, the file under
 * /tmp/.X11-unix and the abstract socket of the same name, printing
 * `connected <way>` or `refused <way> <code>` for each. The abstract
 * name begins with a NUL, which a shell argument can't carry, so node
 * makes it.
 */
const X_PROBE = `node -e '${[
	'const net = require("node:net");',
	'const ways = { file: "/tmp/.X11-unix/X0", abstract: String.fromCharCode(0) + "/tmp/.X11-unix/X0" };',
	"for (const [way, path] of Object.entries(ways)) {",
	"const s = net.connect({ path });",
	's.on("connect", () => { process.stdout.write("connected " + way + "\\n"); s.destroy(); });',
	's.on("error", (e) => process.stdout.write("refused " + way + " " + e.code + "\\n"));',
	"}",
].join(" ")}'`;

/** The ways the X probe tried, as it names them. */
const X_WAYS = ["file", "abstract"] as const;

/** The ways `said`, the X probe's output, says it connected. */
function xReached(said: string): string[] {
	return X_WAYS.filter((way) => said.includes(`connected ${way}`));
}

/**
 * Judges check (15d) from what the X probe said outside the fence and
 * inside: inside must reach no X socket, and must have said so for
 * each, so a probe that never ran isn't read as refused. Outside says
 * whether an X server listens at all.
 */
export function xDisplayJudged(
	outsideSaid: string,
	insideSaid: string,
): Verdict {
	const reached = xReached(insideSaid);
	if (reached.length > 0) {
		return failed(
			`a fenced command reached X's ${reached.join(" and ")} socket`,
		);
	}
	const unsaid = X_WAYS.filter((way) => !insideSaid.includes(`refused ${way}`));
	if (unsaid.length > 0) {
		return failed(
			`the probe said nothing inside of the ${unsaid.join(" and ")} socket`,
		);
	}
	const listening = xReached(outsideSaid);
	return listening.length === 0
		? passed("no X server listens here, and none was reached inside")
		: passed(
				`X answers outside (${listening.join(", ")}) and refuses a fenced command on every socket`,
			);
}

/**
 * Check (15d): X's sockets stay out, so a copy xwayland-satellite
 * bridges to X can't be read through it (ISXEG8, 120e6f5d).
 */
export async function xDisplayOut(context: PreflightContext): Promise<Verdict> {
	const { scratch, session } = context;
	const plain = await outside(X_PROBE, scratch);
	const inside = await fenced(X_PROBE, scratch, session);
	return xDisplayJudged(plain.out, inside.out);
}
