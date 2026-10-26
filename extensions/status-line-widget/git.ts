/**
 * Git's state for the line, from the machine's own engine.
 *
 * The engine speaks gitstatusd's protocol: a request is an id and a folder,
 * an answer is the id and the repository's state, one each, over the
 * program's standard input and output. It is started the first time it is
 * needed and kept, so each question costs a write rather than a process,
 * and it is asked only when something may have changed the answer. Nothing
 * polls.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { withPi } from "../../lib/internal/priority/place.ts";

/** What git is in the middle of, with its steps when it keeps count. */
export interface Operation {
	readonly name: string;
	readonly at?: number;
	readonly of?: number;
}

export interface GitState {
	readonly workdir: string;
	/** The local branch, or the commit's first seven characters. */
	readonly branch: string;
	readonly unsaved: boolean;
	readonly conflicted: boolean;
	readonly ahead: boolean;
	readonly op: Operation | null;
}

/** Between an answer's fields, and after each answer. */
const UNIT = "\x1f";
const RECORD = "\x1e";

function firstLine(file: string): string | null {
	try {
		return readFileSync(file, "utf8").split("\n")[0] ?? null;
	} catch {
		return null;
	}
}

/**
 * Where a work tree's repository keeps its state: `.git` itself, or for a
 * linked work tree, the folder its `.git` file names.
 */
export function gitDir(workdir: string): string | null {
	const dot = path.join(workdir, ".git");
	try {
		if (statSync(dot).isDirectory()) return dot;
	} catch {
		return null;
	}
	const named = firstLine(dot)?.match(/^gitdir: (.+)$/)?.[1];
	if (!named) return null;
	return path.isAbsolute(named) ? named : path.join(workdir, named);
}

/** What git is in the middle of, read from the files it keeps meanwhile. */
export function operation(dir: string | null): Operation | null {
	if (!dir) return null;
	const at = (file: string) => path.join(dir, file);
	let name: string;
	let step: string | null = null;
	let steps: string | null = null;
	if (existsSync(at("rebase-merge"))) {
		name = "rebase";
		step = firstLine(at("rebase-merge/msgnum"));
		steps = firstLine(at("rebase-merge/end"));
	} else if (existsSync(at("rebase-apply"))) {
		name = existsSync(at("rebase-apply/applying")) ? "am" : "rebase";
		step = firstLine(at("rebase-apply/next"));
		steps = firstLine(at("rebase-apply/last"));
	} else if (existsSync(at("MERGE_HEAD"))) {
		name = "merge";
	} else if (existsSync(at("CHERRY_PICK_HEAD"))) {
		name = "pick";
	} else if (existsSync(at("REVERT_HEAD"))) {
		name = "revert";
	} else if (existsSync(at("BISECT_LOG"))) {
		name = "bisect";
	} else {
		return null;
	}
	const n = Number(step);
	const of = Number(steps);
	if (Number.isInteger(n) && Number.isInteger(of) && n >= 1 && of >= 1) {
		return { name, at: n, of };
	}
	return { name };
}

/**
 * One answer: its id, and the folder's state, or false outside a
 * repository. Counts come from the index's size on, and only whether each
 * is above zero is drawn.
 */
export function parseAnswer(
	record: string,
	readOperation: (workdir: string) => Operation | null = (workdir) =>
		operation(gitDir(workdir)),
): { id: string; state: GitState | false } {
	const fields = record.split(UNIT);
	const id = fields[0] ?? "";
	if (fields[1] !== "1") return { id, state: false };
	const count = (at: number) => Number(fields[at]) || 0;
	const workdir = fields[2] ?? "";
	const local = fields[4] ?? "";
	return {
		id,
		state: {
			workdir,
			branch: local !== "" ? local : (fields[3] ?? "").slice(0, 7),
			unsaved: count(10) + count(11) + count(13) > 0,
			conflicted: count(12) > 0,
			ahead: count(14) > 0,
			op: readOperation(workdir),
		},
	};
}

/** Lets a stream go without keeping node running for it. */
function letGo(stream: unknown): void {
	(stream as { unref?: () => void } | null)?.unref?.();
}

/**
 * The engine, asked about one folder at a time. A question asked while
 * one is out is held, and only the latest folder is asked once the answer
 * comes, so a burst of tool calls costs two questions rather than one each.
 */
export class Engine {
	private child: ChildProcess | null = null;
	private broken = false;
	private heard = "";
	private asking: string | null = null;
	private waiting: string | null = null;
	private next = 0;
	private spoke = false;
	private readonly questions = new Map<string, string>();

	private readonly program: string;
	private readonly answered: (dir: string, state: GitState | false) => void;
	private readonly readOperation?: (workdir: string) => Operation | null;

	constructor(
		program: string,
		answered: (dir: string, state: GitState | false) => void,
		readOperation?: (workdir: string) => Operation | null,
	) {
		this.program = program;
		this.answered = answered;
		this.readOperation = readOperation;
	}

	ask(dir: string): void {
		if (this.broken) return;
		if (this.asking !== null) {
			this.waiting = dir;
			return;
		}
		if (!existsSync(dir)) return;
		const child = this.started();
		if (!child?.stdin) return;
		this.next += 1;
		const id = String(this.next);
		this.asking = id;
		this.questions.set(id, dir);
		child.stdin.write(`${id}${UNIT}${dir}${UNIT}${RECORD}`);
	}

	/** Ends the engine, which exits once its input closes. */
	stop(): void {
		this.child?.stdin?.end();
		this.child = null;
	}

	private started(): ChildProcess | null {
		if (this.child) return this.child;
		let child: ChildProcess;
		try {
			// Kept where pi is rather than with the work pi starts: it answers
			// for pi's own screen, and beside the builds it fell behind.
			child = withPi(() =>
				spawn(this.program, ["-s", "1", "-u", "1", "-c", "1", "-d", "1"], {
					stdio: ["pipe", "pipe", "ignore"],
				}),
			);
		} catch {
			this.broken = true;
			return null;
		}
		child.on("error", () => {
			// A program that can't be started won't start next time either.
			this.broken = true;
			this.forget(child);
		});
		child.on("exit", () => this.forget(child));
		child.stdin?.on("error", () => this.forget(child));
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (data: string) => this.hear(data));
		child.unref();
		letGo(child.stdin);
		letGo(child.stdout);
		this.child = child;
		return child;
	}

	private forget(child: ChildProcess): void {
		if (this.child !== child) return;
		// One that ends before it ever answers would only end again, so the
		// line goes on with pi's own branch rather than starting it each time.
		if (!this.spoke) this.broken = true;
		this.child = null;
		this.heard = "";
		this.asking = null;
		this.questions.clear();
	}

	private hear(data: string): void {
		this.spoke = true;
		this.heard += data;
		let stop = this.heard.indexOf(RECORD);
		while (stop >= 0) {
			const { id, state } = parseAnswer(
				this.heard.slice(0, stop),
				this.readOperation,
			);
			this.heard = this.heard.slice(stop + 1);
			const dir = this.questions.get(id);
			this.questions.delete(id);
			if (id === this.asking) this.asking = null;
			if (dir !== undefined) this.answered(dir, state);
			stop = this.heard.indexOf(RECORD);
		}
		const held = this.waiting;
		if (this.asking === null && held !== null) {
			this.waiting = null;
			this.ask(held);
		}
	}
}
