/**
 * Opening a window on its orchestrator's workspace, in its order, under
 * niri.
 *
 * niri puts a new window on the workspace that is focused, so a session
 * an orchestrator starts while Joel looks at another workspace opened
 * on his, not the orchestrator's (Joel, 7 November: "orchestrators
 * starting up sessions on their same computer ... can default to
 * targetting their own workspace"); and on 7 November he woke to 21
 * windows on another orchestrator's workspace, "giving me intense
 * anxiety" (P9R1KI [871f8a4f]).
 *
 * The workspace is the one holding a window the caller names by title,
 * the first of them found: the session's orchestrator's, then its own,
 * then the asker's. Only one window of a title counts, since two would
 * leave it a guess. Within it, the orchestrator's window stays first
 * and its sessions follow by title, so the new one is given the column
 * after the last that sorts before it.
 *
 * Core's niri takes a one-shot ask, `OpenNextWindowOn`, naming an app
 * id, a workspace and a column: the next window of that app id opens
 * there, without focus, and the ask is forgotten after 30 seconds. So a
 * window gets a class of its own, niri is asked first, and kitty opens
 * with that class. A niri started before that patch refuses the ask;
 * then the window is moved there once it opens, with
 * `MoveWindowToWorkspace` and no focus, and goes last, since stock niri
 * moves only the focused column within a workspace. Any answer missing
 * and the window stays where niri put it, as before.
 */

import { randomInt } from "node:crypto";
import { connect } from "node:net";
import { isRecord } from "../internal/record.ts";
import { SPAWNED_CLASS } from "./types.ts";

/** How long niri may take to answer one request. */
export const NIRI_TIMEOUT_MS = 2_000;

/** How long a window is waited for before it is left where it opened. */
export const OPENED_WAIT_MS = 10_000;

/** How often niri is asked whether the window has opened. */
export const OPENED_POLL_MS = 200;

/** One request to niri's IPC, answered with its reply. */
export type NiriCall = (request: unknown) => Promise<unknown>;

/**
 * A call over niri's socket: one JSON request on a line, one reply on
 * a line. Rejects when niri doesn't answer in time.
 */
export function niriAt(socket: string, timeoutMs = NIRI_TIMEOUT_MS): NiriCall {
	return (request) =>
		new Promise((resolve, reject) => {
			const stream = connect(socket);
			let read = "";
			const done = (settle: () => void) => {
				clearTimeout(clock);
				stream.destroy();
				settle();
			};
			const clock = setTimeout(
				() => done(() => reject(new Error("niri didn't answer in time"))),
				timeoutMs,
			);
			stream.on("error", (error) => done(() => reject(error)));
			stream.on("data", (chunk) => {
				read += chunk.toString("utf8");
				const end = read.indexOf("\n");
				if (end === -1) return;
				const line = read.slice(0, end);
				done(() => {
					try {
						resolve(JSON.parse(line));
					} catch (error) {
						reject(error);
					}
				});
			});
			stream.write(`${JSON.stringify(request)}\n`);
		});
}

/** What niri says of one window, as far as this reads it. */
export interface NiriWindow {
	readonly title: string;
	readonly workspace: number;
	readonly id?: number;
	readonly appId?: string;
	/** Its column in the workspace's scrolling layout, from 1. */
	readonly column?: number;
}

function columnOf(layout: unknown): number | undefined {
	if (!isRecord(layout)) return undefined;
	const at = layout.pos_in_scrolling_layout;
	return Array.isArray(at) && typeof at[0] === "number" ? at[0] : undefined;
}

/** The windows in niri's reply to `"Windows"`, or none when it isn't one. */
export function windowsIn(reply: unknown): NiriWindow[] {
	if (!isRecord(reply) || !isRecord(reply.Ok)) return [];
	const windows = reply.Ok.Windows;
	if (!Array.isArray(windows)) return [];
	return windows.flatMap((one): NiriWindow[] => {
		if (
			!isRecord(one) ||
			typeof one.title !== "string" ||
			typeof one.workspace_id !== "number"
		) {
			return [];
		}
		const column = columnOf(one.layout);
		return [
			{
				title: one.title,
				workspace: one.workspace_id,
				...(typeof one.id === "number" ? { id: one.id } : {}),
				...(typeof one.app_id === "string" ? { appId: one.app_id } : {}),
				...(column !== undefined ? { column } : {}),
			},
		];
	});
}

/**
 * The workspace of the one window titled `title`, or undefined when no
 * window is, or more than one is, which would leave it a guess.
 */
export function workspaceTitled(
	windows: readonly NiriWindow[],
	title: string,
): number | undefined {
	const titled = windows.filter((one) => one.title === title);
	return titled.length === 1 ? titled[0]?.workspace : undefined;
}

/**
 * The column, from 1, a window titled `title` takes on `workspace`: the
 * one after the last column that comes before it, which is the window
 * titled `first` (its orchestrator's) and any whose title sorts before
 * its own. A column is known by the title of its first window. The
 * window titled `first` itself goes first.
 */
export function columnFor(
	windows: readonly NiriWindow[],
	workspace: number,
	title: string,
	first?: string,
): number {
	if (title === first) return 1;
	const titles = new Map<number, string>();
	for (const one of windows) {
		if (one.workspace !== workspace || one.column === undefined) continue;
		if (!titles.has(one.column)) titles.set(one.column, one.title);
	}
	let after = 0;
	for (const [column, held] of titles) {
		const before =
			held === first || (held !== title && held.localeCompare(title) < 0);
		if (before && column > after) after = column;
	}
	return after + 1;
}

let opened = 0;

/**
 * A class no other window carries: `SPAWNED_CLASS` and a number, the
 * form the compositor's rule opens without focus. The pid keeps two
 * pis' numbers apart, and apart from the launcher's small ones. The
 * conversations of one host share its pid. Those in one folder share
 * this module's counter too, which keeps their numbers unique, but pi
 * caches the module per folder, so those in other folders each count
 * from one; random digits keep theirs apart too.
 */
export function classOfItsOwn(pid = process.pid): string {
	opened += 1;
	const chance = String(randomInt(1_000_000)).padStart(6, "0");
	return `${SPAWNED_CLASS}.${pid}${String(opened).padStart(4, "0")}${chance}`;
}

/** Where a new window goes, as its caller knows it. */
export interface WindowPlace {
	/**
	 * Titles of windows whose workspace it opens on, the first found
	 * alone deciding: its orchestrator's, then its own, then the asker's.
	 */
	readonly beside: readonly string[];
	/** The title of the window kept first there: its orchestrator's. */
	readonly first?: string;
	/** The title the new window will carry, which orders it. */
	readonly title?: string;
}

/** Where a window is to open, and the class that takes it there. */
export interface Placed {
	readonly windowClass: string;
	readonly workspace: number;
	/** The column niri was asked to open it as, from 1. */
	readonly column?: number;
	/**
	 * Whether niri took the ask; a niri that refused it has the window
	 * moved there once it opens ({@link moveOnceOpen}).
	 */
	readonly asked: boolean;
}

function handled(reply: unknown): boolean {
	return isRecord(reply) && "Ok" in reply;
}

/**
 * Ask niri to open the next window of a class of its own on the
 * workspace holding the first window `place` names, in its column,
 * answering where, or undefined when no window it names can be found.
 * A niri that refuses a column is asked again without one; one that
 * refuses both is answered as not asked, so the window is moved after.
 */
export async function placeWindow(
	niri: NiriCall,
	place: WindowPlace,
	windowClass: string = classOfItsOwn(),
): Promise<Placed | undefined> {
	const windows = windowsIn(await niri("Windows"));
	const workspace = place.beside
		.map((title) => workspaceTitled(windows, title))
		.find((found) => found !== undefined);
	if (workspace === undefined) return undefined;
	const column =
		place.title !== undefined
			? columnFor(windows, workspace, place.title, place.first)
			: undefined;
	const ask = (at?: number) =>
		niri({
			Action: {
				OpenNextWindowOn: {
					app_id: windowClass,
					reference: { Id: workspace },
					...(at !== undefined ? { column: at } : {}),
				},
			},
		});
	if (column !== undefined && handled(await ask(column))) {
		return { windowClass, workspace, column, asked: true };
	}
	if (handled(await ask())) return { windowClass, workspace, asked: true };
	return { windowClass, workspace, asked: false };
}

/** How long, and how often, a window is waited for. */
export interface OpenedWait {
	readonly waitMs?: number;
	readonly everyMs?: number;
}

/**
 * Move the window of a placed class to its workspace once niri has it,
 * without focus, for a niri that refused to be asked beforehand;
 * answers whether it is there. A window that doesn't open in time is
 * left where it is.
 */
export async function moveOnceOpen(
	niri: NiriCall,
	placed: Placed,
	wait: OpenedWait = {},
): Promise<boolean> {
	const until = Date.now() + (wait.waitMs ?? OPENED_WAIT_MS);
	const every = wait.everyMs ?? OPENED_POLL_MS;
	for (;;) {
		const window = windowsIn(await niri("Windows")).find(
			(one) => one.appId === placed.windowClass,
		);
		if (window?.id !== undefined) {
			if (window.workspace === placed.workspace) return true;
			return handled(
				await niri({
					Action: {
						MoveWindowToWorkspace: {
							window_id: window.id,
							reference: { Id: placed.workspace },
							focus: false,
						},
					},
				}),
			);
		}
		if (Date.now() >= until) return false;
		await new Promise((done) => setTimeout(done, every));
	}
}
