/**
 * Opening a clicked link through the terminal pi is shown in, so the
 * app it opens comes forward.
 *
 * A compositor gives focus to a window that asks with an activation
 * token, and niri honours one only when its serial is no older than
 * the last keyboard or pointer enter: a token made by the client that
 * saw the click. That client is kitty, not pi, so `xdg-open` run by pi
 * carries no token and the browser or reader opens behind pi (Joel, 4
 * November: "it doesn't switch me to the app they link to"). kitty's
 * own `open_url` action asks for a token tied to its last input, the
 * click, and hands it to the opener as `XDG_ACTIVATION_TOKEN`. So a
 * link is opened by asking pi's kitty to run that action over its
 * remote-control socket: the one in pi's environment, or, for a
 * session held apart from its window, the one the machine's node says
 * the window joined to it listens on.
 *
 * pi's own opener stands in when no kitty can be reached or kitty
 * refuses. When kitty doesn't answer in time it isn't asked twice,
 * since it may have opened the link already.
 */

import { execFile } from "node:child_process";

/**
 * Opens a link, handing it to `fallback` (pi's own opener) when it
 * can't; settles once it has done one or the other.
 */
export type LinkOpener = (
	url: string,
	fallback: (url: string) => void,
) => Promise<void>;

/** How a command asked to open a link ended. */
export type Ran = "done" | "refused" | "no-answer";

/** Runs a command, saying how it ended within `patience` ms. */
export type Run = (
	command: string,
	args: readonly string[],
	patience: number,
) => Promise<Ran>;

/** The window a held session is shown in, as the machine's node names it. */
export interface ShownIn {
	readonly terminal: string;
	readonly within?: string;
}

/** How long kitty has to take the link before it is left to it. */
export const KITTY_PATIENCE_MS = 3000;

/**
 * The remote-control socket of the kitty pi is shown in: kitty's own
 * variable when pi runs under it, else the socket the window joined
 * to a held session listens on, else none.
 */
export async function kittySocket(
	env: Readonly<Record<string, string | undefined>>,
	shownIn: () => Promise<ShownIn | undefined>,
): Promise<string | undefined> {
	if (env.KITTY_LISTEN_ON) return env.KITTY_LISTEN_ON;
	const window = await shownIn();
	return window?.terminal === "kitty" ? window.within : undefined;
}

/**
 * The command that asks kitty at `socket` to open `url`. kitty reads
 * the action's argument as the body of a Python string, so a backslash
 * goes doubled to arrive as one.
 */
export function kittyOpens(socket: string, url: string): string[] {
	return [
		"@",
		"--to",
		socket,
		"action",
		"open_url",
		url.replaceAll("\\", "\\\\"),
	];
}

/**
 * An opener that asks the kitty at the socket `socket` finds to open
 * each link, falling back to pi's opener when there is none or kitty
 * refuses.
 */
export function openThroughKitty(
	socket: () => Promise<string | undefined>,
	run: Run = runCommand,
): LinkOpener {
	return async (url, fallback) => {
		let reach: string | undefined;
		try {
			reach = await socket();
		} catch {
			// No node to ask is no kitty to reach: pi's opener takes it.
			reach = undefined;
		}
		if (!reach) {
			fallback(url);
			return;
		}
		const ran = await run("kitten", kittyOpens(reach, url), KITTY_PATIENCE_MS);
		if (ran === "refused") fallback(url);
	};
}

/** Runs a command with no shell, killing it once `patience` runs out. */
const runCommand: Run = (command, args, patience) =>
	new Promise((resolve) => {
		execFile(command, [...args], { timeout: patience }, (error) => {
			if (!error) resolve("done");
			else resolve(error.killed ? "no-answer" : "refused");
		});
	});
