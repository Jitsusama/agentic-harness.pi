/**
 * Session verbs: attach, detach, rename. Plus the
 * `spawn-*` verbs that open a new terminal tab, pane or
 * window via the registered terminal driver.
 */

import { homedir, hostname } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionEnv } from "../../../lib/core/session/index.ts";
import { discoverQuests } from "../../../lib/internal/quest/discovery.ts";
import {
	FIRST_WORDS_VARIABLE,
	leaveFirstWords,
	spawnedWords,
} from "../../../lib/internal/quest/first-words.ts";
import {
	ancestorTreesOf,
	type CwdSource,
	describeCwdSource,
	pickResumeSession,
	reopenedCwd,
	resolveSpawnCwd,
} from "../../../lib/internal/quest/reopen.ts";
import {
	SESSION_MARK,
	settleHere,
} from "../../../lib/internal/quest/reopen-in-place.ts";
import {
	deriveLiveness,
	formatRelativeAge,
	type SessionView,
} from "../../../lib/internal/quest/session-liveness.ts";
import {
	openInSessionsKitty,
	sessionsKittyRuns,
} from "../../../lib/internal/quest/sessions-kitty.ts";
import { hostHold } from "../../../lib/internal/session/host-holds.ts";
import { uuidv7 } from "../../../lib/internal/session/uuidv7.ts";
import type { QuestSession } from "../../../lib/quest/index.ts";
import {
	describePlan,
	type OpenedTerminal,
	openTerminal,
} from "../../../lib/terminal/index.ts";
import { count } from "../../../lib/ui/count.ts";
import { offerReopen } from "../first-turn-watch.ts";
import {
	attachSessionInQuestDir,
	captureSessionIdentity,
	detachSessionInQuestDir,
	reconcileSessionMembership,
	renameSessionInQuestDir,
} from "../lifecycle.ts";
import { buildSessionSnapshot } from "../liveness.ts";
import {
	auditSessionMembership,
	getQuestEntry,
	planDeadSessions,
	planSessionRepair,
} from "../lookup.ts";
import type { QuestState } from "../state.ts";
import { terminalOptions } from "../terminal.ts";
import { trustPromptNote, trustPromptWaits } from "../trust-prompt.ts";
import {
	handedPlaceFor,
	presencesHere,
	windowPlaceFor,
} from "../window-place.ts";
import { addressOf } from "./address.ts";
import { needsOf } from "./needs.ts";
import {
	currentSessionId,
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";
import {
	agentCommand,
	isThisMachine,
	machineFor,
	spawnHeld,
	startsPi,
} from "./spawn-held.ts";
import { hostTargetOf, reachedInHost, spawnByHost } from "./spawn-host.ts";
import {
	launcherOpens,
	launcherSession,
	resumedBy,
	spawnedByLauncher,
} from "./spawn-launcher.ts";

/**
 * Repair session-to-quest membership across the store, in two
 * independent passes read from two authorities:
 *
 * - Divergence: a session active on more than one quest is resolved
 *   to the one its own log names as owner (see `planSessionRepair`).
 * - Provably dead: an active session whose captured identity a probe
 *   reads gone is a detach candidate (see `planDeadSessions`). Only
 *   identity-backed deadness qualifies, so this is an observation the
 *   user acts on, never the recency heuristic rewriting membership.
 *
 * Previews both by default and mutates nothing; `force:true` applies
 * the divergence detaches and the dead detaches. Conflicted records
 * (a log naming no claimant) are always left for the user to resolve
 * by loading the true quest.
 */
export async function sessionAudit(
	state: QuestState,
	params: QuestToolParams,
): Promise<QuestResult> {
	const plan = planSessionRepair(state);
	// A session whose claims are conflicted is left for the user to
	// resolve by loading its true quest; the dead pass must respect that
	// same rule, so a dead-and-conflicted session is not force-detached
	// out from under the unresolved decision.
	const conflictedIds = new Set(plan.conflicted.map((d) => d.sessionId));
	const dead = (await planDeadSessions(state)).filter(
		(d) => !conflictedIds.has(d.sessionId),
	);
	if (
		plan.resolvable.length === 0 &&
		plan.conflicted.length === 0 &&
		dead.length === 0
	) {
		return ok("No session divergence: every session is active on one quest.", {
			divergences: auditSessionMembership(state),
			plan,
			dead,
		});
	}
	const resolvableLines = plan.resolvable.map(
		(r) =>
			`${r.sessionId} -> keep ${r.keep}, detach from ${r.detachFrom.join(", ")}`,
	);
	const conflictedLines = plan.conflicted.map(
		(d) =>
			`${d.sessionId} conflicted across ${d.questIds.join(", ")} (log names no claimant)`,
	);
	const deadLines = dead.map(
		(d) => `${d.sessionId} dead (probe) on ${d.questId}; would detach`,
	);
	if (!params.force) {
		const parts = [
			`${plan.resolvable.length} resolvable, ${dead.length} dead, ${plan.conflicted.length} conflicted. Pass force:true to apply the resolvable and dead detaches; conflicted records are left for you to resolve by loading the true quest.`,
			...resolvableLines,
			...deadLines,
			...conflictedLines,
		];
		return ok(parts.join("\n"), { plan, dead, applied: false });
	}
	let detached = 0;
	for (const entry of plan.resolvable) {
		const gone = reconcileSessionMembership(state, entry.sessionId, entry.keep);
		detached += gone.length;
	}
	let deadDetached = 0;
	for (const entry of dead) {
		const target = getQuestEntry(state, entry.questId);
		if (!target) continue;
		const result = detachSessionInQuestDir(target.dir, entry.sessionId);
		if (result.ok && result.detached) deadDetached += 1;
	}
	const summary = [
		`Repaired ${count(plan.resolvable.length, "divergent session")}, detached ${count(detached, "stray membership")}; detached ${count(deadDetached, "dead session")}. ${count(plan.conflicted.length, "conflicted record")} left untouched.`,
		...conflictedLines,
	];
	return ok(summary.join("\n"), {
		plan,
		dead,
		applied: true,
		detached,
		deadDetached,
	});
}

/**
 * The quest a session verb acts on: the one `id` names, loaded or not,
 * or else the loaded one. On 29 October a detach naming another quest
 * acted on the loaded one and found nothing, leaving the session active
 * on the quest it had left.
 */
function sessionQuest(
	state: QuestState,
	params: QuestToolParams,
): { questId: string; questDir: string } | { refusal: string } {
	if (!params.id?.trim() && !state.questId) {
		return { refusal: "Load a quest first, or name it as `id`." };
	}
	const target = addressOf(state, params.id, { focused: false });
	if ("refusal" in target) return target;
	return { questId: target.questId, questDir: target.questDir };
}

export function sessionAttach(
	state: QuestState,
	ctx: ExtensionContext,
	params: QuestToolParams,
): QuestResult {
	const quest = sessionQuest(state, params);
	if ("refusal" in quest) return refuse(quest.refusal);
	const id = currentSessionId(ctx, params.sessionId);
	if (!id) {
		return refuse(
			"Could not determine current pi session id. Pass it explicitly in `sessionId`.",
		);
	}
	const session: QuestSession = {
		id,
		started: new Date().toISOString(),
		status: "active",
	};
	if (params.name?.trim()) session.name = params.name.trim();
	if (params.cwd?.trim()) session.cwd = params.cwd.trim();
	else if (ctx.cwd) session.cwd = ctx.cwd;
	// Capture liveness identity only when attaching this process's own
	// session; an explicit sessionId for another session must not be
	// tagged with our process and terminal.
	if (id === currentSessionId(ctx, undefined)) {
		const identity = captureSessionIdentity();
		session.instanceId = identity.instanceId;
		if (identity.process) session.process = identity.process;
		if (identity.terminal) session.terminal = identity.terminal;
	}
	const result = attachSessionInQuestDir(quest.questDir, session);
	if (!result.ok) return refuse(result.guidance);
	return ok(
		result.added
			? `Attached session ${id} to ${quest.questId}.`
			: `Session ${id} was already attached to ${quest.questId}; refreshed status.`,
		{ session, added: result.added },
	);
}

export function sessionDetach(
	state: QuestState,
	ctx: ExtensionContext,
	params: QuestToolParams,
): QuestResult {
	const quest = sessionQuest(state, params);
	if ("refusal" in quest) return refuse(quest.refusal);
	const id = currentSessionId(ctx, params.sessionId);
	if (!id) {
		return refuse(
			"Could not determine session id to detach. Pass it explicitly in `sessionId`.",
		);
	}
	const result = detachSessionInQuestDir(quest.questDir, id);
	if (!result.ok) return refuse(result.guidance);
	if (!result.detached) {
		return refuse(
			`Session ${id} is not attached (or already detached) on ${quest.questId}.`,
		);
	}
	return ok(`Detached session ${id} from ${quest.questId}.`, {
		sessionId: id,
	});
}

export function sessionRename(
	state: QuestState,
	ctx: ExtensionContext,
	params: QuestToolParams,
): QuestResult {
	const quest = sessionQuest(state, params);
	if ("refusal" in quest) return refuse(quest.refusal);
	if (!params.name?.trim())
		return refuse("Pass the new session name in `name`.");
	const id = currentSessionId(ctx, params.sessionId);
	if (!id) return refuse("Pass a session id in `sessionId`.");
	const result = renameSessionInQuestDir(
		quest.questDir,
		id,
		params.name.trim(),
	);
	if (!result.ok) return refuse(result.guidance);
	if (!result.renamed) {
		return refuse(
			`Session ${id} is not attached to ${quest.questId} or already has that name.`,
		);
	}
	return ok(`Renamed session ${id} to "${params.name.trim()}".`, {
		sessionId: id,
		name: params.name.trim(),
	});
}

/**
 * Decide the command the spawned terminal runs. An explicit command
 * wins outright. Otherwise, when exactly one resumable session was
 * picked, resume it with `pi --session <id>`; with no resumable
 * session (none or several), start a fresh `pi`.
 */
export function resolveSpawnCommand(
	explicitCommand: string | undefined,
	resume: ReturnType<typeof pickResumeSession>,
): { command: string; resumedSessionId?: string } {
	if (explicitCommand?.trim()) return { command: explicitCommand.trim() };
	if (resume && "id" in resume) {
		return {
			command: `pi --session ${resume.id}`,
			resumedSessionId: resume.id,
		};
	}
	return { command: "pi" };
}

/**
 * The model a session runs on, as `pi --model` takes it: provider, id
 * and thinking level, as `anthropic/claude-opus-5-5:high`. Undefined
 * when the session has no model yet.
 */
export function modelOf(
	ctx: Pick<ExtensionContext, "model" | "thinkingLevel">,
): string | undefined {
	const { model, thinkingLevel } = ctx;
	if (!model) return undefined;
	const named = `${model.provider}/${model.id}`;
	return thinkingLevel ? `${named}:${thinkingLevel}` : named;
}

/**
 * The command a spawn runs with the model of the session asking for it,
 * so the new one runs on the same model rather than on whatever pi's
 * default says: on 9 November a launcher pi is wrapped in changed that
 * default, and every session spawned after ran on another model. A
 * command already naming a model keeps its own.
 */
export function carryingModel(
	command: string,
	model: string | undefined,
): string {
	if (!model || /(^| )--model( |=)/.test(command)) return command;
	return `${command} --model ${model}`;
}

/**
 * The resume fragment appended to the spawn message. A live resume
 * reads plainly; an idle resume is flagged as such and carries its
 * last-active age so a day-old session is not silently presented as
 * current. Several live sessions report the count; nothing
 * resumable yields no fragment.
 */
export function resumeMessage(
	resume: ReturnType<typeof pickResumeSession>,
	sessions: SessionView[],
	now: Date,
): string | undefined {
	if (resume && "id" in resume) {
		const picked = sessions.find((s) => s.id === resume.id);
		if (picked?.liveness === "idle") {
			const age = formatRelativeAge(picked.lastActivity, now);
			return `Resuming idle session ${resume.id}${age ? `, last active ${age}` : ""}.`;
		}
		return `Resuming session ${resume.id}.`;
	}
	if (resume && "ambiguous" in resume) {
		return `${resume.ambiguous.length} live sessions; started fresh, resume one explicitly if needed.`;
	}
	return undefined;
}

export async function spawn(
	state: QuestState,
	ctx: ExtensionContext,
	params: QuestToolParams,
): Promise<QuestResult> {
	// A suffixed verb names its layout; a bare spawn leaves it to the
	// terminal settings unless the call gives one.
	const suffix = params.action.startsWith("spawn-")
		? params.action.slice("spawn-".length)
		: undefined;
	const asked = params.layout ?? suffix;
	// A host target is explicit and goes alone, so a clash is refused
	// before anything else is read.
	const target = hostTargetOf(params);
	if (!target.ok) return refuse(target.refusal);
	// An explicit `id:` lets the agent open a tab for
	// another quest without touching its own loaded state.
	// We resolve through discovery so a typo fails fast.
	const targetId = params.id ?? state.questId ?? undefined;
	if (!targetId) {
		return refuse("Load a quest first, or pass an explicit `id`.");
	}
	const entry = getQuestEntry(state, targetId);
	if (!entry) {
		return refuse(`No quest with id "${targetId}".`);
	}
	const questIdForSpawn = entry.doc.frontMatter.id;
	const fm = entry.doc.frontMatter;

	// Resolve the working directory: prefer a quest-owned
	// tree, then a recent session's cwd, then a tree's repo
	// root, then the repo its ancestors work in (never their
	// trees, which are theirs alone), then the repo this session
	// works in, then home, never a folder of the quest store. A recorded path that no longer exists self-heals to
	// the next candidate.
	const now = new Date();
	const snapshot = await buildSessionSnapshot(fm.sessions, { now });
	const sessions = fm.sessions.map((s) => deriveLiveness(s, snapshot));
	const { index } = discoverQuests(state.questsRoot);
	const resolved = resolveSpawnCwd({
		questDir: entry.dir,
		store: state.questsRoot,
		trees: fm.trees ?? [],
		sessions,
		ancestors: ancestorTreesOf(
			fm.parent ?? undefined,
			(id) => index.quests.get(id)?.doc.frontMatter,
		),
		...(ctx.cwd ? { spawner: ctx.cwd } : {}),
	});
	const given = params.cwd?.trim();
	let cwd = given || resolved.cwd;
	// What chose it, as the answer says it: the call's own cwd wins.
	let cwdSource: CwdSource | "given" = given ? "given" : resolved.source;
	let chosenBy = given
		? "the folder the call named"
		: describeCwdSource(resolved.source);

	// Pick the session to resume, excluding the one doing the
	// spawning. pickResumeSession prefers a live session, falls back
	// to the most-recent idle one, and only reports ambiguity when
	// several are concurrently live; in that case spawn starts a
	// fresh pi and surfaces the choice rather than guessing.
	const currentId = currentSessionId(ctx, undefined);
	// A session's history is saved on its own machine, so one started on
	// another starts fresh; which machine that is may be the node's to
	// choose, by what the session needs of it. A machine or needs the
	// call names replace what the quest says it needs, never add to it.
	const named = params.machine?.trim() || undefined;
	const chosen = await machineFor(
		named,
		named !== undefined || params.needs !== undefined
			? (params.needs ?? [])
			: needsOf(fm),
	);
	if (!chosen.ok) return refuse(chosen.refusal);
	const { machine, needs } = chosen;
	const resume =
		machine === undefined || isThisMachine(machine)
			? pickResumeSession(sessions.filter((s) => s.id !== currentId))
			: undefined;
	// A session a host holds is reached through that host, never opened
	// again here or adopted by another, which would give its log a second
	// writer. A command of the caller's own resumes nothing.
	const resuming =
		resume && "id" in resume && !params.command?.trim() ? resume.id : undefined;
	const hold = resuming ? await hostHold(resuming) : undefined;
	if (resuming && hold) return reachedInHost(resuming, hold);
	const here = machine ?? hostname().split(".")[0] ?? "";
	const picked =
		resume && "id" in resume
			? sessions.find((s) => s.id === resume.id)
			: undefined;
	// The host the call names, or for a plain spawn the one spawnHost says.
	const byHost = await spawnByHost({
		...(target.kind ? { asked: target.kind } : {}),
		params,
		...(machine !== undefined && !isThisMachine(machine)
			? { elsewhere: machine }
			: {}),
		agent: () => agentCommand("pi", here),
		spawn: {
			questId: questIdForSpawn,
			cwd,
			chosenBy,
			...(params.note !== undefined ? { note: params.note } : {}),
			...(picked ? { resume: picked } : {}),
			...(ctx.model
				? { model: { provider: ctx.model.provider, id: ctx.model.id } }
				: {}),
			...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
			env: sessionEnv(ctx).snapshot(),
			...(params.dryRun ? { dryRun: true } : {}),
		},
	});
	if ("result" in byHost) return byHost.result;
	const settingNote = byHost.terminalNote;
	const spawned = resolveSpawnCommand(params.command, resume);
	const { resumedSessionId } = spawned;
	// A reopen starts where its session ran, since pi finds a session by
	// id only among the logs of the folder it starts in.
	const reopenedIn = given
		? undefined
		: reopenedCwd({
				command: spawned.command,
				sessions,
				questDir: entry.dir,
				store: state.questsRoot,
			});
	if (reopenedIn) {
		cwd = reopenedIn;
		cwdSource = "reopened";
		chosenBy = describeCwdSource("reopened");
	}
	// A realm whose node declares another command for its agent sessions,
	// as Joel's personal one declares pi-claude, starts that instead.
	const spawnsPi = !params.command?.trim();
	const agents = spawnsPi
		? await agentCommand(spawned.command, here)
		: spawned.command;
	// The pi it starts runs on the asking session's model. Another agent a
	// realm declares keeps its own, since its models aren't this one's.
	const command =
		spawnsPi && agents === spawned.command
			? carryingModel(agents, modelOf(ctx))
			: agents;
	// A pi that will stop at the folder-trust prompt is said so at once;
	// one held on another machine is that machine's to judge.
	const trustWaits =
		startsPi(command) &&
		(machine === undefined || isThisMachine(machine)) &&
		trustPromptWaits(cwd, command);
	// Every answer ends with what holds it up and, under spawnHost, why it
	// opened in a terminal rather than the host.
	const trustNote = `${trustWaits ? trustPromptNote(cwd) : ""}${settingNote}`;
	const trusting = trustWaits ? { trustWaits: cwd } : {};

	// Pass the target quest id through to the spawned
	// process via an env var. The new pi's quest-workflow
	// extension reads this on session_start and uses it to
	// load the right quest, which in turn names the session
	// after the quest. A resumed session restores its own
	// loaded quest from history, but the env var is harmless
	// and covers a fresh pi.
	const env: Record<string, string> = {
		QUEST_WORKFLOW_AUTOLOAD_ID: questIdForSpawn,
	};
	// What the new session is told first, so it sets to work on its quest
	// by itself rather than waiting to be poked (P9R1KI [76e6439f]). A pi
	// the caller starts its own way is told too, since `pi --model ...`
	// left CF3ZG0 untold for 44 minutes on 11-03; any other command is
	// left as it is.
	const firstWords =
		(spawnsPi || startsPi(spawned.command)) && !params.dryRun
			? spawnedWords(questIdForSpawn, params.note)
			: undefined;
	const leftUnder = (key: string): string | undefined => {
		if (!firstWords) return undefined;
		try {
			leaveFirstWords(key, firstWords);
			return key;
		} catch {
			// The session still starts, only without being told to carry on.
			return undefined;
		}
	};
	const read = await terminalOptions(
		{
			...(params.terminal ? { terminal: params.terminal } : {}),
			...(params.nesting ? { nesting: params.nesting } : {}),
			...(asked ? { layout: asked } : {}),
			...(params.dryRun ? { dryRun: true } : {}),
		},
		{ questId: questIdForSpawn, cwd },
	);
	if (!read.ok) return refuse(read.refusal);
	if (machine !== undefined) {
		// Words are left on this machine, so only a session held here can
		// take them.
		const token = isThisMachine(machine) ? leftUnder(uuidv7()) : undefined;
		const held = await spawnHeld({
			machine,
			needs,
			command,
			cwd,
			home: homedir(),
			questId: questIdForSpawn,
			...(token ? { firstWords: token } : {}),
			...(read.layout ? { layout: read.layout } : {}),
			options: read.options,
		});
		if (!held.ok) return refuse(held.refusal);
		const resumed = held.planned
			? undefined
			: params.command?.trim()
				? undefined
				: resumeMessage(resume, sessions, now);
		const said = resumed ? `${held.message} ${resumed}` : held.message;
		return ok(`${said}${trustNote}`, {
			...held.details,
			...(token && !held.planned ? { firstWordsKey: token } : {}),
			...trusting,
			cwd,
			command,
			resumedSessionId,
			autoloadQuestId: questIdForSpawn,
		});
	}
	// A restart replaces the session's window rather than adding one: one
	// a holder runs is left, one held parked is woken in its own window,
	// and a dead one's windows are closed first.
	const restarting = resumedSessionId ?? resumedBy(command)?.id;
	if (restarting && !params.dryRun) {
		const settled = await settleHere([restarting]);
		const hosting = settled.hosted.find((one) => one.session === restarting);
		if (hosting) return reachedInHost(restarting, hosting.hold);
		if (settled.running.includes(restarting)) {
			return ok(
				`Session ${restarting} is already running under its holder, so nothing was opened.`,
				{ how: "running", sessionId: restarting, cwd, command },
			);
		}
		if (settled.woken.includes(restarting)) {
			return ok(
				`Woke session ${restarting} in its own window, where its holder kept it parked.`,
				{ how: "woken", sessionId: restarting, cwd, command },
			);
		}
		if (settled.parked.includes(restarting)) {
			return refuse(
				`Session ${restarting} is held parked, and its holder can't be woken from here; a key in its window wakes it. Nothing was opened, since a second pi on one log would split it.`,
			);
		}
	}
	// A kitty window of plain pi is the launcher's to open, so one placer
	// orders every pi window on the screen; it opens here when it doesn't
	// answer.
	const asking = currentSessionId(ctx, undefined);
	const forLauncher = launcherSession({
		command,
		cwd,
		questId: questIdForSpawn,
		named: Boolean(params.terminal?.trim() || asked || params.nesting?.trim()),
		...(asking ? { fromSessionId: asking } : {}),
		place: handedPlaceFor(questIdForSpawn, index),
	});
	// The launcher carries only the session's id through, so its words are
	// left under that; a window opened here names the same key in its
	// environment, which also covers the launcher not answering.
	const token = leftUnder(forLauncher?.id ?? uuidv7());
	if (token) env[FIRST_WORDS_VARIABLE] = token;
	// The command is typed into a login shell the terminal opens, so the
	// person's startup files put the right pi on PATH; handed to the
	// terminal directly it would run without them.
	const request = {
		...(read.layout ? { layout: read.layout } : {}),
		command,
		cwd,
		env,
		// Its window closes with its pi, sits with its orchestrator's, and
		// says whose it was.
		endsWithCommand: spawnsPi || startsPi(spawned.command),
		window: windowPlaceFor(
			questIdForSpawn,
			cwd,
			index,
			presencesHere(),
			restarting,
		),
		...(restarting ? { marks: { [SESSION_MARK]: restarting } } : {}),
	};
	const resumeNote = params.command?.trim()
		? undefined
		: resumeMessage(resume, sessions, now);
	const handed =
		forLauncher && !params.dryRun
			? await spawnedByLauncher(forLauncher, request, read.options)
			: "unasked";
	// Where the launcher would have opened it: in the desktop's sessions
	// kitty, where every pi window on this machine belongs, else as the
	// settings say.
	const openHere = async (): Promise<string> => {
		if (handed !== "unasked" && sessionsKittyRuns()) {
			return openInSessionsKitty({ command, cwd, env });
		}
		const opened = await openTerminal(request, read.options);
		return `a ${opened.plan.layout} in ${cwd} through ${describePlan(opened.plan)}`;
	};
	if (forLauncher && (handed === "taken" || handed === "unanswered")) {
		const what = forLauncher.fresh
			? `a new session, ${forLauncher.id}, which loads ${questIdForSpawn} as it starts`
			: `session ${forLauncher.id}, which brings back its own quest`;
		// The launcher's window can die where one opened from here lives:
		// from 11-10 04:27 its holder ran pi without the PATH Shopify's
		// wrapper fetches its key by, and every session it started exited.
		if (token) offerReopen(token, openHere);
		const late =
			handed === "unanswered"
				? " Its shell was too busy to answer, but it still holds the call, so the window opens once it gets to it, and none was opened here."
				: "";
		return ok(
			`Handed ${what}, to the desktop's launcher, which opens it in a kitty window in ${cwd} (${chosenBy}), back where it sat or else beside where you are.${late} Should its pi start and then end without taking its first words, this session opens it again itself.${resolved.healed ? " A recorded path was missing; healed to this one." : ""}${resumeNote ? ` ${resumeNote}` : ""}${trustNote}`,
			{
				how: "launcher",
				...(handed === "unanswered" ? { unanswered: true } : {}),
				sessionId: forLauncher.id,
				...(token ? { firstWordsKey: token } : {}),
				...trusting,
				fresh: forLauncher.fresh === true,
				layout: "window",
				cwd,
				cwdSource,
				healed: resolved.healed ?? false,
				command,
				resumedSessionId,
				autoloadQuestId: questIdForSpawn,
			},
		);
	}
	if (handed === "untaken" && sessionsKittyRuns()) {
		let where: string;
		try {
			where = await openInSessionsKitty({ command, cwd, env });
		} catch (err) {
			return refuse(`Spawn failed: ${(err as Error).message}`);
		}
		return ok(
			`Spawned ${where} (${chosenBy}), since the desktop's launcher didn't take it.${resolved.healed ? " A recorded path was missing; healed to this one." : ""}${resumeNote ? ` ${resumeNote}` : ""}${startsPi(command) ? ` The new session will load ${questIdForSpawn}.` : ""}${trustNote}`,
			{
				...trusting,
				how: "sessions-kitty",
				layout: "window",
				cwd,
				cwdSource,
				healed: resolved.healed ?? false,
				command,
				resumedSessionId,
				autoloadQuestId: questIdForSpawn,
				...(token ? { firstWordsKey: token } : {}),
			},
		);
	}
	let opened: OpenedTerminal;
	try {
		opened = await openTerminal(request, read.options);
	} catch (err) {
		return refuse(`Spawn failed: ${(err as Error).message}`);
	}
	const { plan } = opened;
	const layout = plan.layout;
	const used = describePlan(plan);
	const noted = opened.notes.map((note) => ` Note: ${note}.`).join("");
	if (opened.how === "planned") {
		const first =
			forLauncher && launcherOpens(plan)
				? " Run for real, it goes first to the desktop's launcher, which opens that window itself, and opens as planned only when the launcher doesn't answer."
				: "";
		return ok(
			`Would spawn a ${layout} in ${cwd} (${chosenBy}) through ${used}, running: ${command}.${noted}${first}${trustNote}`,
			{
				plan,
				cwd,
				cwdSource,
				command,
				autoloadQuestId: questIdForSpawn,
				...trusting,
			},
		);
	}

	let message = `Spawned a ${layout} in ${cwd} (${chosenBy}) through ${used}.${noted}`;
	if (resolved.healed) {
		message += " A recorded path was missing; healed to this one.";
	}
	// Only narrate resume when the spawn used pi's default command;
	// an explicit command overrides the resume decision, so the
	// idle/live/ambiguous note would not describe what actually ran.
	if (resumeNote) message += ` ${resumeNote}`;
	// State the quest the new session will load, not merely the one
	// requested. When the spawned command is pi (fresh or a resume),
	// the autoload env the spawn ships wins over the session's own
	// history in resolveStartup, and the target was validated to exist
	// above, so the load is deterministic. A non-pi command loads no
	// quest, so the claim is withheld.
	if (startsPi(command)) {
		message += ` The new session will load ${questIdForSpawn}; the spawn autoload wins over its own history.`;
	}
	message += trustNote;
	return ok(message, {
		...trusting,
		driver: plan.terminal,
		tier: plan.tier,
		how: opened.how,
		...(opened.handle ? { handle: opened.handle } : {}),
		layout,
		cwd,
		cwdSource,
		healed: resolved.healed ?? false,
		command,
		resumedSessionId,
		autoloadQuestId: questIdForSpawn,
		...(token ? { firstWordsKey: token } : {}),
	});
}
