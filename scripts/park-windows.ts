/**
 * List, or close, the windows of pi sessions already parked, under the
 * checks a park makes as it closes its own (lib/internal/session/
 * park-desktop.ts): never one focused or in sight, nor on what the
 * screen last showed while it's off, never one niri can't place, and
 * only once the launcher has kept its place asleep.
 *
 * Parks from before park-workflow closed windows left theirs open, so
 * this sweeps them once. With no argument it closes nothing and prints a
 * JSON line for each parked session with a window: its address, hold,
 * windows and what would become of them. With `--close` and a session's
 * address, pi session id or hold id, or `all`, it closes those that may
 * close, one at a time, and reads niri's focused window and workspace
 * before and after each, stopping at once should either move. With
 * `--screen` and two files holding what `niri msg -j windows` and
 * `niri msg -j workspaces` printed at another time, it judges by that
 * screen instead, closing nothing. With `--running`, it lists the
 * running held pis too, judged as if each parked now; it never closes
 * one.
 *
 * It asks niri, the launcher and the sessions kitty directly, which the
 * agent fence keeps from every command an agent runs, so it runs outside
 * the fence. Node runs it as it stands, stripping the types:
 *
 *   node scripts/park-windows.ts
 *   node scripts/park-windows.ts --running --screen windows.json workspaces.json
 *   node scripts/park-windows.ts --close VKCF3Z
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
	closeWindow,
	KEPT,
	keepPlaceAsleep,
	machineDesk,
	onNiri,
	readScreen,
} from "../lib/internal/session/park-desktop.ts";
import {
	type ParkedWindows,
	parkedWindowsOf,
	type Screen,
	screenOf,
	screenOff,
	windowVerdict,
} from "../lib/internal/session/park-window.ts";

const desk = machineDesk();

function jsonLines(text: string): unknown[] {
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

function mycelium(verb: string): unknown[] {
	return jsonLines(
		execFileSync("mycelium", [verb], { encoding: "utf8", timeout: 10_000 }),
	);
}

/** The node's session rows, from `mycelium sessions`'s `{Ok: {Sessions}}`. */
function sessionRows(): unknown[] {
	return mycelium("sessions").flatMap((line) => {
		const ok =
			typeof line === "object" && line !== null && "Ok" in line
				? line.Ok
				: undefined;
		const rows =
			typeof ok === "object" && ok !== null && "Sessions" in ok
				? ok.Sessions
				: undefined;
		return Array.isArray(rows) ? rows : [];
	});
}

/** What has Joel's focus: the window and the workspace, by niri's ids. */
function focusOf(screen: Screen): string {
	const window = screen.windows.find((one) => one.focused)?.id ?? "none";
	const workspace = screen.workspaces.find((one) => one.focused)?.id ?? "none";
	return `window ${window} on workspace ${workspace}`;
}

/** How the screen stands: on, or off with what counts as last shown. */
function screenNote(screen: Screen): Record<string, unknown> {
	if (!screenOff(screen)) return { screen: "on", focus: focusOf(screen) };
	let last: Screen["windows"][number] | undefined;
	for (const one of screen.windows) {
		if ((one.focusedAt ?? -1) > (last?.focusedAt ?? -1)) last = one;
	}
	return {
		screen: "off",
		focusedLast: last
			? `window ${last.id} on workspace ${last.workspace}`
			: "none",
		remembered: screen.remembered ?? [],
	};
}

function named(one: ParkedWindows, which: string): boolean {
	return (
		which === "all" || [one.address, one.session, one.held].includes(which)
	);
}

function say(line: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(line)}\n`);
}

function replayed(argv: readonly string[]): Screen | undefined {
	const at = argv.indexOf("--screen");
	if (at === -1) return undefined;
	const [windows, workspaces] = [argv[at + 1], argv[at + 2]];
	if (windows === undefined || workspaces === undefined) {
		throw new Error("--screen takes niri's windows and workspaces files");
	}
	return screenOf(
		JSON.parse(readFileSync(windows, "utf8")),
		JSON.parse(readFileSync(workspaces, "utf8")),
	);
}

function main(argv: readonly string[]): number {
	if (!onNiri()) {
		say({ error: "not under niri, so there is nothing to close" });
		return 1;
	}
	const replay = replayed(argv);
	const closeAt = argv.indexOf("--close");
	const which = closeAt === -1 ? undefined : argv[closeAt + 1];
	if (closeAt !== -1 && (which === undefined || which === "" || replay)) {
		say({
			error:
				"--close takes a session's address, id or hold, or all, and no --screen",
		});
		return 2;
	}
	const parked = parkedWindowsOf(
		mycelium("held"),
		sessionRows(),
		argv.includes("--running") && which === undefined,
	);
	for (const one of parked) {
		// Read afresh for each, since closing one may empty a workspace.
		const screen = replay ?? readScreen(desk);
		if (screen === undefined) {
			say({ error: "niri can't be read" });
			return 1;
		}
		const verdict = windowVerdict(one.windows, screen);
		const line = {
			address: one.address,
			session: one.session,
			held: one.held,
			parked: one.parked,
			windows: one.windows.map((window) => ({
				class: window.appId,
				kitty: window.id,
				workspace: screen.windows.find((shown) => shown.appId === window.appId)
					?.workspace,
			})),
			...screenNote(screen),
			verdict: verdict.kind,
			...("why" in verdict ? { why: verdict.why } : {}),
		};
		if (which === undefined || !named(one, which)) {
			say(line);
			continue;
		}
		if (verdict.kind !== "close") {
			say({ ...line, closed: false });
			continue;
		}
		const before = focusOf(screen);
		const kept = keepPlaceAsleep(one.session, desk.run);
		if (kept !== KEPT) {
			say({ ...line, closed: false, why: `the launcher said: ${kept}` });
			continue;
		}
		const unclosed = verdict.windows
			.map((window) => closeWindow(window, desk.run))
			.find((why) => why !== undefined);
		const after = readScreen(desk);
		const focus = after === undefined ? "niri can't be read" : focusOf(after);
		say({
			...line,
			closed: unclosed === undefined,
			...(unclosed !== undefined ? { why: unclosed } : {}),
			focusBefore: before,
			focusAfter: focus,
		});
		if (focus !== before) {
			say({ error: "Joel's focus moved, so the sweep stops here" });
			return 1;
		}
	}
	return 0;
}

process.exitCode = main(process.argv.slice(2));
