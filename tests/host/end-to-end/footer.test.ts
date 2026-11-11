/**
 * pi's own footer on a hosted conversation's screen, as Joel reads it at
 * pi's: the folder and git branch of that conversation, not the host's,
 * the model and its thinking level, and the status lines extensions set,
 * each redrawn as it changes with no key pressed. One host process runs
 * every conversation from one working folder, so each footer must come
 * from its own conversation. The model and thinking keys are his: Ctrl+P
 * and Ctrl+Shift+P cycle the model, and Shift+Tab the thinking level.
 * Runs on the host's pi as support/host-pi.ts finds it; an ordinary run
 * without one skips it, and `pnpm test:host` fails instead.
 */

import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { until } from "../../support/until.ts";
import { type Folders, folders } from "./support/folders.ts";
import {
	HOST_PI_REQUIRED,
	hostPackageDir,
	hostPiMissing,
} from "./support/host-pi.ts";
import { type ScreenHost, startScreenHost } from "./support/screen-host.ts";
import { type Seal, seal } from "./support/seal.ts";
import { attach, type Viewer } from "./support/viewer.ts";

const packageDir = hostPackageDir();
if (!packageDir && process.env[HOST_PI_REQUIRED])
	throw new Error(hostPiMissing());

/** How long a turn or a redraw may take on a loaded machine. */
const TURN_MS = 20_000;
/** How long one case may take, opening and attaching included. */
const CASE_MS = 60_000;
const ENTER = "\r";
const ROWS = 30;
/** Wide enough that a sealed folder's path is never cut short in the footer. */
const COLUMNS = 200;

/** Each key as kitty sends it under the flags pi asks for. */
const KEY = {
	ctrlP: "\u001b[112;5u",
	ctrlShiftP: "\u001b[112;6u",
	shiftTab: "\u001b[9;2u",
} as const;
/** The footer's model, with the thinking level pi shows for one that reasons. */
const THINKING = /faux-2 • (thinking off|minimal|low|medium|high|xhigh)\b/;

let sealed: Seal;
let host: ScreenHost;
let work: Folders;
const viewers: Viewer[] = [];

describe.skipIf(!packageDir)(
	"pi's footer on a hosted conversation's screen (needs a pi with the host's patches: pnpm test:host)",
	() => {
		beforeAll(async () => {
			if (!packageDir) return;
			sealed = await seal();
			work = folders(sealed);
			host = await startScreenHost(sealed, packageDir);
		}, CASE_MS);
		afterAll(async () => {
			for (const on of viewers) await on.leave().catch(() => {});
			await host?.stop();
			await sealed?.dispose();
		}, CASE_MS);

		it(
			"shows each conversation's own folder and branch, and the branch it moves to",
			async () => {
				const first = repository("parity-first");
				const second = repository("parity-second");
				const one = await opened(first);
				const other = await opened(second);

				await one.shows(`${basename(first)} (parity-first)`, TURN_MS);
				await other.shows(`${basename(second)} (parity-second)`, TURN_MS);
				expect(
					footer(one),
					"one conversation's footer names none of the other's",
				).not.toContain("parity-second");

				git(first, "symbolic-ref", "HEAD", "refs/heads/parity-moved");

				await one.shows(`${basename(first)} (parity-moved)`, TURN_MS);
				expect(footer(other), "the other keeps its own branch").toContain(
					"(parity-second)",
				);
			},
			CASE_MS,
		);

		it(
			"shows the status line an extension sets, and redraws it as it changes and goes",
			async () => {
				const reading = await opened(work.trusted());
				const watching = await attach(
					host.path,
					reading.sessionId,
					ROWS,
					COLUMNS,
				);
				viewers.push(watching);

				reading.type(`/status first word${ENTER}`);
				await reading.shows("first word", TURN_MS);
				await watching.shows("first word", TURN_MS);

				reading.type(`/status second word${ENTER}`);
				await watching.shows("second word", TURN_MS);
				expect(footer(watching), "the old status is gone").not.toContain(
					"first word",
				);

				reading.type(`/status${ENTER}`);
				await until(
					"the status line to go once its extension clears it",
					() => !footer(watching).includes("second word"),
					TURN_MS,
				);
			},
			CASE_MS,
		);

		it(
			"cycles the model on Ctrl+P and back on Ctrl+Shift+P, and the thinking level on Shift+Tab",
			async () => {
				const cycling = await opened(work.trusted());
				await cycling.shows("faux-1", TURN_MS);

				cycling.type(KEY.ctrlP);
				await cycling.shows(THINKING, TURN_MS);
				const level = THINKING.exec(footer(cycling))?.[1];

				cycling.type(KEY.shiftTab);
				await until(
					"Shift+Tab to change the thinking level the footer shows",
					() => {
						const now = THINKING.exec(footer(cycling))?.[1];
						return now !== undefined && now !== level;
					},
					TURN_MS,
				);
				cycling.type(`on the reasoning one${ENTER}`);
				await cycling.shows("heard: on the reasoning one", TURN_MS);

				cycling.type(KEY.ctrlShiftP);
				await until(
					"Ctrl+Shift+P to cycle back to the first model",
					() => footer(cycling).includes("faux-1"),
					TURN_MS,
				);
				expect(
					footer(cycling),
					"the footer names only the model now",
				).not.toMatch(THINKING);
			},
			CASE_MS,
		);
	},
);

/** A viewer of a conversation opened in `cwd`, that knows which it is. */
async function opened(
	cwd: string,
): Promise<Viewer & { readonly sessionId: string }> {
	const { sessionId } = await host.open(cwd);
	const on = await attach(host.path, sessionId, ROWS, COLUMNS);
	viewers.push(on);
	return Object.assign(on, { sessionId });
}

/** A trusted folder that is a git repository on `branch`, with nothing committed. */
function repository(branch: string): string {
	const cwd = work.trusted();
	git(cwd, "init", "--quiet", `--initial-branch=${branch}`);
	return cwd;
}

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** The rows below the editor, where pi draws its footer. */
function footer(on: Viewer): string {
	const rows = on.screen();
	const border = [...rows]
		.reverse()
		.findIndex((row) => /^─+$/.test(row.trim()));
	return border < 0
		? rows.join("\n")
		: rows.slice(rows.length - border).join("\n");
}
