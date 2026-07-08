/**
 * The advisor's read-only investigation tools.
 *
 * Three tools let the advisor check a suspicion against the
 * workspace without ever changing it: read a file slice, grep for
 * a pattern and glob for paths. They run under the session's cwd
 * and cap their output so a single call cannot flood the
 * advisor's context. Nothing here writes, moves or deletes.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { LoopTool } from "../../lib/completion/index.js";

/** Cap on characters returned by any one tool call. */
const MAX_OUTPUT = 4000;
/** Cap on lines a read returns when no limit is given. */
const DEFAULT_READ_LIMIT = 200;

/** Clamp text to the output cap with a truncation marker. */
function clamp(text: string): string {
	if (text.length <= MAX_OUTPUT) return text;
	return `${text.slice(0, MAX_OUTPUT)}\n... (truncated)`;
}

/** Resolve a caller path against the investigation root. */
function within(root: string, path: string): string {
	return isAbsolute(path) ? path : resolve(root, path);
}

/** Run a command under the root and resolve its stdout. */
function run(
	root: string,
	command: string,
	args: string[],
	signal?: AbortSignal,
): Promise<string> {
	return new Promise((resolveOut) => {
		const child = spawn(command, args, { cwd: root, signal });
		let out = "";
		child.stdout?.on("data", (chunk) => {
			out += chunk.toString();
		});
		child.on("error", (err) => resolveOut(`Command failed: ${err.message}`));
		child.on("close", () => resolveOut(out.trim() || "(no matches)"));
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
				let content: string;
				try {
					content = readFileSync(within(root, path), "utf8");
				} catch (err) {
					return `Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`;
				}
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
				const target = args.path ? within(root, String(args.path)) : ".";
				return clamp(
					await run(
						root,
						"rg",
						[
							"--line-number",
							"--no-heading",
							"--max-count",
							"50",
							pattern,
							target,
						],
						signal,
					),
				);
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
				return clamp(
					await run(root, "rg", ["--files", "--glob", pattern], signal),
				);
			},
		},
	];
}
