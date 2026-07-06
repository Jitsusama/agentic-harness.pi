/**
 * Shared registration helper for per-stage verify
 * extensions.
 *
 * Each `lib/internal/pr-workflow-verify/packs/{stage}.ts` file
 * builds a `StageContract` for its stage and passes it to
 * `registerVerifyExtension`. The helper handles the rest:
 * tool registration, parameter shape, success/failure
 * rendering and emitting the stage label in the tool's
 * result `details` (where the parent's reviewer-stream
 * watcher reads it back).
 *
 * Centralising this keeps the five per-stage extensions
 * tiny: each one declares its schema, item counter and
 * semantic checks, and the registration mechanics stay in
 * one place.
 */

import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type StageContract, validateOutput } from "./validate.js";

/**
 * Env var naming the file where a successful verification
 * envelope is written. The subagent supervisor sets it
 * before spawning the reviewer so the validated payload
 * travels out-of-band, on a file, instead of riding the
 * size-capped stdout event stream that used to drop large
 * reviews. Unset outside a supervised run, in which case
 * the tool behaves exactly as before.
 */
const VERIFY_OUTPUT_PATH_ENV = "SUBAGENT_VERIFY_OUTPUT_PATH";

/**
 * Persist a successful verification envelope to the path in
 * {@link VERIFY_OUTPUT_PATH_ENV}, when the supervisor set
 * it. Best-effort: a write failure must not fail the
 * reviewer, which still returns its result on the stream.
 */
async function persistVerifiedOutput(envelope: unknown): Promise<void> {
	const path = process.env[VERIFY_OUTPUT_PATH_ENV];
	if (!path) return;
	try {
		await writeFile(path, JSON.stringify(envelope), "utf-8");
	} catch {
		// The stream path remains as a fallback, so a failed
		// out-of-band write degrades rather than breaks.
	}
}

/** Register a `verify_output` tool that validates against `contract`. */
export function registerVerifyExtension(
	pi: ExtensionAPI,
	contract: StageContract,
): void {
	pi.registerTool({
		name: "verify_output",
		label: "Verify Output",
		description:
			`Validate your final ${contract.stage} output against the schema for ` +
			"this stage. Returns ok: true with the item count on success, or " +
			"ok: false with structured {path, message, hint} errors so you can " +
			"correct and retry. Pass `output` as the object itself; stringified " +
			"JSON is parsed with a warning so you can recover. Call this before " +
			"ending your run; only emit your final JSON block once it returns " +
			"ok: true.",
		parameters: Type.Object({
			output: Type.Unknown({
				description:
					"Your proposed JSON output. Pass the object itself (not a stringified copy).",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = validateOutput(contract, params.output);
			const stage = contract.stage;
			if (result.ok) {
				// Write the validated object to the out-of-band
				// envelope file so the parent reads it whole,
				// past the event-stream and assistant-text caps
				// that silently dropped large reviews.
				await persistVerifiedOutput({
					ok: true,
					stage,
					count: result.count,
					...(result.warnings ? { warnings: result.warnings } : {}),
					output: result.value,
				});
				const lines = [
					`ok: true. ${result.count} item${result.count === 1 ? "" : "s"} passed schema for stage=${stage}.`,
					...renderWarnings(result.warnings),
				];
				// Keep the streamed details small: the payload rides
				// the out-of-band file, not this event line (which
				// the parent caps). Drop `value` from what we stream.
				const { value: _value, ...streamedResult } = result;
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { ...streamedResult, stage },
				};
			}
			const lines = [
				`ok: false. ${result.errors.length} error${result.errors.length === 1 ? "" : "s"} against stage=${stage}:`,
				...renderWarnings(result.warnings),
				...result.errors.flatMap((e) => {
					const path = e.path === "" ? "(root)" : e.path;
					const rows = [`  ${path}: ${e.message}`];
					if (e.hint) rows.push(`    fix: ${e.hint}`);
					return rows;
				}),
				"Call verify_output again with the corrected object before emitting your final JSON block.",
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { ...result, stage },
				isError: true,
			};
		},
	});
}

function renderWarnings(warnings: readonly string[] | undefined): string[] {
	return (warnings ?? []).map((warning) => `warning: ${warning}`);
}
