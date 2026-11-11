/**
 * A shell in a real terminal, as a kitty window is one: bash run
 * interactively under script(1), which gives it a pseudo-terminal of its
 * own, with what is typed written to that terminal and what it shows drawn
 * on xterm's headless one. bash has job control there, so a program that
 * stops itself is stopped as at a person's shell, and fg brings it back.
 * The shell runs under a seal, with the folder holding mycelium first on
 * its PATH.
 */

import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { type Drawn, drawn } from "./drawn.ts";
import type { Seal } from "./seal.ts";

/** The prompt bash shows. */
const PROMPT = "$ ";
/** A row holding the prompt alone: the space bash wrote stays, though a cleared cell's would not. */
export const AT_PROMPT = /^\$ ?$/m;

/** A shell in a terminal of its own. */
export interface Tty extends Drawn {
	/** Type into the terminal, as the bytes a keyboard sends. */
	type(data: string): void;
	/** Close the window: hang up on everything in it, and wait for it to go. */
	close(): Promise<void>;
}

/** Where the shell finds its programs, and what it runs as an editor. */
export interface TtyOptions {
	/** The mycelium to run as `mycelium`. */
	readonly mycelium: string;
	/** What the shell names as its editor, in VISUAL and EDITOR. */
	readonly editor: string;
	readonly rows: number;
	readonly columns: number;
}

/** Open a shell in a terminal of `rows` by `columns`, under `seal`. */
export async function openTty(seal: Seal, options: TtyOptions): Promise<Tty> {
	const drawing = drawn(options.rows, options.columns);
	// script(1) runs its command through `$SHELL -c`, and a bash run that
	// way drops PS1 from its environment, so the prompt is handed to the
	// interactive bash by env(1), past whichever shell script(1) runs.
	const child = spawn(
		"script",
		["-qfec", `env PS1='${PROMPT}' bash --norc --noprofile -i`, "/dev/null"],
		{
			env: {
				...seal.env,
				TERM: "xterm-256color",
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	child.stdout.on("data", (chunk) => drawing.draw(String(chunk)));
	const exited = new Promise<void>((done) => child.once("exit", () => done()));
	const type = (data: string) => {
		child.stdin.write(data);
	};
	await drawing.shows(AT_PROMPT);
	// script(1) reads no window from a pipe, so the terminal is told its
	// size; and NixOS's bash sets PATH and the editors even without
	// profile or rc, so the shell is told where mycelium is and which
	// editor the person uses.
	const bin = JSON.stringify(dirname(options.mycelium));
	const editor = JSON.stringify(options.editor);
	type(
		`export PATH=${bin}:"$PATH" VISUAL=${editor} EDITOR=${editor}; stty rows ${options.rows} cols ${options.columns}; clear\r`,
	);
	await drawing.shows(/^\$ ?$(?![\s\S]*stty)/m);
	return {
		...drawing,
		type,
		close: () => {
			child.kill("SIGHUP");
			return exited;
		},
	};
}
