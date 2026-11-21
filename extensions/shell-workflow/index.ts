/**
 * Shell Workflow Extension
 *
 * Registers `bash` as pi's own bash tool, built with the same settings,
 * with five changes. The agent's commands run with no interactive editor
 * or pager, since nobody is at the keyboard to leave one. Each command is
 * kept off its shell's command line, so `pkill -f` with a pattern from it
 * kills what it names rather than the shell running it. A time limit on
 * work the machine's queue holds starts when its turn does, not while it
 * waits (lib/internal/priority/clock.ts). And a command
 * still running after a minute is handed to job-workflow rather than
 * holding the session silently: the call returns saying so, and the job
 * says how the command ended. A model expecting a long run passes
 * `background`; a codemode script's calls are never handed off, nor
 * are a print or JSON run's, which exits as its prompts end. A
 * session started with `PI_SANDBOX=strict` runs each command under
 * Landlock, with no credentials and no sockets but name lookups and
 * Nix's untrusted door (sandbox.ts); in the agent fence, a git command
 * the read-only shared git folder failed is told the route and counted
 * (fence/fence-git-route.ts). Each command keeps its output and
 * end on disk while it runs, so a session moving to a host can hand a
 * running one on rather than wait for it (keeping.ts).
 *
 * Everything else, the output truncation, the saved full output, the
 * rendering and the structured result codemode reads, is pi's.
 */

import {
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { sessionEnv } from "../../lib/core/session/env.ts";
import { sessionCwd, sessionKeyOf } from "../../lib/core/session/index.ts";
import { keepCompileCacheOutOfReach } from "../../lib/internal/fence/compile-cache-place.ts";
import { jobsBroker } from "../../lib/internal/fence/fence.ts";
import { routedDirenv } from "../../lib/internal/fence/fence-direnv.ts";
import {
	routedDelta,
	routedPackedRefs,
	routedSigning,
	routedUnheldTree,
} from "../../lib/internal/fence/fence-git-route.ts";
import { liftFence } from "../../lib/internal/fence/fence-lifted.ts";
import {
	codeOf,
	recordRefusal,
	recordUnlisted,
} from "../../lib/internal/fence/fence-log.ts";
import {
	routedKeep,
	routedReadOnly,
} from "../../lib/internal/fence/fence-route.ts";
import { settleStage } from "../../lib/internal/fence/fence-stage.ts";
import {
	FENCE_UNSAID,
	fenceOf,
	tellHostFence,
	tellHostLeft,
} from "../../lib/internal/sandbox/fence-told.ts";
import {
	askTheCloudAhead,
	sandboxFor,
} from "../../lib/internal/sandbox/sandbox.ts";
import { sweepKeptNowAndThen } from "../../lib/internal/shell/kept.ts";
import { watchSshGuard } from "../../lib/internal/shell/ssh-guard.ts";
import {
	endsWithItsPrompts,
	HAND_OFF_MS,
	spoken,
} from "../../lib/jobs/hand-off.ts";
import { type AgentBash, agentBash, type ShellSettings } from "./agent-bash.ts";
import { runOrHandOff } from "./hand-off.ts";
import { outlivingIt } from "./outliving.ts";
import { projectExecIn, setsProjectExec } from "./project-exec.ts";

/** The settings pi builds its own bash with, as this project sees them. */
function shellSettings(ctx: ExtensionContext): ShellSettings {
	try {
		const settings = SettingsManager.create(sessionCwd(ctx), getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		});
		const commandPrefix = settings.getShellCommandPrefix();
		const shellPath = settings.getShellPath();
		return {
			...(commandPrefix ? { commandPrefix } : {}),
			...(shellPath ? { shellPath } : {}),
		};
	} catch {
		// Settings pi could not read are settings pi ran without too; its
		// own bash falls back to the defaults the same way.
		return {};
	}
}

/** Whether this machine runs the jobs broker a fenced command may ask. */
const hasJobsBroker = (): boolean =>
	jobsBroker(process.env.XDG_RUNTIME_DIR) !== undefined;

/** The folder pi's bash is built with when only its shape is wanted. */
const SHAPE_ONLY = "";

/**
 * List a session spawned for the fence's first stage by its id too, so
 * reopening it keeps it fenced as it first ran.
 */
function listByIdOnce(session: string): void {
	try {
		settleStage(process.env, session);
	} catch (error) {
		// Unlisted by id, a reopen by id runs unfenced until the everyone
		// stage, as every reopen does; this session stays fenced as it is.
		void recordUnlisted({
			kind: "id",
			session,
			quest: process.env.QUEST_WORKFLOW_AUTOLOAD_ID,
			error: codeOf(error),
		});
	}
}

/** The refusals a fenced bash call's output is routed for. */
type RoutedRefusal =
	| "packed-refs"
	| "unheld-tree"
	| "signing"
	| "delta"
	| "keep"
	| "read-only"
	| "direnv";

/**
 * A fenced bash call's output with the route added where git couldn't
 * rewrite the read-only shared git folder's `packed-refs`, write the
 * own git folder of a tree the session doesn't hold, sign, or reach
 * World's Delta (`fence/fence-git-route.ts`), where a build couldn't
 * keep its pass, or where a write met a read-only mount
 * (`fence/fence-route.ts`), or where direnv refused an `.envrc`
 * (`fence/fence-direnv.ts`), counted in the
 * system's log; nothing, for any other call.
 */
function routeRefused(
	event: ToolResultEvent,
	logger: string | undefined,
	session: string,
): Pick<ToolResultEvent, "content" | "structuredContent"> | undefined {
	if (event.toolName !== "bash") return undefined;
	const counted =
		(kind: RoutedRefusal, tool = "git") =>
		() => {
			void recordRefusal({ kind, tool, sandbox: "fence", session }, logger);
		};
	const content =
		routedPackedRefs(event.content, counted("packed-refs")) ??
		routedUnheldTree(event.content, counted("unheld-tree")) ??
		routedSigning(event.content, counted("signing")) ??
		routedDelta(event.content, counted("delta")) ??
		routedKeep(event.content, counted("keep", "nix-offload")) ??
		routedDirenv(event.content, counted("direnv", "direnv")) ??
		routedReadOnly(event.content, counted("read-only", "bash"));
	// The structured result codemode reads is kept, its output as it was said.
	return content
		? { content, structuredContent: event.structuredContent }
		: undefined;
}

export default function shellWorkflow(pi: ExtensionAPI) {
	// The shape pi's bash is drawn and described with. Its folder is never
	// used: execution is per session, at the folder its conversation stands
	// in, and pi's description names none.
	const shape = createBashToolDefinition(SHAPE_ONLY);
	// Asked for when the session starts, by its environment (sandbox.ts),
	// with the fence lifted from all but subagents and spawns that declared
	// it, until it relands.
	liftFence();
	const sandbox = sandboxFor();
	// Said to a host, whose record a mycelium node carrying it reads, once
	// this shell's bash stands in pi's (as the session starts), and before
	// each command, which runs only once it is written.
	const toldHost = (ctx: ExtensionContext) =>
		tellHostFence(fenceOf(sandbox), "shell", {
			PI_SESSION_ID: sessionKeyOf(ctx),
		});
	let bash: AgentBash | undefined;
	// Whether ssh to the person's own machines is refused, read each
	// minute from the package config (lib/internal/shell/ssh-guard.ts). A
	// setting that can't be read is said where the person sees it.
	const onStderr = (why: string) => {
		process.stderr.write(`${why}\n`);
	};
	let tell = onStderr;
	const sshGuard = watchSshGuard(undefined, undefined, (why) => tell(why));
	// A bash given up closes its pi-spawner once its commands end, so a
	// reload or a new session leaves none running behind it.
	const retireBash = () => {
		bash?.retire();
		bash = undefined;
	};

	const bashFor = (ctx: ExtensionContext): AgentBash => {
		bash ??= agentBash(
			sessionCwd(ctx),
			shellSettings(ctx),
			sandbox,
			sessionKeyOf(ctx),
			{},
			sshGuard.current,
		);
		return bash;
	};

	// A stray PI_SANDBOX read as the fence is said once, where the person
	// sees it, and in the agent's guidelines below.
	let noted = false;
	// The session this runner heard last as it started, for its shutdown,
	// whose context may not be read once the runner is gone.
	let session: string | undefined;
	pi.on("session_start", async (_event, ctx) => {
		session = sessionKeyOf(ctx);
		// Before any command: every pi it starts compiles where the fence
		// can't write (compile-cache-place.ts).
		keepCompileCacheOutOfReach(sessionEnv(ctx));
		retireBash();
		bashFor(ctx);
		// A host's pi runs a folder's own extensions' commands only through
		// the exec set here, and refuses them until one is, so it is set
		// for every session, unfenced ones running them as pi would.
		if (setsProjectExec(pi)) {
			pi.setProjectExec(
				projectExecIn(sandbox, () => sessionEnv(ctx).snapshot()),
			);
		}
		toldHost(ctx);
		tell = ctx.hasUI ? (why) => ctx.ui.notify(why, "warning") : onStderr;
		sshGuard.start();
		if (!noted && sandbox.kind === "fence" && sandbox.note) {
			noted = true;
			if (ctx.hasUI) ctx.ui.notify(sandbox.note, "warning");
		}
		if (sandbox.kind === "fence") listByIdOnce(sessionKeyOf(ctx));
		askTheCloudAhead(sandbox);
		// What a call kept and nobody took up, a week on, swept once an hour
		// for the process however many sessions it starts (kept.ts).
		void sweepKeptNowAndThen();
	});
	pi.on("session_shutdown", () => {
		retireBash();
		sshGuard.stop();
		// A read still out lands after this session's ctx is gone.
		tell = onStderr;
		// Its record names no fence until the next runner's guards say one.
		tellHostLeft(session);
	});
	if (sandbox.kind === "fence")
		pi.on("tool_result", (event, ctx) =>
			routeRefused(event, sandbox.logger, sessionKeyOf(ctx)),
		);

	pi.registerTool({
		...shape,
		description: `${shape.description} A command still running after ${spoken(HAND_OFF_MS)} moves to the background, and its result arrives later as a message of its own, so the session never stops hearing the person or other sessions for longer than that.`,
		promptGuidelines: [
			...(shape.promptGuidelines ?? []),
			"Let a command's output through: do not pipe it into tail or head to keep it short, since bash already keeps the end and saves the full output to a file, and a pipe hides all progress until the command ends.",
			"Do not sleep in bash to wait for something. Pass background: true for a command expected to run long, or use a tool's own watch, and carry on; the result arrives as its own message. A call sent with background: true may sleep between its checks; never pause by reading /dev/zero or /dev/urandom, or with yes, which keeps a core busy the whole time.",
			...(sandbox.kind === "strict"
				? [
						"Commands run in a strict sandbox, since this session reads what strangers wrote: no credentials, no SSH or signing agent, no session or system bus, writes only to the working folder and the sandbox's own TMPDIR and cache (not /tmp or ~/.cache), and Nix as an untrusted user. gcloud, where the machine gives a token, acts as the agents' own cloud account in its one project, never the person's login. A refusal there is the sandbox, not a fault: do the work another way, or say what needs the person.",
					]
				: []),
			...(sandbox.kind === "fence"
				? [
						"Commands run in the agent fence: their own processes only, no display, compositor, session or system bus, sound, keyring, password, clipboard or SSH agent, settings and startup files (~/.config, shell rc files, ~/.ssh, ~/.pi/agent) read-only, and Nix as an untrusted user. The work, the network and the environment are as they were. A `nix-offload there ...` call on its own, with nothing chained on, runs outside the fence. A refusal there is the fence, not a fault: do the work another way (commit and push with the work tool), or say what needs the person.",
						...(sandbox.note ? [sandbox.note] : []),
						...(hasJobsBroker()
							? [
									"Inside the agent fence the cgroup tree is read-only and systemctl and systemd-run can't reach the account's systemd. For how a unit stands, run `jobs-broker status UNIT...` rather than `systemctl --user status`; for a command that wants a scope of its own, run `jobs-broker run -- COMMAND` rather than `systemd-run --user --scope`.",
								]
							: []),
					]
				: []),
			// Only where /proc lets a stop find what left the group (reap.ts).
			...(process.platform === "linux"
				? [
						`A process a command starts dies when the command is stopped or times out, or when the pi host that ran it restarts, whatever group, session or scope it moved to: setsid, nohup, \`jobs-broker run\` and a \`systemd-run --user --scope\` landing in pi's cgroup or the jobs slice all still carry the command's marks. ${outlivingIt(sandbox.kind)}`,
					]
				: []),
			// Only where commands are placed in the jobs cgroup: elsewhere
			// nice still ranks a command against what the person uses.
			...(process.env.JOBS_CGROUP
				? [
						"Do not add nice or ionice to a command. Every command already runs in a cgroup below everything the person uses, where nice only ranks it against other agents' work: a niced VM test loses to every build beside it and times out, and a niced nix build slows only its own evaluation, since the Nix daemon does the building.",
						"Builds, test suites, evaluations of a flake's checks or a whole machine, and searches of a whole World checkout wait their turn here while the machine is busy. Build or evaluate a repository's Nix checks through `nix-offload there` instead, which does it elsewhere, and search the zone you mean rather than the whole checkout.",
					]
				: []),
		],
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({
					description:
						"Timeout in seconds (optional, no default timeout). It measures the run: work waiting for its turn in the machine's queue starts it when its turn comes.",
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description: `true to run it in the background at once. False or left out, a command still running after ${spoken(HAND_OFF_MS)} moves to the background; nothing waits longer.`,
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!toldHost(ctx)) throw new Error(FENCE_UNSAID);
			const definition = bashFor(ctx);
			return await runOrHandOff({
				command: params.command,
				toolCallId,
				session: sessionKeyOf(ctx),
				...(params.background !== undefined
					? { background: params.background }
					: {}),
				// pi numbers a script's calls under the call that ran it.
				nested: toolCallId.includes("/") || endsWithItsPrompts(ctx.mode),
				signal,
				onUpdate,
				bus: pi.events,
				carryOf: (owned) => definition.carryOf(owned),
				run: (owned, update) =>
					definition.execute(
						toolCallId,
						{
							command: params.command,
							...(params.timeout !== undefined
								? { timeout: params.timeout }
								: {}),
						},
						owned,
						update,
						ctx,
					),
			});
		},
	});
}
