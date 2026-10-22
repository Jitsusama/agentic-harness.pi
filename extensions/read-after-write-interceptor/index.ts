/**
 * Read After Write Interceptor Extension
 *
 * A read sent in the same batch as an edit or write to the same file is
 * read again once that write has landed, so it never answers from a file
 * caught half written.
 *
 * pi runs a batch's calls at once. It queues edits and writes to one file
 * behind each other, but not reads, and its writes empty the file before
 * filling it. So a read beside an edit can find the file empty: from 15
 * to 22 October, 18 reads said a long file had "1 lines total", every one
 * sent beside an edit or write of that file. A read without an offset
 * would have answered with nothing at all, and said so as a success.
 *
 * Silent, like every interceptor: the read answers as if it had been sent
 * after the write, which is the only order whose answer the agent can
 * use, since nothing in a batch can act on another's result. Reads with
 * no write beside them pay one map lookup.
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

/** How long a read waits for a write beside it before answering as it was. */
const MOST_WAIT_MS = 30_000;

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

interface Write {
	file: string;
	done: Promise<void>;
	finish: () => void;
}

export default function readAfterWriteInterceptor(pi: ExtensionAPI) {
	// Writes announced and not yet finished, by call id.
	const writes = new Map<string, Write>();
	// Each read's writes to wait for: those still to finish when it was
	// announced, and those announced while it ran.
	const reads = new Map<string, { file: string; waits: Set<Write> }>();
	let cwd = process.cwd();

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
	});

	pi.on("tool_execution_start", async (event) => {
		const file = fileOf(event.args, cwd);
		if (file === undefined) return;
		if (WRITERS.has(event.toolName)) {
			let finish = () => {};
			const done = new Promise<void>((settle) => {
				finish = settle;
			});
			const write = { file, done, finish };
			writes.set(event.toolCallId, write);
			for (const read of reads.values()) {
				if (read.file === file) read.waits.add(write);
			}
			return;
		}
		if (event.toolName !== "read") return;
		const waits = new Set(
			[...writes.values()].filter((write) => write.file === file),
		);
		reads.set(event.toolCallId, { file, waits });
	});

	const finished = (toolCallId: string) => {
		const write = writes.get(toolCallId);
		if (!write) return;
		writes.delete(toolCallId);
		write.finish();
	};

	pi.on("tool_execution_end", async (event) => {
		finished(event.toolCallId);
		reads.delete(event.toolCallId);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (WRITERS.has(event.toolName)) {
			finished(event.toolCallId);
			return undefined;
		}
		if (!isReadToolResult(event)) return undefined;
		const read = reads.get(event.toolCallId);
		reads.delete(event.toolCallId);
		if (!read || read.waits.size === 0) return undefined;
		return readAgain(event.toolCallId, event.input, read.waits, ctx.cwd);
	});
}

/** The read's answer once the writes beside it have landed. */
async function readAgain(
	toolCallId: string,
	input: Record<string, unknown>,
	waits: Set<Write>,
	cwd: string,
) {
	let timer: NodeJS.Timeout | undefined;
	const outOfTime = new Promise<void>((settle) => {
		timer = setTimeout(settle, MOST_WAIT_MS);
		timer.unref?.();
	});
	await Promise.race([
		Promise.all([...waits].map((write) => write.done)),
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
