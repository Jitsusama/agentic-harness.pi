/**
 * The windows here joined to a session another machine holds, noted
 * while this boot runs so the next one can offer them back.
 *
 * A session held on the Mac keeps running through optimus's power-off,
 * since the Mac's holder keeps it, so restoring it is reopening a window
 * joined to it, not starting a pi. Only this machine can know such a
 * window was here: the join runs over ssh, which forwards no window, and
 * the far holder forgets a window once its join ends (4UHC5Q, 29
 * October). So the window is noted here, each minute, and the note keeps
 * the boot before's windows once this boot starts writing its own.
 *
 * A window counts when a command it runs in the foreground is, word for
 * word, the `attach` of a session whose machine is another one, as the
 * mycelium node's Sessions answer gives them. kitty's `ls` reports each
 * window's foreground commands; a hand-typed attach counts only when it
 * is typed the same.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./io.ts";

/** The version of the note's shape. */
export const WINDOWS_ELSEWHERE_VERSION = 1;

/** One window here, joined to a session another machine holds. */
export interface ElsewhereWindow {
	/** The session's id, as its machine's pi knows it. */
	readonly id: string;
	readonly address: string;
	readonly title: string;
	readonly quest?: string;
	/** The machine holding the session. */
	readonly machine: string;
	/** The words that join it, run as they stand. */
	readonly attach: readonly string[];
	/** The window's folder here, which an ssh join barely uses. */
	readonly cwd: string;
}

/** The windows of one boot. */
export interface BootWindows {
	readonly boot: string;
	readonly windows: readonly ElsewhereWindow[];
}

/** The note: this boot's windows, and the last boot's once this one began. */
export interface WindowsNote extends BootWindows {
	readonly v: typeof WINDOWS_ELSEWHERE_VERSION;
	readonly ended?: BootWindows;
}

/** Where the note lives, under the harness's quest-workflow state. */
export function windowsNotePath(questWorkflowState: string): string {
	return join(questWorkflowState, "windows-elsewhere.json");
}

/** A session as the Sessions answer gives it, the fields read here. */
interface HeldSession {
	readonly id: string;
	readonly address: string;
	readonly title: string;
	readonly quest?: string;
	readonly machine: string;
	readonly attach: readonly string[];
}

function isWords(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((word) => typeof word === "string")
	);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** The held sessions in a Sessions answer, `{"Ok":{"Sessions":[...]}}`. */
function heldSessions(answer: unknown): HeldSession[] {
	const sessions = asRecord(asRecord(answer)?.Ok)?.Sessions;
	if (!Array.isArray(sessions)) return [];
	const held: HeldSession[] = [];
	for (const raw of sessions) {
		const one = asRecord(raw);
		if (!one) continue;
		const { id, address, title, quest, machine, attach } = one;
		if (
			typeof id !== "string" ||
			typeof address !== "string" ||
			typeof machine !== "string" ||
			!isWords(attach)
		) {
			continue;
		}
		held.push({
			id,
			address,
			title: typeof title === "string" ? title : address,
			...(typeof quest === "string" ? { quest } : {}),
			machine,
			attach,
		});
	}
	return held;
}

/** Each window in a kitty `ls` answer, with its folder and foreground commands. */
function kittyWindows(
	answer: unknown,
): { cwd: string; commands: string[][] }[] {
	if (!Array.isArray(answer)) return [];
	const windows: { cwd: string; commands: string[][] }[] = [];
	for (const os of answer) {
		const tabs = asRecord(os)?.tabs;
		if (!Array.isArray(tabs)) continue;
		for (const tab of tabs) {
			const inTab = asRecord(tab)?.windows;
			if (!Array.isArray(inTab)) continue;
			for (const raw of inTab) {
				const window = asRecord(raw);
				if (!window) continue;
				const running = Array.isArray(window.foreground_processes)
					? window.foreground_processes
					: [];
				const commands = running
					.map((process) => asRecord(process)?.cmdline)
					.filter(isWords);
				windows.push({
					cwd: typeof window.cwd === "string" ? window.cwd : "",
					commands,
				});
			}
		}
	}
	return windows;
}

const sameWords = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((word, i) => word === b[i]);

/**
 * The windows in these kitty answers joined to a session another
 * machine holds, one entry per session however many windows show it.
 */
export function windowsElsewhere(
	kittyAnswers: readonly unknown[],
	sessionsAnswer: unknown,
	thisMachine: string,
): ElsewhereWindow[] {
	const elsewhere = heldSessions(sessionsAnswer).filter(
		(session) => session.machine !== thisMachine,
	);
	const found = new Map<string, ElsewhereWindow>();
	for (const window of kittyAnswers.flatMap(kittyWindows)) {
		for (const session of elsewhere) {
			if (found.has(session.id)) continue;
			if (!window.commands.some((words) => sameWords(words, session.attach))) {
				continue;
			}
			found.set(session.id, {
				id: session.id,
				// The node gives the quest's address for a session on a quest,
				// as restore.json's entries have it.
				address: session.address,
				title: session.title,
				...(session.quest ? { quest: session.quest } : {}),
				machine: session.machine,
				attach: session.attach,
				cwd: window.cwd,
			});
		}
	}
	return [...found.values()];
}

/**
 * The note to write for this boot's windows. A note from another boot
 * becomes `ended`, so the boot before stays readable after this one's
 * first write; one already from this boot keeps whatever `ended` it had.
 */
export function nextNote(
	previous: WindowsNote | undefined,
	boot: string,
	windows: readonly ElsewhereWindow[],
): WindowsNote {
	const ended =
		previous === undefined
			? undefined
			: previous.boot === boot
				? previous.ended
				: { boot: previous.boot, windows: previous.windows };
	return {
		v: WINDOWS_ELSEWHERE_VERSION,
		boot,
		windows,
		...(ended ? { ended } : {}),
	};
}

/**
 * The windows a boot before this one left, to offer back. Until this
 * boot first writes the note, those are the note's own; after, they are
 * its `ended`, less any session joined again in a window now. Nothing
 * when `lastBoot`, the boot the session records say just ended, is
 * known and is another boot, since the note is then older still.
 */
export function windowsToReopen(
	note: WindowsNote | undefined,
	thisBoot: string | undefined,
	lastBoot: string | undefined,
): BootWindows | undefined {
	if (note === undefined || thisBoot === undefined) return undefined;
	const left: BootWindows | undefined =
		note.boot !== thisBoot
			? note
			: note.ended && {
					boot: note.ended.boot,
					windows: note.ended.windows.filter(
						(window) => !note.windows.some((now) => now.id === window.id),
					),
				};
	if (left === undefined) return undefined;
	if (lastBoot !== undefined && left.boot !== lastBoot) return undefined;
	return { boot: left.boot, windows: left.windows };
}

/** The note as it stands on disk, or undefined when there is none to read. */
export function readWindowsNote(path: string): WindowsNote | undefined {
	try {
		const read = asRecord(JSON.parse(readFileSync(path, "utf8")));
		if (
			read?.v !== WINDOWS_ELSEWHERE_VERSION ||
			typeof read.boot !== "string"
		) {
			return undefined;
		}
		const windows = Array.isArray(read.windows) ? read.windows : [];
		const ended = asRecord(read.ended);
		return {
			v: WINDOWS_ELSEWHERE_VERSION,
			boot: read.boot,
			windows: windows.filter(isWindow),
			...(ended && typeof ended.boot === "string"
				? {
						ended: {
							boot: ended.boot,
							windows: (Array.isArray(ended.windows)
								? ended.windows
								: []
							).filter(isWindow),
						},
					}
				: {}),
		};
	} catch {
		return undefined;
	}
}

function isWindow(value: unknown): value is ElsewhereWindow {
	const one = asRecord(value);
	return (
		one !== undefined &&
		typeof one.id === "string" &&
		typeof one.address === "string" &&
		typeof one.title === "string" &&
		typeof one.machine === "string" &&
		isWords(one.attach) &&
		typeof one.cwd === "string"
	);
}

/** Write the note whole, by rename, only when it says something new. */
export function writeWindowsNote(path: string, note: WindowsNote): boolean {
	const text = `${JSON.stringify(note, null, 2)}\n`;
	try {
		if (readFileSync(path, "utf8") === text) return false;
	} catch {
		// No note yet: this is the first.
	}
	mkdirSync(dirname(path), { recursive: true });
	atomicWriteFile(path, text);
	return true;
}
