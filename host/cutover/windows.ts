/**
 * Where a session's window stands as the cutover plans its move: whether
 * it sits on the workspace Joel has focused, which a wave must spare
 * (OSPHT4, 11 November: the windows stay where they are), and whether a
 * mycelium older than #121 holds it, whose window shows one Parked line
 * for 2 to 5 s as it moves.
 *
 * Read once a plan from what the machine says: mycelium's sessions, each
 * with its hold and kitty window; niri's windows and workspaces; kitty's
 * remote `ls` of each instance a window is in; and each holder's
 * executable. A kitty window is matched to niri's by its OS window's
 * class and the title of its active tab, which are the app id and title
 * niri shows, since a shared kitty gives every window one pid and old
 * windows share app ids; the title tells apart windows of one class,
 * and the class a standalone kitty showing the same title. Where that
 * can't say, the window counts as unplaced, and a wave spares it.
 */

import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { isRecord } from "../../lib/internal/record.ts";

const run = promisify(execFile);

/** How long each of the machine's programs may take to answer. */
const READ_TIMEOUT_MS = 5_000;

/** A session as mycelium lists it: pi's session id, its hold, its window. */
export interface HeldSession {
	readonly session: string;
	readonly held?: string;
	readonly window?: { readonly within: string; readonly id: string };
}

/** One of niri's windows: its app id, title and the workspace it's on. */
export interface NiriWindow {
	readonly appId?: string;
	readonly title: string;
	readonly workspace: number | undefined;
}

/** One of a kitty's OS windows: the kitty windows in it, its class and title. */
export interface KittyWindow {
	readonly windows: readonly string[];
	readonly wmClass?: string;
	readonly title: string;
}

/** A hold's holder: its pid and the executable it runs, where readable. */
export interface Holder {
	readonly pid: number;
	readonly exe: string | undefined;
}

/** What the machine says of its windows, read once a plan. */
export interface MachineWindows {
	readonly sessions: readonly HeldSession[];
	readonly niri: readonly NiriWindow[];
	/** The workspace Joel has focused, by niri's id. */
	readonly focused: number | undefined;
	/** Each kitty instance's OS windows, by the address mycelium names it by. */
	readonly kitties: ReadonlyMap<string, readonly KittyWindow[]>;
	/** Each hold's holder, by the hold's id. */
	readonly holders: ReadonlyMap<string, Holder>;
	/** What the system's mycelium resolves to. */
	readonly mycelium: string | undefined;
	/** Why the machine couldn't be read, when it couldn't. */
	readonly unread?: string;
}

/** Where a session's window stands, for a session that has one. */
export interface WindowStanding {
	/** On Joel's focused workspace, elsewhere, or unplaced with why. */
	readonly where: "joel" | "away" | { readonly unplaced: string };
	/** The pid of a holder that isn't the system's mycelium. */
	readonly oldHolder?: number;
}

/**
 * Where `session`'s window stands, or nothing for one mycelium knows no
 * window of. Of several niri windows with its class and title, any on
 * Joel's workspace counts, since sparing one too many costs only a later move.
 */
export function standingOf(
	session: string,
	machine: MachineWindows,
): WindowStanding | undefined {
	const row = machine.sessions.find((one) => one.session === session);
	if (row?.window === undefined) return undefined;
	const holder =
		row.held === undefined ? undefined : machine.holders.get(row.held);
	const old =
		holder?.exe !== undefined &&
		machine.mycelium !== undefined &&
		holder.exe !== machine.mycelium
			? { oldHolder: holder.pid }
			: {};
	const unplaced = (why: string): WindowStanding => ({
		where: { unplaced: why },
		...old,
	});
	if (machine.unread !== undefined) return unplaced(machine.unread);
	const { within, id } = row.window;
	const os = machine.kitties
		.get(within)
		?.find((one) => one.windows.includes(id));
	if (os === undefined) return unplaced(`kitty ${within} has no window ${id}`);
	const shown = machine.niri.filter(
		(one) =>
			one.title === os.title &&
			(os.wmClass === undefined || one.appId === os.wmClass),
	);
	if (shown.length === 0)
		return unplaced(
			`niri shows no window titled "${os.title}"${os.wmClass === undefined ? "" : ` of class ${os.wmClass}`}`,
		);
	if (machine.focused === undefined)
		return unplaced("niri has no workspace focused");
	const onJoels = shown.some((one) => one.workspace === machine.focused);
	return { where: onJoels ? "joel" : "away", ...old };
}

/** mycelium's sessions, from what `mycelium sessions` printed. */
export function parseHeldSessions(text: string): HeldSession[] {
	const found: HeldSession[] = [];
	for (const line of text.split("\n").filter((one) => one.trim() !== "")) {
		const parsed: unknown = JSON.parse(line);
		const ok = isRecord(parsed) && isRecord(parsed.Ok) ? parsed.Ok : parsed;
		const rows = isRecord(ok) && Array.isArray(ok.Sessions) ? ok.Sessions : [];
		for (const row of rows) {
			const one = heldSessionOf(row);
			if (one) found.push(one);
		}
	}
	return found;
}

function heldSessionOf(row: unknown): HeldSession | undefined {
	if (!isRecord(row) || !isRecord(row.presence)) return undefined;
	const session = row.presence.session;
	if (typeof session !== "string") return undefined;
	const held = typeof row.held === "string" ? { held: row.held } : {};
	const window = row.window;
	if (
		isRecord(window) &&
		typeof window.within === "string" &&
		(typeof window.id === "string" || typeof window.id === "number")
	)
		return {
			session,
			...held,
			window: { within: window.within, id: String(window.id) },
		};
	return { session, ...held };
}

/** niri's windows, from `niri msg --json windows`. */
export function parseNiriWindows(text: string): NiriWindow[] {
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(isRecord).map((one) => ({
		...(typeof one.app_id === "string" ? { appId: one.app_id } : {}),
		title: typeof one.title === "string" ? one.title : "",
		workspace:
			typeof one.workspace_id === "number" ? one.workspace_id : undefined,
	}));
}

/** The workspace focused, from `niri msg --json workspaces`. */
export function parseFocusedWorkspace(text: string): number | undefined {
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) return undefined;
	const focused = parsed
		.filter(isRecord)
		.find((one) => one.is_focused === true);
	return typeof focused?.id === "number" ? focused.id : undefined;
}

/** A kitty's OS windows, from `kitten @ ls`: each titled as its active tab. */
export function parseKittyWindows(text: string): KittyWindow[] {
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(isRecord).map((os) => {
		const tabs = Array.isArray(os.tabs) ? os.tabs.filter(isRecord) : [];
		const active = tabs.find((tab) => tab.is_active === true) ?? tabs[0];
		const windows = tabs.flatMap((tab) =>
			Array.isArray(tab.windows)
				? tab.windows
						.filter(isRecord)
						.map((one) => String(one.id ?? ""))
						.filter((one) => one !== "")
				: [],
		);
		return {
			windows,
			...(typeof os.wm_class === "string" ? { wmClass: os.wm_class } : {}),
			title: typeof active?.title === "string" ? active.title : "",
		};
	});
}

/** Read what the machine says of its windows, for the realm's sessions. */
export async function readMachineWindows(
	realm: string,
	runtimeDir: string | undefined = process.env.XDG_RUNTIME_DIR,
): Promise<MachineWindows> {
	const empty: MachineWindows = {
		sessions: [],
		niri: [],
		focused: undefined,
		kitties: new Map(),
		holders: new Map(),
		mycelium: systemMycelium(),
	};
	let sessions: HeldSession[];
	try {
		sessions = parseHeldSessions(
			await output("mycelium", ["--realm", realm, "sessions"]),
		);
	} catch (error) {
		return {
			...empty,
			unread: `mycelium didn't list sessions: ${messageOf(error)}`,
		};
	}
	const holders = new Map<string, Holder>();
	for (const one of sessions) {
		if (one.held === undefined || runtimeDir === undefined) continue;
		const holder = holderOf(
			join(runtimeDir, "mycelium", `${realm}.held`, `${one.held}.json`),
		);
		if (holder) holders.set(one.held, holder);
	}
	try {
		const [windows, workspaces] = await Promise.all([
			output("niri", ["msg", "--json", "windows"]),
			output("niri", ["msg", "--json", "workspaces"]),
		]);
		const kitties = new Map<string, KittyWindow[]>();
		for (const within of new Set(
			sessions.flatMap((one) => (one.window ? [one.window.within] : [])),
		)) {
			try {
				kitties.set(
					within,
					parseKittyWindows(
						await output("kitten", ["@", "--to", within, "ls"]),
					),
				);
			} catch {
				// A kitty that won't answer leaves its windows unplaced, so spared.
			}
		}
		return {
			...empty,
			sessions,
			holders,
			niri: parseNiriWindows(windows),
			focused: parseFocusedWorkspace(workspaces),
			kitties,
		};
	} catch (error) {
		return {
			...empty,
			sessions,
			holders,
			unread: `niri didn't answer: ${messageOf(error)}`,
		};
	}
}

async function output(command: string, args: string[]): Promise<string> {
	const { stdout } = await run(command, args, {
		timeout: READ_TIMEOUT_MS,
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout;
}

// The holder a hold's record names, and the executable it runs now.
function holderOf(record: string): Holder | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(record, "utf8"));
	} catch {
		// A hold gone or caught half written names no holder to judge.
		return undefined;
	}
	if (!isRecord(parsed) || typeof parsed.holder !== "number") return undefined;
	return {
		pid: parsed.holder,
		exe: realOrNothing(`/proc/${parsed.holder}/exe`),
	};
}

// What the mycelium on PATH resolves to, the system's own.
function systemMycelium(): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir === "") continue;
		const found = realOrNothing(join(dir, "mycelium"));
		if (found) return found;
	}
	return undefined;
}

function realOrNothing(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		// Not there, or another user's process: nothing to compare.
		return undefined;
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
