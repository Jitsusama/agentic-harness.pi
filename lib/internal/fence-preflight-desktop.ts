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
import { rmSync } from "node:fs";
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
	const ran = await outside(script, cwd);
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
		if (focusBefore === undefined || focusBefore !== focusAfter) {
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
 * Why the niri running the person's session isn't the one installed,
 * which has the patch putting a sandbox's windows behind, or nothing
 * when it is: a niri that started before the switch installing it is an
 * older one.
 */
async function whyNiriIsOlder(cwd: string): Promise<string | undefined> {
	const ran = await outside(
		'running=$(readlink "/proc/$(pgrep -u "$(id -u)" -f -n "niri --session")/exe"); installed=$(readlink -f "$(command -v niri)"); test -n "$running" && test "$running" = "$installed" || { echo "running $running, installed $installed"; exit 1; }',
		cwd,
	);
	return ran.code === 0 ? undefined : tailOf(ran, 1);
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
