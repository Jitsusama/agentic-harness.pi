/**
 * Settling a session before it is reopened, so a restart replaces its
 * window rather than adding one beside it.
 *
 * On 7 November Joel woke to nine bare shell prompts, kitty windows
 * whose pi had died and been started again elsewhere, and two holders
 * with no pi under them (P9R1KI [871f8a4f]); and two Worldtree sessions
 * each had a parked holder and a second live pi on the same log, so a
 * key in the parked window would have woken a second pi on one log
 * (80ECO2 [4446977c], KP0L6A [03b53fc9]).
 *
 * So before a session is reopened, the machine's node is asked what it
 * holds (`mycelium held`, a JSON line a session), and the session is:
 *
 * - left as it is, when a holder runs its pi, since it is not lost;
 * - woken in its own holder and window, when it is held parked, rather
 *   than started a second time;
 * - otherwise reopened, once every window still showing it with no pi
 *   under it is closed: a holder's window whose pi has gone, and a
 *   kitty window marked with the session (`pi_session`) whose process
 *   tree holds no pi.
 *
 * A node or terminal that doesn't answer leaves things as they were,
 * and the session is reopened as before.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { realmOf } from "../../mesh/node.ts";
import { isRecord } from "../record.ts";
import { askWake } from "../session/park.ts";

/** The kitty user variable naming the session a window was opened for. */
export const SESSION_MARK = "pi_session";

/** How long the node and the terminal may take to answer. */
export const SETTLE_PATIENCE_MS = 5_000;

/** A window a holder shows its session in, as the node names it. */
export interface HeldWindow {
	readonly terminal: string;
	readonly id: string;
	readonly within: string;
}

/** One session the machine's node holds. */
export interface HeldSession {
	readonly id: string;
	readonly command: readonly string[];
	/** The pi it runs, or 0 while it is parked or gone. */
	readonly pid: number;
	readonly parked: boolean;
	readonly windows: readonly HeldWindow[];
}

function heldWindowsOf(value: unknown): HeldWindow[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((one): HeldWindow[] =>
		isRecord(one) &&
		typeof one.terminal === "string" &&
		typeof one.id === "string" &&
		typeof one.within === "string"
			? [{ terminal: one.terminal, id: one.id, within: one.within }]
			: [],
	);
}

/** The sessions in `mycelium held`'s output, skipping lines it can't read. */
export function heldSessionsIn(output: string): HeldSession[] {
	return output.split("\n").flatMap((line): HeldSession[] => {
		if (!line.trim()) return [];
		let one: unknown;
		try {
			one = JSON.parse(line);
		} catch {
			// A line that isn't a held session says nothing of one.
			return [];
		}
		if (
			!isRecord(one) ||
			typeof one.id !== "string" ||
			!Array.isArray(one.command)
		) {
			return [];
		}
		return [
			{
				id: one.id,
				command: one.command.filter(
					(word): word is string => typeof word === "string",
				),
				pid: typeof one.pid === "number" ? one.pid : 0,
				parked: one.parked === true,
				windows: heldWindowsOf(one.windows),
			},
		];
	});
}

/** A session log's name: when it was started, then the session's id. */
const LOG_NAME = /_([^_/]+)\.jsonl$/;

/**
 * The session a held command opens, by `--session` or `--session-id`,
 * given as its id or as the path of its log, whose name ends in the id.
 */
export function sessionOfCommand(
	command: readonly string[],
): string | undefined {
	const at = command.findIndex(
		(word) => word === "--session" || word === "--session-id",
	);
	const named = at >= 0 ? command[at + 1] : undefined;
	return named ? (LOG_NAME.exec(named)?.[1] ?? named) : undefined;
}

/** A kitty window, as far as settling reads it. */
export interface KittyWindowSeen {
	/** The kitty socket it was listed on. */
	readonly within: string;
	readonly id: string;
	/** The process kitty started in it. */
	readonly pid?: number;
	readonly marks: Readonly<Record<string, string>>;
}

/** Every window in a `kitty @ ls` listing, with its pid and user variables. */
export function kittyWindowsIn(
	listing: unknown,
	within: string,
): KittyWindowSeen[] {
	if (!Array.isArray(listing)) return [];
	const out: KittyWindowSeen[] = [];
	for (const osWindow of listing) {
		const tabs = isRecord(osWindow) ? osWindow.tabs : undefined;
		for (const tab of Array.isArray(tabs) ? tabs : []) {
			const windows = isRecord(tab) ? tab.windows : undefined;
			for (const window of Array.isArray(windows) ? windows : []) {
				if (!isRecord(window) || typeof window.id !== "number") continue;
				const vars = isRecord(window.user_vars) ? window.user_vars : {};
				const marks: Record<string, string> = {};
				for (const [key, value] of Object.entries(vars)) {
					if (typeof value === "string") marks[key] = value;
				}
				out.push({
					within,
					id: String(window.id),
					...(typeof window.pid === "number" ? { pid: window.pid } : {}),
					marks,
				});
			}
		}
	}
	return out;
}

/** What settling needs of the machine. */
export interface SettleHost {
	/** What the machine's node holds, or undefined when it can't say. */
	readonly held: () => Promise<readonly HeldSession[] | undefined>;
	/** Whether a process is running. */
	readonly alive: (pid: number) => boolean;
	/** Whether a pi runs at or below a process. */
	readonly piUnder: (pid: number) => boolean;
	/** Wake a parked session through its holder; whether it was asked. */
	readonly wake: (session: string) => boolean;
	/** The windows a kitty socket lists, or none when it doesn't answer. */
	readonly kittyWindows: (within: string) => Promise<KittyWindowSeen[]>;
	/** Close one kitty window. */
	readonly close: (within: string, id: string) => Promise<void>;
	/** Kitty sockets to look in beside the ones the node names. */
	readonly sockets?: readonly string[];
}

/** What became of each session asked about. */
export interface Settled {
	/** Running under a holder already, so not reopened. */
	readonly running: string[];
	/** Parked under a holder and woken there, so not reopened. */
	readonly woken: string[];
	/** Parked where nothing here can wake it, so not reopened. */
	readonly parked: string[];
	/** To reopen, their dead windows closed. */
	readonly reopen: string[];
	/** How many windows with no pi left were closed. */
	readonly closed: number;
}

/**
 * Settle each session before it is reopened: leave one that runs, wake
 * one held parked, and close every window left showing one that is
 * dead, answering which to reopen.
 */
export async function settleBeforeReopen(
	sessions: readonly string[],
	host: SettleHost,
): Promise<Settled> {
	const running: string[] = [];
	const woken: string[] = [];
	const parked: string[] = [];
	const reopen: string[] = [];
	let closed = 0;
	const held = (await host.held()) ?? [];
	const sockets = new Set(host.sockets ?? []);
	for (const one of held) {
		for (const window of one.windows) {
			if (window.terminal === "kitty") sockets.add(window.within);
		}
	}
	const listed = new Map<string, KittyWindowSeen[]>();
	const windowsOn = async (within: string) => {
		let seen = listed.get(within);
		if (!seen) {
			seen = await host.kittyWindows(within);
			listed.set(within, seen);
		}
		return seen;
	};
	for (const session of sessions) {
		const holders = held.filter(
			(one) => sessionOfCommand(one.command) === session,
		);
		if (holders.some((one) => one.pid > 0 && host.alive(one.pid))) {
			running.push(session);
			continue;
		}
		if (holders.some((one) => one.parked)) {
			(host.wake(session) ? woken : parked).push(session);
			continue;
		}
		const dead = new Set<string>();
		for (const one of holders) {
			for (const window of one.windows) {
				if (window.terminal === "kitty") {
					dead.add(`${window.within}\n${window.id}`);
				}
			}
		}
		for (const within of sockets) {
			for (const window of await windowsOn(within)) {
				const marked = window.marks[SESSION_MARK] === session;
				const named = dead.has(`${within}\n${window.id}`);
				if (!marked && !named) continue;
				// A window counts as dead only once nothing under it runs a pi.
				if (window.pid !== undefined && host.piUnder(window.pid)) {
					dead.delete(`${within}\n${window.id}`);
					continue;
				}
				dead.add(`${within}\n${window.id}`);
			}
		}
		for (const key of dead) {
			const [within = "", id = ""] = key.split("\n");
			const shown = (listed.get(within) ?? []).some((one) => one.id === id);
			if (!shown) continue;
			try {
				await host.close(within, id);
				closed += 1;
			} catch {
				// A window that won't close is one more on the screen, as before.
			}
		}
		reopen.push(session);
	}
	return { running, woken, parked, reopen, closed };
}

/** What the machine's node holds, by `mycelium held`. */
export function heldByNode(
	realm: string | undefined,
): Promise<readonly HeldSession[] | undefined> {
	const args = [...(realm ? ["--realm", realm] : []), "held"];
	return new Promise((resolve) => {
		execFile(
			"mycelium",
			args,
			{ timeout: SETTLE_PATIENCE_MS },
			(error, stdout) => resolve(error ? undefined : heldSessionsIn(stdout)),
		);
	});
}

/** Whether a process named `pi` runs at or below `pid`, read from /proc. */
export function piUnder(pid: number, proc = "/proc"): boolean {
	const seen = new Set<number>();
	const queue = [pid];
	while (queue.length > 0) {
		const at = queue.shift();
		if (at === undefined || seen.has(at)) continue;
		seen.add(at);
		try {
			if (readFileSync(`${proc}/${at}/comm`, "utf8").trim() === "pi") {
				return true;
			}
			for (const task of readdirSync(`${proc}/${at}/task`)) {
				const children = readFileSync(
					`${proc}/${at}/task/${task}/children`,
					"utf8",
				);
				for (const child of children.split(/\s+/)) {
					if (child) queue.push(Number(child));
				}
			}
		} catch {
			// A process gone while it was read has no pi under it.
		}
	}
	return false;
}

/** The windows a kitty socket lists, through `kitty @ ls`. */
export function kittyWindowsAt(within: string): Promise<KittyWindowSeen[]> {
	return new Promise((resolve) => {
		execFile(
			"kitty",
			["@", "--to", within, "ls"],
			{ timeout: SETTLE_PATIENCE_MS, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout) => {
				if (error) return resolve([]);
				try {
					resolve(kittyWindowsIn(JSON.parse(stdout), within));
				} catch {
					// A listing that isn't JSON lists nothing to close.
					resolve([]);
				}
			},
		);
	});
}

/**
 * Settle sessions on this machine, through its node, kitty and /proc.
 * Off Linux, where there is no /proc to read a window's processes from,
 * and with `PI_SETTLE=off`, as the test suite sets so nothing it reopens
 * touches the developer's windows, nothing is settled and every session
 * is reopened as before.
 */
export function settleHere(
	sessions: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<Settled> {
	if (process.platform !== "linux" || env.PI_SETTLE === "off") {
		return Promise.resolve({
			running: [],
			woken: [],
			parked: [],
			reopen: [...sessions],
			closed: 0,
		});
	}
	const socket = env.KITTY_LISTEN_ON;
	return settleBeforeReopen(sessions, {
		held: () => heldByNode(realmOf(env)),
		alive: (pid) => existsSync(`/proc/${pid}`),
		piUnder: (pid) => piUnder(pid),
		wake: (session) => askWake(session, `reopen-${Date.now()}`),
		kittyWindows: kittyWindowsAt,
		close: closeKittyWindow,
		...(socket ? { sockets: [socket] } : {}),
	});
}

/** Close one kitty window through its socket. */
export function closeKittyWindow(within: string, id: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(
			"kitty",
			["@", "--to", within, "close-window", "--match", `id:${id}`],
			{ timeout: SETTLE_PATIENCE_MS },
			(error) => (error ? reject(error) : resolve()),
		);
	});
}
