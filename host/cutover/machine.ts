/**
 * The cutover's and the release's facts from this machine: the mesh's
 * presences, which harness each pi loaded, pi's session logs, the steer
 * inboxes, park's wake files, the move notes, the realm's two hosts,
 * restore.json and the quests' journals.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { refreshRestoreFile } from "../../extensions/quest-workflow/sessions/restore.ts";
import { dataDir, sessionsDir, stateDir } from "../../lib/internal/paths.ts";
import {
	type TickFacts,
	tickedStanding,
	tickFacts,
} from "../../lib/internal/process-ticks.ts";
import {
	discoverQuests,
	type QuestIndex,
} from "../../lib/internal/quest/discovery/discovery.ts";
import { appendJourneyByPath } from "../../lib/internal/quest/documents/append-journey.ts";
import {
	orchestrationOf,
	windowWorkspaceOf,
} from "../../lib/internal/quest/fields/orchestration.ts";
import {
	type HandedSession,
	handOver,
	type LauncherCall,
	launcherTakes,
} from "../../lib/internal/quest/reopening/hand-over.ts";
import { indexSessionFiles } from "../../lib/internal/quest/sessions/session-liveness.ts";
import { rosterHolds } from "../../lib/internal/session/host-holds.ts";
import {
	claimMoveNote,
	giveBackMoveNote,
	type MoveNote,
	moveFolder,
	readMoveNote,
	readMoveNotes,
	removeMoveNote,
	restoreStrandedClaims,
} from "../../lib/internal/session/move.ts";
import { askWake } from "../../lib/internal/session/park.ts";
import { questAddress } from "../../lib/mesh/address.ts";
import { census } from "../../lib/mesh/liveness.ts";
import type { MoveOff } from "../../lib/mesh/moving.ts";
import { createPresences, type Presence } from "../../lib/mesh/presence.ts";
import { giveSteer } from "../../lib/mesh/steer.ts";
import { type HostKind, hostKey, hostSocketPath } from "../service/address.ts";
import { controlRequest } from "../service/client.ts";
import { parseListResult } from "../service/protocol.ts";
import { rolloutFacts } from "../service/rollout.ts";
import { personWrote } from "./attended.ts";
import type { CutoverFacts, MoveFacts } from "./cutover.ts";
import type { HeldConversation, ReleaseFacts } from "./release.ts";
import type { TakeUpFacts } from "./take-up.ts";
import {
	type MachineWindows,
	readMachineWindows,
	standingOf,
} from "./windows.ts";

/** How long the shell may take to say it kept a window's place. */
const SHELL_TIMEOUT_MS = 5_000;

/** A file only a harness that knows the move has. */
const MOVE_MARK = join("lib", "internal", "session", "move.ts");

/** Whether the harness at `root` knows the move. */
export function rootKnowsMove(root: string): boolean {
	return existsSync(join(root, MOVE_MARK));
}

/** Where the machine's pieces are; the realm's own unless a test says. */
export interface CutoverPlaces {
	/**
	 * The install's current version, which a woken parked pi starts on;
	 * without one, a parked pi knows the move as its presence says.
	 */
	readonly current?: string;
	readonly realm: string;
	readonly runtimeDir?: string;
	readonly presence?: string;
	readonly steer?: string;
	readonly moves?: string;
	readonly logs?: string;
	readonly self?: string;
	/**
	 * The pid of the cutover running, which names the notes it claims, so
	 * one it dies holding is given back; a cutover that adopts needs it.
	 */
	readonly claimer?: number;
	readonly ticks?: TickFacts;
	/** The hosts' rosters, the realm's own unless a test says. */
	readonly rosters?: string;
	/** What the machine says of its windows; mycelium, niri and kitty's unless a test says. */
	readonly windows?: () => Promise<MachineWindows>;
	/** The mycelium executables vouched for as carrying #121, whose holders park quietly. */
	readonly quietMycelium?: readonly string[];
	/**
	 * The mark swayidle-away keeps while Joel is at the machine, touched at
	 * any input and removed after 2 minutes idle. Given, a window on his
	 * workspace may move while it is absent; without it, never.
	 */
	readonly presenceMark?: string;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * What holds a session still waiting to move, as its presence says, or
 * why its move was called off once none waits (moving.ts).
 */
function holdsSaid(presence: Presence | undefined): string | undefined {
	if (presence?.moving) return presence.moving.holds;
	return presence?.moveOff
		? `called itself off: ${presence.moveOff.why}`
		: undefined;
}

/** The move a presence says was called off, while it says none waits. */
function calledOffOf(presence: Presence | undefined): MoveOff | undefined {
	return presence?.moving === undefined ? presence?.moveOff : undefined;
}

/** Every conversation the realm's two hosts hold; one not listening holds none. */
async function listHeld(
	realm: string,
	runtimeDir: string | undefined,
): Promise<HeldConversation[]> {
	const held: HeldConversation[] = [];
	for (const kind of ["attended", "background"] as const) {
		try {
			const reply = await controlRequest(
				hostSocketPath(realm, kind, runtimeDir),
				{ v: 1, id: randomUUID(), op: "list" },
			);
			if (!reply.ok) continue;
			const { sessions, host } = parseListResult(reply.result);
			for (const one of sessions)
				held.push({ session: one.sessionId, host: host.key, kind });
		} catch {
			// A host not listening holds nothing; adopting into it says so.
		}
	}
	return held;
}

/** Pause for `ms`, between looks. */
const pause = (ms: number) =>
	new Promise<void>((settle) => setTimeout(settle, ms));

/** Print a line of progress for the person running it. */
const say = (line: string) => {
	// biome-ignore lint/suspicious/noConsole: progress, for the person running it.
	console.log(line);
};

/** Where the release's pieces are; the realm's own unless a test says. */
export interface ReleasePlaces {
	readonly realm: string;
	readonly runtimeDir?: string;
	readonly presence?: string;
	readonly steer?: string;
	readonly moves?: string;
	readonly quests?: string;
	/** How the launcher is asked to open a session; Quickshell's own unless a test says. */
	readonly launcher?: LauncherCall;
}

/**
 * Where the launcher opens a released session's window: its
 * orchestrator's and its workspace, as Reopen Them All places it
 * (quest-workflow window-place.ts).
 */
function releasedPlace(
	quest: string,
	index: QuestIndex,
): Pick<HandedSession, "orchestratedBy" | "workspace"> {
	const read = (id: string) => index.quests.get(id)?.doc.frontMatter;
	const by = orchestrationOf(quest, read).by;
	const workspace = windowWorkspaceOf(quest, read);
	return {
		...(by ? { orchestratedBy: questAddress(by) } : {}),
		...(workspace ? { workspace: questAddress(workspace) } : {}),
	};
}

/** The session a move note hands the launcher, back where its window was. */
function releasedSession(note: MoveNote, index: QuestIndex): HandedSession {
	return {
		id: note.session,
		cwd: note.cwd,
		...(note.quest ? { quest: note.quest } : {}),
		...(note.env ? { env: note.env } : {}),
		...(note.quest ? releasedPlace(note.quest, index) : {}),
		// The session's name, which its window's title reads.
		...(note.title ? { title: note.title } : {}),
		replaces: note.session,
	};
}

/** The release's facts from this machine. */
export function releaseFacts(places: ReleasePlaces): ReleaseFacts {
	const presences = createPresences(
		places.presence ?? join(stateDir("mesh-workflow"), "presence"),
	);
	const steer = places.steer ?? stateDir("steer");
	const moves = places.moves ?? moveFolder();
	const quests = places.quests ?? join(dataDir("quest-workflow"), "quests");
	return {
		held: () => listHeld(places.realm, places.runtimeDir),
		addressesOf: (session) => presences.of(session)?.addresses ?? [],
		tell: (address) => {
			giveSteer(steer, address, {
				text: "",
				act: "move",
				to: "pi",
				at: new Date().toISOString(),
				from: "joel",
			});
		},
		wake: (session) => {
			askWake(session, `release-${Date.now()}`);
		},
		note: (session) => readMoveNote(session, moves),
		holds: async (session) => holdsSaid(presences.of(session)),
		// A pi of its own says so in a presence no host holds, as it starts;
		// the one its host last wrote may outlast it.
		takenUp: (session) => {
			const presence = presences.of(session);
			const pid = presence?.owner?.pid;
			return (
				presence?.hosted === undefined &&
				pid !== undefined &&
				rolloutFacts.alive(pid)
			);
		},
		reopen: async (note) => {
			// Opened by id elsewhere, pi asks whether to fork it; by its file,
			// whether to go on in another folder. Pi 1.5 has no flag for either,
			// and nobody sees a question in a window opened for nobody
			// (OSPHT4 [97001e00], [64e07315]), so the person opens it.
			if (!existsSync(note.cwd)) {
				say(
					`${note.session}: its folder ${note.cwd} is gone, so it is only offered; open it with pi --session ${note.sessionFile} and answer Continue`,
				);
				return false;
			}
			const session = releasedSession(note, discoverQuests(quests).index);
			if (!launcherTakes(session)) return false;
			const taken = await handOver([session], places.launcher);
			return taken !== undefined && taken > 0;
		},
		callOff: (address) => {
			giveSteer(steer, address, {
				text: "",
				act: "resume",
				at: new Date().toISOString(),
				from: "joel",
			});
		},
		refreshRestore: () => refreshRestoreFile(quests),
		journal: (quest, prose) => {
			const dir = discoverQuests(quests).index.quests.get(quest)?.dir;
			return dir !== undefined && appendJourneyByPath(dir, prose);
		},
		now: () => Date.now(),
		pause,
		say,
	};
}

/** The cutover's facts from this machine. */
export function machineFacts(places: CutoverPlaces): CutoverFacts & MoveFacts {
	const presences = createPresences(
		places.presence ?? join(stateDir("mesh-workflow"), "presence"),
	);
	const steer = places.steer ?? stateDir("steer");
	const moves = places.moves ?? moveFolder();
	const ticks = places.ticks ?? tickFacts;
	let logs: Map<string, string> | undefined;
	// Read once a plan, so every session is judged against one moment;
	// read afresh before each tell, as Joel may have moved since.
	let windows: Promise<MachineWindows> | undefined;
	const readWindows =
		places.windows ??
		(() =>
			readMachineWindows(
				places.realm,
				places.runtimeDir,
				places.quietMycelium,
			));
	const socket = (kind: HostKind) =>
		hostSocketPath(places.realm, kind, places.runtimeDir);
	const claimer = () => {
		if (places.claimer === undefined)
			throw new Error(
				"a cutover claims a move note under its own pid (claimer)",
			);
		return places.claimer;
	};
	const mark = places.presenceMark;
	return {
		...(places.self ? { self: places.self } : {}),
		...(mark === undefined ? {} : { joelAway: () => !existsSync(mark) }),
		present: async () => [...(await census(presences.all(), ticks)).present],
		// A harness that knows the move says whether a person drives its
		// session, either way, in every presence it publishes; a parked pi
		// wakes on the install's current version, whatever it ran before.
		knowsMove: async (presence: Presence) =>
			presence.driven !== undefined ||
			(presence.state === "parked" &&
				places.current !== undefined &&
				rootKnowsMove(places.current)),
		sessionFile: (session) => {
			logs ??= indexSessionFiles(places.logs ?? sessionsDir());
			return logs.get(session);
		},
		personWrote,
		window: async (presence) => {
			windows ??= readWindows();
			return standingOf(presence.session, await windows);
		},
		windowNow: async (session) => standingOf(session, await readWindows()),
		keepPlace: (session) =>
			new Promise((settle) => {
				execFile(
					"qs",
					["ipc", "call", "sessions", "keepPlace", session],
					{ timeout: SHELL_TIMEOUT_MS },
					(error, stdout, stderr) => {
						const said = `${stdout}`.trim() || `${stderr}`.trim();
						settle(
							error
								? `the shell didn't keep it (${said || messageOf(error)})`
								: said || "kept",
						);
					},
				);
			}),
		tell: (address, to) => {
			giveSteer(steer, address, {
				text: "",
				act: "move",
				to,
				at: new Date().toISOString(),
				from: "joel",
			});
		},
		wake: (session) => {
			askWake(session, `move-${Date.now()}`);
		},
		notes: () => {
			restoreStrandedClaims((pid) => rolloutFacts.alive(pid), moves);
			return readMoveNotes(moves);
		},
		removeNote: (session) => removeMoveNote(session, moves),
		claim: (session) => claimMoveNote(session, claimer(), moves),
		giveBack: (session) => giveBackMoveNote(session, claimer(), moves),
		kept: async (session, to) =>
			rosterHolds(places.rosters).get(session) === hostKey(places.realm, to),
		running: async (note: MoveNote) => {
			// A note from a host names that host's pid, which outlives the
			// conversation: it has gone once the host neither lists it nor
			// keeps it on its roster, which a host down still resumes.
			if (note.from !== undefined) {
				const listed = await listHeld(places.realm, places.runtimeDir);
				if (
					listed.some(
						(one) => one.session === note.session && one.host === note.from,
					)
				)
					return true;
				return rosterHolds(places.rosters).get(note.session) === note.from;
			}
			const owner = presences.of(note.session)?.owner;
			// Without its presence, the pid alone: a pid is seldom reused
			// within the seconds between a note and its pi's end.
			if (owner?.pid !== note.pid) return rolloutFacts.alive(note.pid);
			return (await tickedStanding(owner, ticks)) !== "gone";
		},
		held: async () =>
			new Map(
				(await listHeld(places.realm, places.runtimeDir)).map((one) => [
					one.session,
					one.host,
				]),
			),
		adopt: async (note, to) => {
			const key = hostKey(places.realm, to);
			try {
				const reply = await controlRequest(socket(to), {
					v: 1,
					id: randomUUID(),
					op: "adopt",
					sessionFile: note.sessionFile,
					attended: to === "attended",
					...(note.quest ? { quest: note.quest } : {}),
					// A fenced session stays fenced in the host (protocol.ts).
					...(note.env ? { env: note.env } : {}),
				});
				return reply.ok
					? undefined
					: `the ${key} host refused: ${reply.error.code}, ${reply.error.message}`;
			} catch (error) {
				return `the ${key} host didn't answer: ${messageOf(error)}`;
			}
		},
		holds: async (session) => holdsSaid(presences.of(session)),
		calledOff: async (session) => calledOffOf(presences.of(session)),
		now: () => Date.now(),
		pause,
		say,
	};
}

/** A /host take-up's facts from this machine (take-up.ts). */
export function takeUpFacts(places: CutoverPlaces): TakeUpFacts {
	const presences = createPresences(
		places.presence ?? join(stateDir("mesh-workflow"), "presence"),
	);
	return {
		...machineFacts(places),
		standing: async (session) => {
			const presence = presences.of(session);
			const pid = presence?.owner?.pid;
			if (pid === undefined || !rolloutFacts.alive(pid)) return "gone";
			return presence?.moving === undefined ? "off" : "moving";
		},
	};
}
