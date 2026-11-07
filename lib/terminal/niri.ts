/**
 * Opening a window on the asking session's workspace, under niri.
 *
 * niri puts a new window on the workspace that is focused, so a session
 * an orchestrator starts while Joel looks at another workspace opened
 * on his, not the orchestrator's (Joel, 7 November: "orchestrators
 * starting up sessions on their same computer ... can default to
 * targetting their own workspace"). Core's niri takes a one-shot ask,
 * `OpenNextWindowOn`, naming an app id and a workspace: the next window
 * of that app id opens there, without focus, and the ask is forgotten
 * after 30 seconds. So a window gets a class of its own, niri is asked
 * first, and kitty opens with that class.
 *
 * The asker's workspace is the one holding its window, found by title:
 * kitty says the title of the window the session runs in, and niri the
 * workspace of each window by title. Only one window of that title
 * counts, since two would leave it a guess; any answer missing, or a
 * niri that refuses the ask, as one started before core's patch does,
 * and the window opens as it did before, wherever niri puts it.
 */

import { connect } from "node:net";
import { SPAWNED_CLASS } from "./types.ts";

/** How long niri may take to answer one request. */
export const NIRI_TIMEOUT_MS = 2_000;

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
interface NiriWindow {
	readonly title: string;
	readonly workspace: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** The windows in niri's reply to `"Windows"`, or none when it isn't one. */
export function windowsIn(reply: unknown): NiriWindow[] {
	if (!isRecord(reply) || !isRecord(reply.Ok)) return [];
	const windows = reply.Ok.Windows;
	if (!Array.isArray(windows)) return [];
	return windows.flatMap((one): NiriWindow[] =>
		isRecord(one) &&
		typeof one.title === "string" &&
		typeof one.workspace_id === "number"
			? [{ title: one.title, workspace: one.workspace_id }]
			: [],
	);
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

let opened = 0;

/**
 * A class no other window carries: `SPAWNED_CLASS` and a number, the
 * form the compositor's rule opens without focus. The pid keeps two
 * sessions' numbers apart, and apart from the launcher's small ones.
 */
export function classOfItsOwn(pid = process.pid): string {
	opened += 1;
	return `${SPAWNED_CLASS}.${pid}${String(opened).padStart(4, "0")}`;
}

/** Where a window is to open, and the class that takes it there. */
export interface Placed {
	readonly windowClass: string;
	readonly workspace: number;
}

/**
 * Ask niri to open the next window of a class of its own on the
 * workspace holding the window titled `askerTitle`, answering the class
 * and workspace, or undefined when it can't be told where or niri
 * refuses.
 */
export async function placeOnAskersWorkspace(
	niri: NiriCall,
	askerTitle: string,
	windowClass: string = classOfItsOwn(),
): Promise<Placed | undefined> {
	const workspace = workspaceTitled(
		windowsIn(await niri("Windows")),
		askerTitle,
	);
	if (workspace === undefined) return undefined;
	const reply = await niri({
		Action: {
			OpenNextWindowOn: { app_id: windowClass, reference: { Id: workspace } },
		},
	});
	return isRecord(reply) && "Ok" in reply
		? { windowClass, workspace }
		: undefined;
}
