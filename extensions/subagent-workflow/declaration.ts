/**
 * What the model reads of the `subagent` tool: its description, its
 * guidelines and the shape of its parameters.
 *
 * Apart from the tool's wiring, since this is the part that changes
 * when the wording or a job's options do, and it is most of the file's
 * length.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { THINKING_LEVELS } from "../../lib/thinking/index.ts";

/** What the tool is for, read when deciding whether to load it. */
export const SUBAGENT_DESCRIPTION =
	"Fan N pi subagents out concurrently. Each gets its own pi " +
	"process, context window, model, tool palette and working " +
	"directory. Use for persona sweeps (security/performance/" +
	"readability of the same artifact), multi-angle investigation " +
	"(data flow vs lifecycle vs config of the same bug), or fleet " +
	"brainstorming (N answers from N personas). Read the " +
	"subagent-fleet-guide skill for when and how. Returns each " +
	"subagent's final assistant text plus aggregate token/cost " +
	"figures.";

/** The tool's line in the system prompt's list of loadable tools. */
export const SUBAGENT_PROMPT_SNIPPET =
	"Spawn parallel pi subagents for persona-driven, multi-angle " +
	"or fan-out work. The skill teaches when to reach for it; this " +
	"is the substrate.";

/** How to size a fleet and what it runs on. */
export const SUBAGENT_GUIDELINES = [
	"Size a fleet to the angles it needs: one job per angle the others do not cover. A fleet past subagent.maxJobs (8 by default) is refused; do not split it into two calls to get under the cap.",
	"Leave model off every job, and thinkingLevel unless a job needs something different. They are filled, first match winning, from the run's defaults, the loaded quest's and the project's subagent settings, subagent.defaults, then the session's own model at high thinking; the answer says what each job ran on.",
	"A fleet runs on one model and gets its spread from personas, never from other models. A job or run default naming another model than the fleet would use unnamed is refused, unless the person asked for that model by name.",
];

/** The jobs a call runs, and the settings shared between them. */
export const SUBAGENT_PARAMETERS = Type.Object({
	jobs: Type.Array(
		Type.Object({
			id: Type.String({
				description:
					"Stable id for this subagent, shown on the board and naming its artifacts.",
				pattern: "^[a-zA-Z0-9._-]+$",
			}),
			model: Type.Optional(
				Type.String({
					description:
						"provider/model or a bare model id. Omit to take the run's defaults, then the configured settings, then the session's model.",
				}),
			),
			thinkingLevel: Type.Optional(
				StringEnum(
					// The shared list, so this schema and the one the review
					// tools offer cannot come to disagree about what pi takes.
					THINKING_LEVELS,
					{
						description:
							"Omit to take the same layers as model, and otherwise high.",
					},
				),
			),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description: "Tool palette, e.g. [read,bash]. Omit for the default.",
				}),
			),
			cwd: Type.String({
				description:
					"Working directory: the project root, or a worktree for detached work.",
			}),
			systemPrompt: Type.Optional(
				Type.String({
					description: "Persona instructions, for role-based fan-outs.",
				}),
			),
			userPrompt: Type.String({
				description:
					"What the subagent answers, phrased as you would ask a teammate.",
			}),
			isolated: Type.Optional(
				Type.Boolean({
					description:
						"Defaults to true: the subagent sees only what you attach, not your skills, context files or extensions. A folder's own .pi is never loaded either way.",
				}),
			),
			extraExtensions: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Absolute extension paths to load, only from pi's installed packages.",
				}),
			),
			extraSkills: Type.Optional(
				Type.Array(Type.String(), {
					description: "Absolute skill paths to load, e.g. an output contract.",
				}),
			),
			timeoutMs: Type.Optional(
				Type.Integer({
					minimum: 1000,
					maximum: 8 * 60 * 60 * 1000,
					description:
						"Wall-clock limit for this job, for work that runs long. At most eight hours.",
				}),
			),
			idleTimeoutMs: Type.Optional(
				Type.Integer({
					minimum: 1000,
					maximum: 8 * 60 * 60 * 1000,
					description:
						"How long the job may be silent before it counts as stuck. Raise it, and timeoutMs with it, for long quiet commands such as cloud deletes or benchmarks.",
				}),
			),
			verify: Type.Optional(
				Type.Object(
					{
						extensionPath: Type.String({
							description:
								"Absolute path to the verify extension entry file, in pi's installed packages.",
						}),
						skillPath: Type.Optional(
							Type.String({
								description:
									"Absolute path to the companion contract skill, when present.",
							}),
						),
					},
					{
						description:
							"Verify pack: the subagent must pass verify_output before its run is accepted.",
					},
				),
			),
		}),
		{
			description:
				"Jobs to run at once, one pi process each, answered in order.",
			minItems: 1,
		},
	),
	runId: Type.Optional(
		Type.String({
			// Held to the same shape a job id is held to, and for a
			// sharper reason: this one keys both the transcript
			// directory and the ledger record that protects it, so two
			// ids that sanitize alike share protection, and one
			// finishing releases the other's.
			pattern: "^[a-zA-Z0-9._-]+$",
			description:
				"Stable id for this run, naming its artifacts. Generated when omitted.",
		}),
	),
	defaults: Type.Optional(
		Type.Object(
			{
				model: Type.Optional(Type.String()),
				thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS)),
				tools: Type.Optional(Type.Array(Type.String())),
				timeoutMs: Type.Optional(Type.Integer()),
				idleTimeoutMs: Type.Optional(Type.Integer()),
			},
			{
				description:
					"Settings for every job in this run that does not set its own: model, thinkingLevel, tools and the two clocks. They come before the quest's, the project's and the config's subagent settings, and the session's model.",
			},
		),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Return at once and let the fleet run on; its summary arrives later as its own message, so carry on rather than poll.",
		}),
	),
});
