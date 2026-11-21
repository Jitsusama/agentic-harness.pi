/**
 * Budgets kept as files, one a budget, in a folder the person owns.
 *
 * `<name>.env` holds the variables a session drawing on the budget
 * runs with, one `KEY=value` a line; a line `# label: <words>` gives
 * the label shown for it, and other `#` lines and blank ones are
 * passed over. `<name>`, with no suffix and executable, is run
 * instead, and what it prints is read the same way: for a key kept in
 * a password manager, or one minted fresh each time. A file wins over
 * a program of the same name.
 *
 * This is the provider anyone can use without writing one: an
 * Anthropic workspace key per client, a second proxy, a key for one
 * project. A name with neither file is not this provider's, so the
 * next is asked.
 */

import { execFile } from "node:child_process";
import {
	accessSync,
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	type BudgetAnswer,
	type BudgetProvider,
	isBudgetName,
} from "./provider.ts";
import { VARIABLE_NAME } from "./record.ts";

const run = promisify(execFile);

/** How long a budget's program may take before it is given up on. */
const PROGRAM_TIMEOUT_MS = 15_000;

/** What a budget file says: its variables and the label it gives. */
export interface BudgetFile {
	readonly env: Record<string, string>;
	readonly label?: string;
	/** Lines that were neither a variable, a comment nor blank. */
	readonly unread: readonly number[];
}

/** Read a budget file's text: `KEY=value` lines and a `# label:` line. */
export function parseBudgetFile(text: string): BudgetFile {
	const env: Record<string, string> = {};
	const unread: number[] = [];
	let label: string | undefined;
	text.split(/\r?\n/).forEach((raw, index) => {
		const line = raw.trim();
		if (line === "") return;
		if (line.startsWith("#")) {
			const said = /^#\s*label:\s*(.+)$/i.exec(line)?.[1];
			if (said !== undefined) label = said.trim();
			return;
		}
		const assignment = line.replace(/^export\s+/, "");
		const at = assignment.indexOf("=");
		const key = at > 0 ? assignment.slice(0, at).trim() : "";
		if (!VARIABLE_NAME.test(key)) {
			unread.push(index + 1);
			return;
		}
		env[key] = unquoted(assignment.slice(at + 1).trim());
	});
	return { env, ...(label ? { label } : {}), unread };
}

function unquoted(value: string): string {
	const quote = value[0];
	if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
		return value.slice(1, -1);
	}
	return value;
}

/** The provider that reads budgets from files and programs in `folder`. */
export function budgetFileProvider(
	folder: string,
	options: { readonly id?: string; readonly precedence?: number } = {},
): BudgetProvider {
	return {
		id: options.id ?? "budget-files",
		precedence: options.precedence ?? 0,
		resolve: (name) => resolveIn(folder, name),
	};
}

async function resolveIn(folder: string, name: string): Promise<BudgetAnswer> {
	// Any host on the bus may ask, and the name becomes a path this may
	// run, so one that could leave the folder is nobody's here.
	if (!isBudgetName(name)) return { kind: "unknown" };
	const file = join(folder, `${name}.env`);
	const program = join(folder, name);
	let text: string;
	let from: string;
	try {
		const read = readAtOnce(file);
		if (typeof read !== "string")
			return { kind: "unavailable", reason: read.why };
		text = read;
		from = file;
	} catch {
		// No file; a program of the name may answer instead.
		if (!executable(program)) return { kind: "unknown" };
		try {
			text = (await run(program, [], { timeout: PROGRAM_TIMEOUT_MS })).stdout;
			from = program;
		} catch (error) {
			return {
				kind: "unavailable",
				reason: `${program} failed${howItFailed(error)}.`,
			};
		}
	}
	const read = parseBudgetFile(text);
	if (Object.keys(read.env).length === 0) {
		return {
			kind: "unavailable",
			reason: `${from} sets no variables; write one KEY=value a line.`,
		};
	}
	if (read.unread.length > 0) {
		return {
			kind: "unavailable",
			reason: `${from} has lines that are not KEY=value (${read.unread.join(", ")}).`,
		};
	}
	return { kind: "drawn", env: read.env, label: read.label ?? name };
}

/**
 * How a budget program failed, after its path: its exit or the clock,
 * then what it wrote to stderr. Not execFile's message, which names
 * the path again and leaves little of the stderr once a reader cuts
 * it short.
 */
function howItFailed(error: unknown): string {
	if (!(error instanceof Error)) return `: ${String(error)}`;
	const code: unknown = Reflect.get(error, "code");
	const stderr: unknown = Reflect.get(error, "stderr");
	const said = typeof stderr === "string" ? stderr.trim() : "";
	const how =
		Reflect.get(error, "killed") === true
			? ` (stopped after ${PROGRAM_TIMEOUT_MS / MS_PER_SECOND} s)`
			: typeof code === "number"
				? ` (exit ${code})`
				: "";
	// Neither exit nor stderr: a spawn that never ran, said by its message.
	if (how === "" && said === "") return `: ${error.message}`;
	return said === "" ? how : `${how}: ${said}`;
}

const MS_PER_SECOND = 1000;

/** The most a budget file of a few lines may hold, read at once. */
const LARGEST_BUDGET_FILE = 64 * 1024;

/**
 * `file`'s text, read at once rather than through libuv's pool of four
 * threads, which a busy pi host shares with every conversation it
 * holds: a file of a few lines queued behind their reads missed the
 * draw's deadline, and left calls on the person's own key. A read at
 * once has no deadline to end it, so only a plain file of a few lines
 * is read: a pipe or a device, opened without waiting, is refused with
 * why, as one too large is. A folder on a hung mount still holds the
 * open, as it holds pi's own settings, which it reads the same way
 * from the same home. Throws when there is no file to open.
 */
function readAtOnce(file: string): string | { readonly why: string } {
	const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return { why: `${file} isn't a plain file.` };
		if (stat.size > LARGEST_BUDGET_FILE)
			return { why: `${file} is larger than a budget file is.` };
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}

/** Whether `path` is a program to run, asked at once as the file is read. */
function executable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		// Missing or not executable: either way, not a program to run.
		return false;
	}
}
