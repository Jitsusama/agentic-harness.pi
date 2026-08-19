import { readFileSync } from "node:fs";
import type { Exec, ExecResult } from "@jitsusama/agentic-harness.core/exec";

/** One command a fake should answer, matched loosely. */
export interface Reply {
	/** Every fragment must appear among the args, in any order. */
	when: string[];
	stdout?: string;
	stderr?: string;
	code?: number;
}

/** A recorded invocation. */
export interface Invocation {
	command: string;
	args: string[];
	/**
	 * Contents of the file passed with `--input`, captured while
	 * the command runs. The caller deletes its own temp file, so
	 * reading it afterwards is too late; a real CLI reads it at
	 * exactly this moment.
	 */
	input?: string;
}

/** An exec that answers from a script and records what it saw. */
export function fakeExec(replies: Reply[]): {
	exec: Exec;
	calls: Invocation[];
} {
	const calls: Invocation[] = [];
	const exec: Exec = async (command, args) => {
		calls.push({ command, args, ...readInput(args) });
		const joined = args.join(" ");
		const reply = replies.find((candidate) =>
			candidate.when.every((fragment) => joined.includes(fragment)),
		);
		if (!reply) {
			const result: ExecResult = {
				code: 127,
				stdout: "",
				stderr: `fake exec has no answer for: ${command} ${joined}`,
			};
			return result;
		}
		return {
			code: reply.code ?? 0,
			stdout: reply.stdout ?? "",
			stderr: reply.stderr ?? "",
		};
	};
	return { exec, calls };
}

/** Read the `--input` payload, if the command has one. */
function readInput(args: string[]): { input?: string } {
	const at = args.indexOf("--input");
	if (at === -1) return {};
	const path = args[at + 1];
	if (!path) return {};
	try {
		return { input: readFileSync(path, "utf8") };
	} catch {
		// The command named a file that is not there, which is
		// itself worth seeing in a test rather than throwing here.
		return {};
	}
}

/** The args of the call matching every fragment given. */
export function callMatching(
	calls: Invocation[],
	...fragments: string[]
): Invocation | undefined {
	return calls.find((call) =>
		fragments.every((fragment) => call.args.join(" ").includes(fragment)),
	);
}
