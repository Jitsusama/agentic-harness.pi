/**
 * The advisor's read-only investigation tools.
 *
 * Three tools let the advisor check a suspicion against the
 * workspace without ever changing it: read a file slice, grep for
 * a pattern and glob for paths. They run under the session's cwd
 * and cap their output so a single call cannot flood the
 * advisor's context. Nothing here writes, moves or deletes.
 *
 * The advisor's tool-call arguments are steered by transcript
 * content, which is untrusted (web fetches, file and issue text),
 * so these tools are hardened against that: paths are contained
 * to the root, the search pattern is bound as a flag value behind
 * a `--` terminator so it cannot smuggle in ripgrep flags such as
 * `--pre` (which would run an arbitrary command), reads are size
 * capped, and every subprocess is time and output bounded.
 */

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { LoopTool } from "../../lib/completion/index.js";

/** Cap on characters returned by any one tool call. */
const MAX_OUTPUT = 4000;
/** Cap on lines a read returns when no limit is given. */
const DEFAULT_READ_LIMIT = 200;
/** Refuse to read a file larger than this. */
const MAX_READ_BYTES = 1_000_000;
/** Wall-clock cap on any one subprocess. */
const RUN_TIMEOUT_MS = 10_000;

/** Clamp text to the output cap with a truncation marker. */
function clamp(text: string): string {
	if (text.length <= MAX_OUTPUT) return text;
	return `${text.slice(0, MAX_OUTPUT)}\n... (truncated)`;
}

/**
 * Resolve a caller path against the investigation root and refuse
 * anything that escapes it. An absolute path or a `..` climb that
 * lands outside the root throws rather than reading the host.
 */
export function resolveWithinRoot(root: string, path: string): string {
	const base = resolve(root);
	const abs = resolve(base, path);
	if (abs !== base && !abs.startsWith(base + sep)) {
		throw new Error(`path escapes the investigation root: ${path}`);
	}
	return abs;
}

/**
 * Build ripgrep args that search for `pattern` under `target`
 * safely: the pattern rides `--regexp` as a bound value and a
 * `--` terminator precedes the path, so neither can be parsed as
 * a ripgrep flag (closing the `--pre` command-execution hole).
 */
export function grepArgs(pattern: string, target: string): string[] {
	return [
		"--line-number",
		"--no-heading",
		"--max-count",
		"50",
		"--regexp",
		pattern,
		"--",
		target,
	];
}

/** Build ripgrep args that list files matching `pattern` safely. */
export function globArgs(pattern: string): string[] {
	// --glob binds the pattern as its value, so it cannot be parsed
	// as a flag; there is no positional to smuggle a path into.
	return ["--files", "--glob", pattern];
}

/**
 * Run a command under the root, bounded by a wall-clock timeout
 * and an output cap. The child is killed when either trips or the
 * turn's signal aborts, so a wedged or gushing search cannot hang
 * the advisor or exhaust memory.
 */
function run(
	root: string,
	command: string,
	args: string[],
	signal?: AbortSignal,
): Promise<string> {
	return new Promise((resolveOut) => {
		const child = spawn(command, args, { cwd: root, signal });
		let out = "";
		let done = false;
		const finish = (text: string): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				child.kill("SIGKILL");
			} catch {
				// Already exited; nothing to kill.
			}
			resolveOut(text);
		};
		const timer = setTimeout(
			() => finish(out.trim() || "(timed out)"),
			RUN_TIMEOUT_MS,
		);
		child.stdout?.on("data", (chunk) => {
			out += chunk.toString();
			// Stop accumulating well past the clamp so a huge result
			// cannot balloon memory before it is truncated.
			if (out.length > MAX_OUTPUT * 2) finish(out);
		});
		child.on("error", (err) => finish(`Command failed: ${err.message}`));
		child.on("close", () => finish(out.trim() || "(no matches)"));
	});
}

/**
 * Build the read-only tool set rooted at `root`. The optional
 * signal aborts a long-running grep or glob with the turn.
 */
export function investigationTools(
	root: string,
	signal?: AbortSignal,
): LoopTool[] {
	return [
		{
			name: "read_file",
			description:
				"Read a slice of a file. Args: path (string), offset (1-indexed " +
				"start line, optional), limit (max lines, optional).",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					offset: { type: "number" },
					limit: { type: "number" },
				},
				required: ["path"],
			},
			async execute(args) {
				const path = String(args.path ?? "");
				if (!path) return "read_file needs a path.";
				let resolved: string;
				try {
					resolved = resolveWithinRoot(root, path);
				} catch (err) {
					return err instanceof Error ? err.message : String(err);
				}
				let stats: ReturnType<typeof statSync>;
				try {
					stats = statSync(resolved);
				} catch (err) {
					return `Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`;
				}
				if (!stats.isFile()) return `Refused: ${path} is not a regular file.`;
				if (stats.size > MAX_READ_BYTES) {
					return `Refused: ${path} is too large (${stats.size} bytes).`;
				}
				const content = readFileSync(resolved, "utf8");
				const lines = content.split("\n");
				const offset =
					typeof args.offset === "number" ? Math.max(1, args.offset) : 1;
				const limit =
					typeof args.limit === "number" ? args.limit : DEFAULT_READ_LIMIT;
				const slice = lines.slice(offset - 1, offset - 1 + limit);
				return clamp(
					slice.map((line, i) => `${offset + i}: ${line}`).join("\n"),
				);
			},
		},
		{
			name: "grep",
			description:
				"Search for a regex across files. Args: pattern (string), path " +
				"(directory or file to search, optional).",
			parameters: {
				type: "object",
				properties: {
					pattern: { type: "string" },
					path: { type: "string" },
				},
				required: ["pattern"],
			},
			async execute(args) {
				const pattern = String(args.pattern ?? "");
				if (!pattern) return "grep needs a pattern.";
				let target = ".";
				if (args.path) {
					try {
						target = resolveWithinRoot(root, String(args.path));
					} catch (err) {
						return err instanceof Error ? err.message : String(err);
					}
				}
				return clamp(await run(root, "rg", grepArgs(pattern, target), signal));
			},
		},
		{
			name: "glob",
			description: "List paths matching a glob. Args: pattern (string).",
			parameters: {
				type: "object",
				properties: { pattern: { type: "string" } },
				required: ["pattern"],
			},
			async execute(args) {
				const pattern = String(args.pattern ?? "");
				if (!pattern) return "glob needs a pattern.";
				return clamp(await run(root, "rg", globArgs(pattern), signal));
			},
		},
	];
}
