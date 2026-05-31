/**
 * Subagent Workflow extension.
 *
 * Exposes a single `subagent` tool: fan N pi processes
 * out concurrently, each with its own persona, model,
 * tool palette and prompts. Returns each subagent's final
 * assistant text so the calling agent can synthesise,
 * compare or hand the outputs to the user.
 *
 * Three workloads were considered when sizing the API:
 *
 * - **Persona sweeps** — same problem, several roles
 *   (security/perf/readability). Different
 *   `systemPrompt`, same `userPrompt`.
 * - **Multi-angle investigation** — same area, different
 *   questions. Same `cwd`, different `userPrompt` per
 *   subagent.
 * - **Fleet brainstorming** — N copies of the same
 *   prompt across N models, asking for divergent
 *   answers. Same `userPrompt`, different `model`.
 *
 * The tool's parameters cover all three with a flat
 * `jobs[]` array. No worktree provisioning, no session
 * state, no orchestration heroics — the host agent
 * composes jobs and the tool runs them.
 *
 * The `subagent-fleet-guide` skill teaches the methodology
 * (when to fan out, persona shapes, cost etiquette); this
 * extension provides the substrate.
 *
 * Cancellation: ↑/↓ to select a subagent in the focused
 * progress panel, `r` to cancel the selected one, `Esc`
 * to cancel the whole fleet. Cancellation flows through
 * the engine's abort signal and surfaces as `cancelled`
 * state in the result payload.
 */

import { randomUUID } from "node:crypto";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { packageStateDir } from "../../lib/internal/package-state-dir.js";
import { ReviewerArtifactsStore } from "../../lib/subagent/artifacts.js";
import {
	registerSubagentDefaultExtension,
	registerSubagentDefaultSkill,
} from "../../lib/subagent/defaults.js";
import { createSupervisorRunPi } from "../../lib/subagent/runpi/supervisor.js";
import {
	FleetCancellationRegistry,
	formatFleetCancellation,
} from "./cancellation.js";
import { createFleetProgressReporter } from "./progress-render.js";
import {
	buildAssignment,
	dispatchFleet,
	type FleetAssignment,
	type FleetRunResult,
	formatFleetSummary,
} from "./run.js";

/**
 * Enrich a fleet result with the on-disk paths of its durable
 * artifacts. Resolves each subagent's `result.json` and the run
 * directory from the artifact store so callers can read the full
 * output directly rather than parsing it out of the payload.
 */
function locateArtifacts(
	stateDir: string,
	result: FleetRunResult,
): FleetRunResult {
	const store = new ReviewerArtifactsStore(stateDir);
	const runDir = store.rootPaths(result.runId).runDir;
	return {
		...result,
		runDir,
		results: result.results.map((r) => ({
			...r,
			resultPath: store.paths(result.runId, r.id).resultPath,
		})),
	};
}

/**
 * Event the extension emits once on activation. Carries
 * a {@link SubagentWorkflowApi} so other pi extensions
 * can register defaults without importing this package's
 * internals.
 *
 * Late-binding extensions that activate AFTER this one
 * miss the emit. They can still register defaults by
 * emitting {@link SUBAGENT_WORKFLOW_REGISTER_DEFAULT_EXTENSION}
 * or {@link SUBAGENT_WORKFLOW_REGISTER_DEFAULT_SKILL}
 * directly — the listeners stay subscribed for the
 * lifetime of the session. Mirrors the bidirectional
 * `pr-workflow:ready:v1` + `pr-workflow:*-provider:register:v1`
 * handshake used elsewhere in the package.
 */
export const SUBAGENT_WORKFLOW_READY = "subagent-workflow:ready:v1";

/**
 * Reverse-registration event. Listened to from extension
 * activation; payload is the absolute extension path to
 * inject into every subagent. Use this when listening for
 * {@link SUBAGENT_WORKFLOW_READY} isn't enough because
 * your extension may activate after this one.
 */
export const SUBAGENT_WORKFLOW_REGISTER_DEFAULT_EXTENSION =
	"subagent-workflow:register-default-extension:v1";

/**
 * Reverse-registration event for default skills. Payload
 * is the absolute path to a `SKILL.md` file. Same
 * load-order-safe motivation as
 * {@link SUBAGENT_WORKFLOW_REGISTER_DEFAULT_EXTENSION}.
 */
export const SUBAGENT_WORKFLOW_REGISTER_DEFAULT_SKILL =
	"subagent-workflow:register-default-skill:v1";

/**
 * Public hook surface for other pi extensions. Delivered
 * via the {@link SUBAGENT_WORKFLOW_READY} event. The two
 * methods are thin wrappers around the engine-wide
 * registry in `lib/subagent/defaults.ts`; calling them
 * from one extension makes the registered path available
 * to every subagent that any consumer spawns for the rest
 * of the session.
 */
export interface SubagentWorkflowApi {
	/**
	 * Inject this extension into every subagent. Absolute
	 * path to a `.ts`, `.mjs`, or directory-with-`index.ts`.
	 */
	registerDefaultExtension(path: string): void;
	/**
	 * Inject this skill into every subagent. Absolute path
	 * to a `SKILL.md` file.
	 */
	registerDefaultSkill(path: string): void;
}

export default function subagentWorkflow(pi: ExtensionAPI) {
	const stateDir = () => packageStateDir("subagent-workflow");
	const cancellations = new FleetCancellationRegistry();
	let runPi: ReturnType<typeof createSupervisorRunPi> | null = null;
	const getRunPi = () => {
		if (runPi !== null) return runPi;
		runPi = createSupervisorRunPi({ binary: "pi", stateDir: stateDir() });
		return runPi;
	};
	const controls = () => ({
		cancelSubagent: (subagentId: string) =>
			formatFleetCancellation(cancellations.cancel(subagentId)),
		cancelAll: () => formatFleetCancellation(cancellations.cancel()),
	});

	// Announce the registration hook for other pi
	// extensions. A Shopify-style credentials helper that
	// listens here can drop an extension path into the
	// engine-wide registry so even `isolated: true`
	// subagents inherit auth without the user having to
	// thread `extraExtensions` through every job.
	//
	// Two-way handshake: extensions that activate BEFORE
	// this one listen for SUBAGENT_WORKFLOW_READY and use
	// the API; extensions that activate AFTER this one
	// missed the emit and instead fire the reverse register
	// events below. The listeners stay subscribed for the
	// session, so timing never matters once both extensions
	// have activated.
	const registerDefaultExtensionFromEvent = (payload: unknown): void => {
		if (typeof payload !== "string") return;
		registerSubagentDefaultExtension(payload);
	};
	const registerDefaultSkillFromEvent = (payload: unknown): void => {
		if (typeof payload !== "string") return;
		registerSubagentDefaultSkill(payload);
	};
	pi.events.on(
		SUBAGENT_WORKFLOW_REGISTER_DEFAULT_EXTENSION,
		registerDefaultExtensionFromEvent,
	);
	pi.events.on(
		SUBAGENT_WORKFLOW_REGISTER_DEFAULT_SKILL,
		registerDefaultSkillFromEvent,
	);
	const api: SubagentWorkflowApi = {
		registerDefaultExtension: registerSubagentDefaultExtension,
		registerDefaultSkill: registerSubagentDefaultSkill,
	};
	pi.events.emit(SUBAGENT_WORKFLOW_READY, api);

	pi.registerTool({
		name: "subagent",
		label: "Subagent Fleet",
		description:
			"Fan N pi subagents out concurrently. Each gets its own pi " +
			"process, context window, model, tool palette and working " +
			"directory. Use for persona sweeps (security/performance/" +
			"readability of the same artifact), multi-angle investigation " +
			"(data flow vs lifecycle vs config of the same bug), or fleet " +
			"brainstorming (N answers from N models). Read the " +
			"subagent-fleet-guide skill for when and how. Returns each " +
			"subagent's final assistant text plus aggregate token/cost " +
			"figures.",
		promptSnippet:
			"Spawn parallel pi subagents for persona-driven, multi-angle " +
			"or fan-out work. The skill teaches when to reach for it; this " +
			"is the substrate.",
		parameters: Type.Object({
			jobs: Type.Array(
				Type.Object({
					id: Type.String({
						description:
							"Stable id for this subagent; appears in progress UI and on-disk artifact paths. Restricted to letters, digits, dot, underscore and dash so two ids cannot alias to the same artifact directory after path sanitization.",
						pattern: "^[a-zA-Z0-9._-]+$",
					}),
					model: Type.Optional(
						Type.String({
							description:
								"Pi --model value: bare model id (claude-opus-4-7) or provider/model (anthropic/claude-opus-4-7). Omit to inherit pi's session default.",
						}),
					),
					thinkingLevel: Type.Optional(
						StringEnum(
							["off", "minimal", "low", "medium", "high", "xhigh"] as const,
							{
								description:
									"Pi --thinking value. Omit to inherit pi's session default.",
							},
						),
					),
					tools: Type.Optional(
						Type.Array(Type.String(), {
							description:
								"Tool palette passed via --tools (e.g. [read,grep,glob,ls,bash]). Omit for the default palette.",
						}),
					),
					cwd: Type.String({
						description:
							"Working directory for the subprocess. Use the project root for ad-hoc work, or a worktree path if you need detachment.",
					}),
					systemPrompt: Type.Optional(
						Type.String({
							description:
								"Persona / baseline instructions sent via pi's --system-prompt. Use for role-based fan-outs (security reviewer, performance reviewer, contrarian, ...).",
						}),
					),
					userPrompt: Type.String({
						description:
							"The user prompt the subagent answers. Phrase it the way you'd phrase a question to a teammate; the subagent has the same tools and the same working directory.",
					}),
					isolated: Type.Optional(
						Type.Boolean({
							description:
								"When true, strip ambient inheritance (--no-skills --no-context-files --no-extensions) so the subagent sees only what you attach here. Defaults to true for the fleet tool — opt out when you want the subagent to share your local pi setup.",
						}),
					),
					extraExtensions: Type.Optional(
						Type.Array(Type.String(), {
							description:
								"Absolute paths to inject via --extension. Use for verify packs, custom tools or domain-specific helpers.",
						}),
					),
					extraSkills: Type.Optional(
						Type.Array(Type.String(), {
							description:
								"Absolute skill paths to inject via --skill. Use to teach the subagent an output contract or methodology without baking it into the prompt.",
						}),
					),
					timeoutMs: Type.Optional(
						Type.Integer({
							minimum: 1000,
							maximum: 8 * 60 * 60 * 1000,
							description:
								"Hard wall-clock timeout in milliseconds for this subagent. Overrides the runner's configured default. Use for jobs that legitimately run longer than the runner's default — deep investigations, soak tests, multi-step deploys. Per-job override; siblings keep the default. Capped at eight hours.",
						}),
					),
					idleTimeoutMs: Type.Optional(
						Type.Integer({
							minimum: 1000,
							maximum: 8 * 60 * 60 * 1000,
							description:
								"Idle timeout in milliseconds: how long the supervisor waits between progress events before declaring the child stuck. Overrides the runner's configured default. Bump this when the subagent's natural workflow contains long bash commands that stay silent on stdout (benchmark runs, git pushes against large mirrors, gcloud deploys). Per-job override; siblings keep the default. When set above the wall-clock default, also bump `timeoutMs` so the wall clock doesn't fire first. Capped at eight hours.",
						}),
					),
					verify: Type.Optional(
						Type.Object(
							{
								extensionPath: Type.String({
									description:
										"Absolute path to the verify extension entry file.",
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
									"Verify pack. When set, the subagent must call verify_output and return ok=true before the engine accepts the run.",
							},
						),
					),
				}),
				{
					description:
						"Subagent jobs to run concurrently. One pi process per job. Order is preserved in the result payload.",
					minItems: 1,
				},
			),
			runId: Type.Optional(
				Type.String({
					description:
						"Stable id for this fleet run. Used for durable supervisor artifacts and progress correlation. Auto-generated when omitted.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const runId = params.runId ?? `fleet-${randomUUID()}`;
			const assignments: FleetAssignment[] = params.jobs.map(buildAssignment);
			const progress = createFleetProgressReporter(ctx, controls());
			const result = await dispatchFleet({
				runId,
				assignments,
				runPi: getRunPi(),
				cancellations,
				progress,
				...(signal ? { signal } : {}),
			});
			// Decorate the result with on-disk artifact paths so the full
			// per-subagent output is discoverable from the summary and the
			// details payload, not buried in the supervisor's state dir.
			const located = locateArtifacts(stateDir(), result);
			return {
				content: [{ type: "text", text: formatFleetSummary(located) }],
				details: { ok: true, ...located },
			};
		},
	});
}
