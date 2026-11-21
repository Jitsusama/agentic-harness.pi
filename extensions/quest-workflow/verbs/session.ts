/**
 * The `spawn-*` verbs that open a quest a new session, in a terminal
 * tab, pane or window here, on a host, or held on another machine.
 * Which sessions a quest counts as its own is session-membership.ts's.
 */

import { homedir, hostname } from "node:os";
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FolderBudget } from "../../../lib/budget/host.ts";
import { sessionEnv } from "../../../lib/core/session/index.ts";
import {
	type DeclaredFence,
	declarationSaid,
	declarationSettled,
	type FenceDeclaration,
} from "../../../lib/internal/fence/fence-declaration.ts";
import { declaredSandbox } from "../../../lib/internal/fence/fence-lifted.ts";
import { STAGE_VARIABLE } from "../../../lib/internal/fence/fence-stage.ts";
import { discoverQuests } from "../../../lib/internal/quest/discovery/discovery.ts";
import {
	ancestorTreesOf,
	type CwdSource,
	describeCwdSource,
	pickResumeSession,
	reopenedCwd,
	resolveSpawnCwd,
} from "../../../lib/internal/quest/reopening/reopen.ts";
import {
	SESSION_MARK,
	settleHere,
} from "../../../lib/internal/quest/reopening/reopen-in-place.ts";
import {
	openInSessionsKitty,
	sessionsKittyRuns,
} from "../../../lib/internal/quest/reopening/sessions-kitty.ts";
import {
	FIRST_WORDS_VARIABLE,
	leaveFirstWords,
	spawnedWords,
} from "../../../lib/internal/quest/sessions/first-words.ts";
import { deriveLiveness } from "../../../lib/internal/quest/sessions/session-liveness.ts";
import { hostHold } from "../../../lib/internal/session/host-holds.ts";
import { uuidv7 } from "../../../lib/internal/session/uuidv7.ts";
import { limitsRefusal } from "../../../lib/orchestration/unasked-limits.ts";
import {
	describePlan,
	type OpenedTerminal,
	openTerminal,
} from "../../../lib/terminal/index.ts";
import { offerReopen } from "../first-turn-watch.ts";
import { buildSessionSnapshot } from "../liveness.ts";
import { getQuestEntry } from "../lookup.ts";
import type { QuestState } from "../state.ts";
import { terminalOptions } from "../terminal.ts";
import { trustPromptNote, trustPromptWaits } from "../trust-prompt.ts";
import {
	handedPlaceFor,
	presencesHere,
	windowPlaceFor,
} from "../window-place.ts";
import { nameBudgetFromFolder, namedBy } from "./budget.ts";
import { needsOf } from "./needs.ts";
import {
	currentSessionId,
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";
import {
	carryingModel,
	modelOf,
	resolveSpawnCommand,
	resumeMessage,
} from "./spawn-command.ts";
import {
	agentCommand,
	askAgents,
	isThisMachine,
	machineByDefault,
	machineFor,
	spawnHeld,
	startsPi,
	swapsAgent,
} from "./spawn-held.ts";
import { hostTargetOf, reachedInHost, spawnByHost } from "./spawn-host.ts";
import {
	launcherOpens,
	launcherSession,
	resumedBy,
	spawnedByLauncher,
} from "./spawn-launcher.ts";
import {
	claimRunning,
	placementFence,
	spawnFence,
	spawnFenced,
	stagedById,
	stagedSpawn,
} from "./spawn-stage.ts";

/** What a spawn settled on its way, for its answer to say. */
interface SpawnSaid {
	budget?: FolderBudget;
	fence?: FenceDeclaration;
	handed?: DeclaredFence;
}

/**
 * Give a quest a session of its own, first naming the budget its folder
 * draws on when nothing above it names one, so the session starts on
 * it; the answer opens by saying so, and says the fence it declared.
 */
export async function spawn(
	state: QuestState,
	ctx: ExtensionContext,
	params: QuestToolParams,
): Promise<QuestResult> {
	const said: SpawnSaid = {};
	const result = withFence(
		await spawnNaming(state, ctx, params, said),
		said.fence,
		said.handed,
	);
	if (!said.budget) return result;
	// Refused once it was named, the quest keeps it, and is told so.
	if (!result.ok) {
		return {
			...result,
			guidance: `${result.guidance} The quest was still named for budget ${said.budget.name}, which ${namedBy(said.budget)} says its folder's work draws on; \`quest budget\` names another.`,
		};
	}
	return {
		...result,
		message: `Budget ${said.budget.name} named, which ${namedBy(said.budget)} says its folder's work draws on. ${result.message}`,
		details: { ...result.details, budget: said.budget.name },
	};
}

/**
 * A spawn's answer saying the fence it runs in, which it told the node
 * where it asked one, and the sandbox it was `handed` where that claims
 * more. A host too old for the stage's token or a declared fence's
 * mark took it without, so the claim settles to what that runs.
 */
function withFence(
	result: QuestResult,
	asked: FenceDeclaration | undefined,
	handed: DeclaredFence | undefined,
): QuestResult {
	if (!result.ok || !asked) return result;
	const unstaged = result.details?.unstaged === true;
	const unmarked = result.details?.unmarked === true;
	const fence =
		unstaged || unmarked
			? declarationSettled(asked, {
					staged: !unstaged,
					carried: true,
					reopens: false,
					pi: true,
					kept: !unmarked,
				})
			: asked;
	return {
		...result,
		message: `${result.message} ${declarationSaid(fence, handed)}`,
		details: { ...result.details, fence },
	};
}

async function spawnNaming(
	state: QuestState,
	ctx: ExtensionContext,
	params: QuestToolParams,
	said: SpawnSaid,
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
	// A note is the spawner's order to the new session, so it says whose
	// limit it puts on a verdict, as a pivot does (unasked-limits.ts).
	const unasked = params.note ? limitsRefusal(params.note) : undefined;
	if (unasked !== undefined) return refuse(`Nothing was opened: ${unasked}`);
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

	// The folder: a quest's tree, a recent session's cwd, a tree's repo,
	// its ancestors' repo (never their trees), this session's repo, then
	// home, never the quest store; a path that's gone falls to the next.
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
	// The session to resume, not the spawning one: a live one, else the
	// newest idle; several live start a fresh pi and say the choice.
	const currentId = currentSessionId(ctx, undefined);
	// History stays on its machine, so a session elsewhere starts fresh.
	// A machine or needs the call names replace the quest's needs.
	const named = params.machine?.trim() || undefined;
	// The fence it tells the node it runs in: the call's, else the quest's,
	// else what it runs.
	const declared = spawnFence({
		fence: params.fence,
		quest: fm._extra?.fence,
		parent: sessionEnv(ctx).snapshot(),
	});
	if (!declared.ok) return refuse(declared.refusal);
	let fence = declared.declaration;
	const resumable = pickResumeSession(
		sessions.filter((s) => s.id !== currentId),
	);
	// The realm's agents, asked once before it is placed, since one that
	// runs no pi may be where it lands: the claim told the node, and the
	// command it starts, both follow the one answer.
	const realmAgents = params.command?.trim() ? undefined : await askAgents();
	const agentsHere = async () => realmAgents;
	const placementClaim = placementFence(fence, {
		command: params.command,
		resumes: resumable !== undefined && "id" in resumable,
		swapped: swapsAgent(realmAgents),
	});
	const chosen = await machineFor(
		named,
		named !== undefined || params.needs !== undefined
			? (params.needs ?? [])
			: needsOf(fm),
		undefined,
		placementClaim,
	);
	if (!chosen.ok) return refuse(chosen.refusal);
	const { needs } = chosen;
	// Naming neither, it goes where the node places work, unless it resumes.
	const machine = await machineByDefault(chosen.machine, needs, {
		resumes: Boolean(resumable && "id" in resumable),
		...(target.kind ? { host: target.kind } : {}),
		...(params.command ? { command: params.command } : {}),
		...(params.dryRun ? { dryRun: true } : {}),
		fence: placementClaim,
	});
	const resume =
		machine === undefined || isThisMachine(machine) ? resumable : undefined;
	// A session a host holds is reached through that host, never opened
	// again here or adopted by another, which would give its log a second
	// writer. A command of the caller's own resumes nothing.
	const resuming =
		resume && "id" in resume && !params.command?.trim() ? resume.id : undefined;
	const hold = resuming ? await hostHold(resuming) : undefined;
	if (resuming && hold) return reachedInHost(resuming, hold);
	// Named before the session starts, so it starts drawing on it, once
	// where it runs is settled: a reopen runs where its session ran, below.
	// Only for this machine: its providers know its folders, not another's.
	if (!params.dryRun && (machine === undefined || isThisMachine(machine))) {
		const reopening = reopenedCwd({
			command: resolveSpawnCommand(params.command, resume).command,
			sessions,
			questDir: entry.dir,
			store: state.questsRoot,
		});
		const taken = await nameBudgetFromFolder(
			state,
			questIdForSpawn,
			entry.dir,
			reopening ?? cwd,
		);
		if (taken) said.budget = taken;
	}
	const here = machine ?? hostname().split(".")[0] ?? "";
	const picked =
		resume && "id" in resume
			? sessions.find((s) => s.id === resume.id)
			: undefined;
	const { command: asks, dryRun } = params; // a reopen isn't staged
	const stage = { questId: questIdForSpawn, resuming, command: asks, dryRun };
	const staged = stagedSpawn(stage);
	const started = spawnFenced(fence, {
		...stage,
		listed: staged !== undefined,
		held: machine !== undefined,
		here: machine === undefined || isThisMachine(machine),
	});
	fence = started.claim;
	said.fence = fence;
	const { sandbox } = started;
	if (sandbox) said.handed = sandbox;
	const carried = {
		...(staged ? { [STAGE_VARIABLE]: staged } : {}),
		...declaredSandbox(sandbox),
	};
	// The host the call names, or for a plain spawn the one spawnHost says.
	const byHost = await spawnByHost({
		...(target.kind ? { asked: target.kind } : {}),
		params,
		...(machine !== undefined && !isThisMachine(machine)
			? { elsewhere: machine }
			: {}),
		agent: () => agentCommand("pi", here, agentsHere),
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
			...(Object.keys(carried).length > 0 ? { carried } : {}),
			...(params.dryRun ? { dryRun: true } : {}),
		},
	});
	if ("result" in byHost) return byHost.result;
	const settingNote = byHost.terminalNote;
	const spawned = resolveSpawnCommand(params.command, resume);
	const { resumedSessionId } = spawned;
	// A reopen starts where its session ran, since pi finds a session by
	// id only among the logs of the folder it starts in, even over a
	// folder the call named: on 14 November two of WJATIN's four reopens
	// were opened in a folder their logs weren't under, so neither pi
	// found its session and their first words were never taken.
	const reopenedIn = reopenedCwd({
		command: spawned.command,
		sessions,
		questDir: entry.dir,
		store: state.questsRoot,
	});
	if (reopenedIn) {
		const overruled = given && resolve(given) !== resolve(reopenedIn);
		cwd = reopenedIn;
		cwdSource = "reopened";
		chosenBy = overruled
			? `${describeCwdSource("reopened")}, not ${given}, where pi would find no session to reopen`
			: describeCwdSource("reopened");
	}
	// A realm whose node declares another command for its agent sessions,
	// as Joel's personal one declares pi-claude, starts that instead.
	const spawnsPi = !params.command?.trim();
	const agents = spawnsPi
		? await agentCommand(spawned.command, here, agentsHere)
		: spawned.command;
	fence = claimRunning(fence, spawned.command, agents);
	said.fence = fence;
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

	// The new pi loads this quest at session_start, which names it; a
	// resumed one restores its own, so the variable only covers a fresh pi.
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
		// Words left on this machine reach only a session held here; one
		// elsewhere carries them in its start, and opens no window.
		const local = isThisMachine(machine);
		const token = local ? leftUnder(uuidv7()) : undefined;
		const held = await spawnHeld({
			machine,
			needs,
			fence,
			...(sandbox ? { sandbox } : {}),
			command,
			cwd,
			home: homedir(),
			questId: questIdForSpawn,
			...(token ? { firstWords: token } : {}),
			...(!local && firstWords ? { firstText: firstWords } : {}),
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
		sandboxed: sandbox !== undefined,
		...(asking ? { fromSessionId: asking } : {}),
		place: handedPlaceFor(questIdForSpawn, index),
	});
	// The launcher carries only the session's id through, so its words are
	// left under that; a window opened here names the same key in its
	// environment, which also covers the launcher not answering.
	const token = leftUnder(forLauncher?.id ?? uuidv7());
	if (token) env[FIRST_WORDS_VARIABLE] = token;
	if (staged) env[STAGE_VARIABLE] = staged;
	Object.assign(env, declaredSandbox(sandbox));
	if (staged && forLauncher?.fresh) stagedById(forLauncher.id, stage);
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
	// The quest it will load: a pi's autoload wins over its own history in
	// resolveStartup, and the quest exists; a non-pi command loads none.
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
