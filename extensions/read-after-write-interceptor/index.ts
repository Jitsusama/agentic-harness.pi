/**
 * Read After Write Interceptor Extension
 *
 * A read sent in the same batch as a call that writes its file is read
 * again once that call has finished, so it never answers from a file
 * caught half written or not yet made.
 *
 * pi runs a batch's calls at once. It queues edits and writes to one file
 * behind each other, but not reads, and its writes empty the file before
 * filling it. So a read beside an edit can find the file empty: from 15
 * to 22 October, 18 reads said a long file had "1 lines total", every one
 * sent beside an edit or write of that file. A read without an offset
 * would have answered with nothing at all, and said so as a success.
 *
 * A shell command is the other writer. A read sent beside the command
 * that makes its file, a screenshot most often, finds nothing there: in
 * the same week 81 reads in one session failed that way, each beside the
 * command taking the picture, and each cost a turn to read again. Which
 * file a command writes cannot be told from its text, so a read that
 * found no file waits for every command beside it, and one that found
 * its file is left alone.
 *
 * Silent, like every interceptor: the read answers as if it had been sent
 * after its writer, which is the only order whose answer the agent can
 * use, since nothing in a batch can act on another's result. The wait
 * costs no time, since the batch's turn waits for every call anyway.
 * Reads with no writer beside them pay one map lookup.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	createReadTool,
	type ExtensionAPI,
	isReadToolResult,
} from "@earendil-works/pi-coding-agent";

/** The tools that write a file, which pi queues per file. */
const WRITERS = new Set(["edit", "write"]);

/** The tool whose writes cannot be told from its arguments. */
const SHELL = "bash";

/**
 * How long a read waits for its writers before answering as it was. The
 * bash tool hands a command still running after a minute to the
 * background, so no writer beside a read outlasts this.
 */
const MOST_WAIT_MS = 5 * 60_000;

/** What a read says of a file that is not there. */
const MISSING = /ENOENT/;

/** Where a tool's path points, as pi's file tools read it. */
function fileOf(input: unknown, cwd: string): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const { path } = input as { path?: unknown };
	if (typeof path !== "string") return undefined;
	const bare = path.startsWith("@") ? path.slice(1) : path;
	if (bare === "~") return homedir();
	if (bare.startsWith("~/")) return join(homedir(), bare.slice(2));
	return resolve(cwd, bare);
}

/** A call that may write a file, from its announcement to its result. */
interface Writer {
	/** The file it writes, or undefined for a command that may write any. */
	file: string | undefined;
	done: Promise<void>;
	finish: () => void;
}

/** Whether `writer` may write the file a read at `file` reads. */
const mayWrite = (writer: Writer, file: string) =>
	writer.file === undefined || writer.file === file;

export default function readAfterWriteInterceptor(pi: ExtensionAPI) {
	// Writers announced and not yet finished, by call id.
	const writers = new Map<string, Writer>();
	// Each read's writers to wait for: those still to finish when it was
	// announced, and those announced while it ran.
	const reads = new Map<string, { file: string; waits: Set<Writer> }>();
	let cwd = process.cwd();

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
	});

	pi.on("tool_execution_start", async (event) => {
		const shell = event.toolName === SHELL;
		const file = shell ? undefined : fileOf(event.args, cwd);
		if (shell || (file !== undefined && WRITERS.has(event.toolName))) {
			let finish = () => {};
			const done = new Promise<void>((settle) => {
				finish = settle;
			});
			const writer = { file, done, finish };
			writers.set(event.toolCallId, writer);
			for (const read of reads.values()) {
				if (mayWrite(writer, read.file)) read.waits.add(writer);
			}
			return;
		}
		if (event.toolName !== "read" || file === undefined) return;
		const waits = new Set(
			[...writers.values()].filter((writer) => mayWrite(writer, file)),
		);
		reads.set(event.toolCallId, { file, waits });
	});

	const finished = (toolCallId: string) => {
		const writer = writers.get(toolCallId);
		if (!writer) return;
		writers.delete(toolCallId);
		writer.finish();
	};

	pi.on("tool_execution_end", async (event) => {
		finished(event.toolCallId);
		reads.delete(event.toolCallId);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!isReadToolResult(event)) {
			finished(event.toolCallId);
			return undefined;
		}
		const read = reads.get(event.toolCallId);
		reads.delete(event.toolCallId);
		if (!read) return undefined;
		// A command beside the read matters only when the read found no
		// file: one that found it was not racing anything it could see.
		const missing = event.isError && MISSING.test(textOf(event.content));
		const waits = [...read.waits].filter(
			(writer) => writer.file !== undefined || missing,
		);
		if (waits.length === 0) return undefined;
		return readAgain(event.toolCallId, event.input, waits, ctx.cwd);
	});
}

/** The text of a tool result's content. */
function textOf(content: readonly unknown[]): string {
	return content
		.map((part) =>
			typeof part === "object" && part !== null && "text" in part
				? String((part as { text: unknown }).text)
				: "",
		)
		.join("");
}

/** The read's answer once the writers beside it have finished. */
async function readAgain(
	toolCallId: string,
	input: Record<string, unknown>,
	waits: readonly Writer[],
	cwd: string,
) {
	let timer: NodeJS.Timeout | undefined;
	const outOfTime = new Promise<void>((settle) => {
		timer = setTimeout(settle, MOST_WAIT_MS);
		timer.unref?.();
	});
	await Promise.race([
		Promise.all(waits.map((writer) => writer.done)),
		outOfTime,
	]);
	clearTimeout(timer);
	const tool = createReadTool(cwd);
	try {
		const again = await tool.execute(
			toolCallId,
			input as Parameters<typeof tool.execute>[1],
		);
		return { content: again.content, details: again.details, isError: false };
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text" as const, text }], isError: true };
	}
}
