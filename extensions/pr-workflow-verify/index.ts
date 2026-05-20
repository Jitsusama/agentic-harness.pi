/**
 * pr-workflow-verify
 *
 * A tiny sibling extension that registers a single
 * `verify_output` tool. The PR workflow loads this
 * extension into every reviewer subagent it spawns via
 * pi's `--extension` flag. The reviewer's prompt
 * instructs it to call `verify_output` with its proposed
 * JSON before ending the run; if validation fails, the
 * subagent fixes its output and verifies again until it
 * passes.
 *
 * The tool body delegates to `validateOutput`, which is
 * a pure function over the shared TypeBox schemas in
 * `../pr-workflow/schemas.ts`. Same schema, same parser,
 * zero drift between "the subagent thought it was valid"
 * and "the parent rejected it anyway".
 *
 * This extension never auto-loads on top-level pi
 * sessions: pr-workflow passes it through `--extension`
 * to each subagent and nowhere else.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { validateOutput } from "./src/validate.js";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "verify_output",
		label: "Verify Output",
		description:
			"Validate your final reviewer output against the schema for the " +
			"named stage (council, judge, critique, stack-review, or " +
			"stack-judge). Returns " +
			"ok: true with the parsed item count, or ok: false with a list of " +
			"{path, message} errors. Call this before ending your run; if " +
			"errors are reported, fix your output and call again until ok: true.",
		parameters: Type.Object({
			stage: Type.Union(
				[
					Type.Literal("council"),
					Type.Literal("judge"),
					Type.Literal("critique"),
					Type.Literal("stack-review"),
					Type.Literal("stack-judge"),
				],
				{
					description:
						"Which reviewer stage produced this output: council (round 1), judge (round 2), critique (round 3), stack-review (stack-wide reviewer), or stack-judge (stack-wide judge).",
				},
			),
			output: Type.Unknown({
				description:
					"Your proposed JSON output. Pass the object itself (not a stringified copy).",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = validateOutput(params.stage, params.output);
			if (result.ok) {
				return {
					content: [
						{
							type: "text",
							text: `ok: true. ${result.count} item${result.count === 1 ? "" : "s"} passed schema for stage=${params.stage}.`,
						},
					],
					details: result,
				};
			}
			const lines = [
				`ok: false. ${result.errors.length} error${result.errors.length === 1 ? "" : "s"} against stage=${params.stage}:`,
				...result.errors.map(
					(e) => `  ${e.path === "" ? "(root)" : e.path}: ${e.message}`,
				),
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: result,
				isError: true,
			};
		},
	});
}
