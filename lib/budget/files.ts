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
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	type BudgetAnswer,
	type BudgetProvider,
	isBudgetName,
} from "./provider.ts";

const run = promisify(execFile);

/** How long a budget's program may take before it is given up on. */
const PROGRAM_TIMEOUT_MS = 15_000;

/** A variable's name, as a shell would take it. */
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
			const said = /^#\s*label:\s*(.+)$/i.exec(line);
			if (said) label = said[1].trim();
			return;
		}
		const assignment = line.replace(/^export\s+/, "");
		const at = assignment.indexOf("=");
		const key = at > 0 ? assignment.slice(0, at).trim() : "";
		if (!VARIABLE.test(key)) {
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
		text = await readFile(file, "utf8");
		from = file;
	} catch {
		// No file; a program of the name may answer instead.
		if (!(await executable(program))) return { kind: "unknown" };
		try {
			text = (await run(program, [], { timeout: PROGRAM_TIMEOUT_MS })).stdout;
			from = program;
		} catch (error) {
			return {
				kind: "unavailable",
				reason: `${program} failed: ${error instanceof Error ? error.message : String(error)}.`,
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

async function executable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		// Missing or not executable: either way, not a program to run.
		return false;
	}
}
