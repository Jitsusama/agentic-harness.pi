/** Conversation ownership installed before pi loads any hosted extensions. */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isOwner } from "../../lib/core/process/index.ts";
import {
	type FenceTeller,
	type Host,
	type HostedState,
	type HostRegistry,
	type HostReloadRequest,
	hostRegistryPath,
	installHost,
	type LaunchHints,
	releaseSession,
	type SessionEnvironment,
	type SessionOwner,
	withSession,
} from "../../lib/core/session/index.ts";
import type { FenceKind } from "../../lib/mesh/presence.ts";
import { HOST_READS, installConversationEnv } from "./process-env.ts";

/** A stable pi conversation, supplied before its extensions load. */
export interface ConversationRegistration {
	readonly id: string;
	readonly file: string;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly hints?: LaunchHints;
	/** Abort, emit session_shutdown and dispose this conversation's resources. */
	readonly close: (why: string) => void | Promise<void>;
	/** Emit the typed session stamp on this conversation\'s pi event bus. */
	readonly stamp?: (how: "signalled" | "closed") => void | Promise<void>;
	/** Await idle and reload this conversation's runner, as pi's own reload does. */
	readonly reload?: (request: HostReloadRequest) => void | Promise<void>;
	/** Park this idle conversation, keeping it held for a wake. */
	readonly park?: () => void | Promise<void>;
	/**
	 * Say on this conversation's bus that its stop is the host's own
	 * restart, which resumes it, just before the stamp.
	 */
	readonly restarting?: () => void;
}

/** Why a host reloads no conversation onto another tree. */
export const HOST_RELOAD_ONTO =
	"A host's conversations load the harness from the one install it runs, so a conversation can't reload onto another tree";

/** The live identity a transport can list without reading pi internals. */
export interface ConversationIdentity {
	readonly id: string;
	readonly file: string;
	readonly cwd: string;
	readonly state: HostedState;
	readonly since: string;
}

interface Conversation extends ConversationIdentity {
	environment: SessionEnvironment;
	/**
	 * The loosest fence any of its tools said they hold it to since it
	 * opened here (Host.fenced), kept through reloads, parks and
	 * replacements, since a command an earlier runner started may still run.
	 */
	fence?: FenceKind;
	/** Whether its present runner's shell has told its fence. */
	shellTold?: boolean;
	/** Whether its present runner's guard on pi's file tools has told its fence. */
	filesTold?: boolean;
	/** Whether its fence changed since the record was last written. */
	fenceUnwritten?: boolean;
	launchHints: LaunchHints;
	cleanup: ConversationRegistration["close"];
	stampCallback: ConversationRegistration["stamp"];
	reloadCallback: ConversationRegistration["reload"];
	parkCallback: ConversationRegistration["park"];
	restartingCallback: ConversationRegistration["restarting"];
	reloading?: Promise<void>;
	ending?: "signalled" | "closed";
	/** Whether its close hands it on, keeping what it left running (handsOn). */
	handsOn?: boolean;
	// Closed because it was handed to another holder, as a release is, so
	// its ending reads released rather than closed.
	handedOn?: boolean;
	stamped?: "signalled" | "closed";
	closing?: Promise<void>;
	accepting: boolean;
	disposed: boolean;
}

/** How a conversation left its host: stopped, closed, or closed to another holder. */
export type HostLeaving = "signalled" | "closed" | "released";

/** What hears a host's changes, each once it is published. */
export interface HostChanges {
	/** What the host runs changed: one registered, or one's state. */
	changed(): void;
	/**
	 * A conversation left, ended by a stop, a close, or a close that
	 * handed it to another holder, saying why.
	 */
	left(ending: HostLeaving, why: string): void;
}

/** One host's live ownership; persisted restart rosters belong to the service. */
export class SessionHost implements Host {
	readonly kind = "pi-durable";
	readonly key: string;
	readonly owner: SessionOwner;
	readonly registryPath: string;
	private readonly closedState: string;
	// Whether the records' folder lay closed as the host started: one a
	// fenced command swapped for its own later reads as closed by then.
	private readonly closedAtStart: boolean;
	// Whether the host has said, once, that its records name no fence.
	private saidUnclosed = false;
	// Why the record last couldn't be written, as the host said it.
	private saidUnwritten?: string;
	private readonly conversations = new Map<string, Conversation>();
	// The loosest fence told each conversation that ended short of a close
	// for good, as a park ends one while its `&` commands run on; it
	// counts again once the conversation is held again.
	private readonly leftRunning = new Map<string, FenceKind>();
	private readonly uninstall: () => void;
	private readonly own: NodeJS.ProcessEnv = process.env;
	private disposed = false;
	private readonly changes?: HostChanges;
	// While draining, the conversations woken from a park since it began,
	// which the person asked for and which aren't drained again.
	private wokenInDrain?: Set<string>;

	constructor(options: {
		key: string;
		owner: SessionOwner;
		registryDir?: string;
		/** The folder the fence keeps read-only, which a record must lie in to name a fence. */
		closedState?: string;
		/** Hears each change once it is published, as a child host follows its one conversation. */
		changes?: HostChanges;
	}) {
		if (
			!options.key ||
			!isOwner(options.owner) ||
			options.owner.session !== undefined
		)
			throw new Error("Host requires a key and a process owner");
		this.key = options.key;
		this.owner = Object.freeze({ ...options.owner });
		this.registryPath = hostRegistryPath(this.owner, options.registryDir);
		this.closedState = options.closedState ?? join(homedir(), CLOSED_STATE);
		const folder = dirname(this.registryPath);
		// Made writable by its owner alone whatever the umask, as closedIn
		// asks, so a umask that lets the person's group write still names one.
		mkdirSync(folder, { recursive: true, mode: 0o755 });
		closeToOthers(folder, this.closedState);
		this.closedAtStart = closedIn(folder, this.closedState);
		if (options.changes) this.changes = options.changes;
		const unhost = installHost(this);
		// Code that reads process.env directly sees its own conversation's.
		const unview = installConversationEnv(this);
		this.uninstall = () => {
			unview();
			unhost();
		};
		try {
			this.publish();
		} catch (error) {
			this.uninstall();
			throw error;
		}
	}

	/**
	 * What only the host's process is (HOST_READS), as its environment
	 * names it, which a conversation's requests read when it names none
	 * of its own.
	 */
	hostReads(): Readonly<Record<string, string>> {
		const reads: Record<string, string> = {};
		for (const name of HOST_READS) {
			const value = this.own[name];
			if (value !== undefined) reads[name] = value;
		}
		return reads;
	}

	/** Publish identity before the caller loads extensions or advertises leases. */
	register(input: ConversationRegistration): void {
		if (this.disposed) throw new Error("Host is disposed");
		if (!input.id || !isAbsolute(input.file) || !isAbsolute(input.cwd))
			throw new Error("Conversation requires an id and absolute file and cwd");
		if (this.conversations.has(input.id))
			throw new Error(`Conversation already held: ${input.id}`);
		const file = resolve(input.file);
		if ([...this.conversations.values()].some((s) => s.file === file))
			throw new Error(`Conversation file already held: ${input.file}`);
		const left = this.leftRunning.get(input.id);
		this.conversations.set(input.id, {
			...(left ? { fence: left } : {}),
			id: input.id,
			file,
			cwd: resolve(input.cwd),
			state: "idle",
			since: new Date().toISOString(),
			accepting: true,
			disposed: false,
			environment: sessionEnvironment(input.env, input.id),
			launchHints: { ...input.hints },
			cleanup: input.close,
			stampCallback: input.stamp,
			reloadCallback: input.reload,
			parkCallback: input.park,
			restartingCallback: input.restarting,
		});
		try {
			this.publish();
		} catch (error) {
			this.conversations.delete(input.id);
			throw error;
		}
	}

	/** Bind one dispatch to its conversation without changing process globals. */
	run<T>(id: string, fn: () => T): T {
		const conversation = this.require(id);
		if (!conversation.accepting)
			throw new Error(`Conversation is closing: ${id}`);
		return withSession(id, fn);
	}

	/** Current live identities; modifying a returned list cannot change ownership. */
	list(): ConversationIdentity[] {
		return [...this.conversations.values()].map(
			({ id, file, cwd, state, since }) => ({ id, file, cwd, state, since }),
		);
	}

	/** S2 liveness reads parked sessions as held until disposal succeeds. */
	holds(id: string): HostedState | undefined {
		return this.conversations.get(id)?.state;
	}

	/** The private environment map, never an overlay on process.env. */
	env(id: string): SessionEnvironment {
		return this.require(id).environment;
	}

	/**
	 * Keep the fence one of its tools holds it to and say it in the
	 * record, never tighter than another said since it opened here, and
	 * only once its present runner's shell and file guard have both said
	 * one. Only the tools know: the shell draws its fence once as it
	 * loads, and pi's file tools judge each call by the environment as it
	 * is then. False when the record couldn't be written, which is tried
	 * again at the next ask, so the tool refuses what would run looser
	 * than the record.
	 */
	fenced(id: string, fence: FenceKind, by: FenceTeller): boolean {
		const conversation = this.require(id);
		const kept = loosest(conversation.fence, fence);
		const shellTold = conversation.shellTold || by === "shell";
		const filesTold = conversation.filesTold || by === "files";
		if (
			kept === conversation.fence &&
			shellTold === conversation.shellTold &&
			filesTold === conversation.filesTold &&
			!conversation.fenceUnwritten
		)
			return true;
		conversation.fence = kept;
		conversation.shellTold = shellTold;
		conversation.filesTold = filesTold;
		conversation.fenceUnwritten = true;
		return this.publishOrUnsay();
	}

	/**
	 * Note that `id`'s next close hands it on, as a release does, keeping
	 * what it left running, so its fence counts when it is held again.
	 */
	handsOn(id: string): void {
		const conversation = this.conversations.get(id);
		if (conversation) conversation.handsOn = true;
	}

	/**
	 * Hand the loosest fence `from` was told on to `to`, as pi replaces one
	 * conversation with another and what the first had in flight carries
	 * on as the second's. Nothing when either isn't held.
	 */
	inherit(from: string, to: string): void {
		const previous = this.conversations.get(from);
		const next = this.conversations.get(to);
		if (previous) untold(previous);
		if (!previous?.fence || !next) return;
		const kept = loosest(next.fence, previous.fence);
		if (kept === next.fence) return;
		next.fence = kept;
		next.fenceUnwritten = true;
		this.publishOrUnsay();
	}

	/**
	 * Name no fence for a conversation one of whose guards shut down with
	 * its runner, as pi shuts down a runner it reloads, whoever asked,
	 * until the next runner's shell and file guard tell one. Either guard
	 * says it, so a runner that loaded only one is still judged as it
	 * ends.
	 */
	left(id: string): void {
		this.unshelled(this.require(id));
	}

	/** Consume launch hints once for this conversation. */
	hints(id: string): LaunchHints {
		const conversation = this.require(id);
		const hints = conversation.launchHints;
		conversation.launchHints = {};
		return hints;
	}

	/** Publish a state transition before returning it to the transport. */
	state(id: string, state: HostedState): void {
		const conversation = this.require(id);
		if (!conversation.accepting)
			throw new Error(`Conversation is closing: ${id}`);
		this.changeState(conversation, state);
	}

	/**
	 * Stop admission, then dispose only this session; a failed close stays
	 * held. `handedOn` when another holder takes it up, as a release does,
	 * which what hears the host's changes is told.
	 */
	close(id: string, why = "closed", handedOn = false): Promise<void> {
		const conversation = this.conversations.get(id);
		if (conversation && handedOn && !conversation.closing)
			conversation.handedOn = true;
		return this.finish(id, why, "closed");
	}

	/**
	 * Reload one conversation, keeping its ownership, slots, environment
	 * and list entry: no stamp, no park, no release. A second ask while one
	 * is under way joins it. A failed reload leaves the conversation held
	 * and usable, and rejects with why. The old runner's guards say they
	 * left as pi shuts it down (left), so its fence is unsaid until the new
	 * runner's shell and file guard say it; a reload that failed before
	 * that keeps the runner, and the fence it told. The loosest told before
	 * still counts.
	 */
	reload(id: string, request: HostReloadRequest): Promise<void> {
		const conversation = this.conversations.get(id);
		if (!conversation)
			return Promise.reject(new Error(`Conversation not held: ${id}`));
		if (!conversation.accepting)
			return Promise.reject(new Error(`Conversation is closing: ${id}`));
		if (request.onto !== undefined)
			return Promise.reject(new Error(HOST_RELOAD_ONTO));
		const callback = conversation.reloadCallback;
		if (!callback)
			return Promise.reject(
				new Error(`Conversation's runner can't be reloaded: ${id}`),
			);
		if (conversation.reloading) return conversation.reloading;
		const reloading = Promise.resolve()
			.then(() => withSession(id, () => callback(request)))
			.finally(() => {
				conversation.reloading = undefined;
			});
		conversation.reloading = reloading;
		return reloading;
	}

	/**
	 * Park one conversation, as it asks once idle. The park starts after
	 * this returns, outside the asking extension's own call, since it ends
	 * that extension; what fails is reported by the callback's owner. One
	 * closing already, or with no way to park, is left as it is.
	 */
	park(id: string): void {
		const conversation = this.require(id);
		const callback = conversation.parkCallback;
		if (!callback)
			throw new Error(`Conversation can't be parked by its host: ${id}`);
		if (!conversation.accepting) return;
		setImmediate(() => {
			if (!conversation.accepting) return;
			Promise.resolve()
				.then(() => withSession(id, callback))
				.catch(() => {
					// The engine reports its own park's failure; nothing waits on this one.
				});
		});
	}

	/** Whether the host drains for a restart, holding the wakes of those it parked. */
	drains(): boolean {
		return this.wokenInDrain !== undefined;
	}

	/** Whether this conversation parks at once, as the host drains and it wasn't woken since. */
	draining(id: string): boolean {
		return this.wokenInDrain !== undefined && !this.wokenInDrain.has(id);
	}

	/** Start or lift a drain; each conversation reads it at its next look. */
	drain(on: boolean): void {
		if (!on) this.wokenInDrain = undefined;
		else this.wokenInDrain ??= new Set();
	}

	/**
	 * Stop for host restart without recording a deliberate conversation
	 * quit. `restarting` when the stop is a restart the host asked for, or
	 * any stop whose engine can keep bash calls alive, so the conversation
	 * may carry its work to the next host.
	 */
	stop(id: string, why = "host stopped", restarting = false): Promise<void> {
		return this.finish(id, why, "signalled", restarting);
	}

	private finish(
		id: string,
		why: string,
		how: "signalled" | "closed",
		restarting = false,
	): Promise<void> {
		const conversation = this.conversations.get(id);
		if (!conversation) return Promise.resolve();
		if (conversation.closing) return conversation.closing;
		this.changeState(conversation, "parked");
		conversation.accepting = false;
		conversation.ending ??= how;
		// Start cleanup in a microtask so a reentrant close sees the same promise.
		conversation.closing = Promise.resolve()
			.then(async () => {
				if (restarting && conversation.ending === "signalled")
					withSession(id, () => conversation.restartingCallback?.());
				await this.stamp(id, conversation.ending ?? how);
				if (!conversation.disposed) {
					await withSession(id, () => conversation.cleanup(why));
					conversation.disposed = true;
				}
			})
			.then(() => {
				this.conversations.delete(id);
				try {
					this.publish();
				} catch (error) {
					this.conversations.set(id, conversation);
					throw error;
				}
				// A close for good ends what it left running; any other stop,
				// or a close that hands it on, keeps it, so its fence counts
				// when the conversation is held again.
				if (conversation.ending === "closed" && !conversation.handsOn)
					this.leftRunning.delete(id);
				else {
					untold(conversation);
					if (conversation.fence) this.leftRunning.set(id, conversation.fence);
				}
				releaseSession(id);
				const ending = conversation.ending ?? how;
				this.changes?.left(
					ending === "closed" && conversation.handedOn ? "released" : ending,
					why,
				);
			})
			.finally(() => {
				conversation.closing = undefined;
			});
		return conversation.closing;
	}

	/** Notify the session bus without recursively closing or discarding resources. */
	async stamp(id: string, how: "signalled" | "closed"): Promise<void> {
		const conversation = this.conversations.get(id);
		if (!conversation || conversation.stamped === how) return;
		if (how === "signalled") this.changeState(conversation, "parked");
		await withSession(id, () => conversation.stampCallback?.(how));
		conversation.stamped = how;
	}

	/** Uninstall only an empty host; never discard another session's resources. */
	dispose(): void {
		if (this.disposed) return;
		if (this.conversations.size)
			throw new Error("Close hosted conversations before disposing the host");
		rmSync(this.registryPath, { force: true });
		this.uninstall();
		this.disposed = true;
	}

	private require(id: string): Conversation {
		const conversation = this.conversations.get(id);
		if (!conversation) throw new Error(`Conversation not held: ${id}`);
		return conversation;
	}

	private changeState(conversation: Conversation, state: HostedState): void {
		if (conversation.state === "parked" && state !== "parked")
			this.wokenInDrain?.add(conversation.id);
		const previous = { state: conversation.state, since: conversation.since };
		// A state said again is no change, so it keeps when it began, which a
		// restart's ceiling counts from. Pi's retries and continues end one
		// run and start another, so each of those counts from its own start.
		const since =
			conversation.state === state
				? conversation.since
				: new Date().toISOString();
		Object.assign(conversation, { state, since });
		try {
			this.publish();
		} catch (error) {
			Object.assign(conversation, previous);
			throw error;
		}
	}

	/**
	 * Name no fence for a conversation until its next runner's shell and
	 * file guard say one. A reload's outcome mustn't turn on its record,
	 * so one that can't be written is left naming no fence at all.
	 */
	private unshelled(conversation: Conversation): void {
		untold(conversation);
		conversation.shellTold = false;
		conversation.filesTold = false;
		conversation.fenceUnwritten = true;
		this.publishOrUnsay();
	}

	/**
	 * Write the record, or failing that leave none of its fences on disk,
	 * so the file never names one the host no longer holds: a runner
	 * without the shell runs pi's own bash unfenced and tells nothing, so
	 * no tool would refuse in its place. False when it wasn't written,
	 * which is tried again at the next change or ask.
	 */
	private publishOrUnsay(): boolean {
		try {
			this.publish();
			return true;
		} catch (error) {
			const unsaid = this.unsay();
			// Said once each outage, by what failed rather than its words,
			// which name the random file each write is made in.
			const { code, syscall } = error as NodeJS.ErrnoException;
			const cause = `${code ?? String(error)} ${syscall ?? ""} ${unsaid}`;
			if (cause !== this.saidUnwritten) {
				this.saidUnwritten = cause;
				const why = error instanceof Error ? error.message : String(error);
				process.stderr.write(
					`pi-host: couldn't write ${this.registryPath}, ${UNSAID[unsaid]}: ${why}\n`,
				);
			}
			return false;
		}
	}

	/**
	 * Rewrite the record where it lies, naming no fence, which needs no
	 * new file and mostly no more room, as on a full disk; failing that,
	 * empty it, which the node refuses and pi reads as no host, so its
	 * sessions are held only where its service keeps them, until the next
	 * write lands. Only a record of its own: never through a link, and
	 * never into a FIFO, which would hold the host's one thread, or a
	 * file linked elsewhere too, which may be the person's own.
	 */
	private unsay(): Unsaid {
		let held: number;
		try {
			held = openSync(
				this.registryPath,
				constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
		} catch {
			return "left";
		}
		try {
			const record = fstatSync(held);
			if (
				!record.isFile() ||
				record.nlink !== 1 ||
				record.uid !== process.getuid?.()
			)
				return "left";
			const text = Buffer.from(JSON.stringify(this.registry(false)));
			try {
				// A write cut short, as on a full disk, leaves no whole record.
				if (writeSync(held, text, 0, text.length, 0) !== text.length)
					throw new Error("short write");
				ftruncateSync(held, text.length);
				return "rewritten";
			} catch {
				ftruncateSync(held, 0);
				return "emptied";
			}
		} catch {
			// Nothing more can be done before a write lands.
			return "left";
		} finally {
			closeSync(held);
		}
	}

	/** What the record says, naming fences only where `named`. */
	private registry(named: boolean): HostRegistry {
		return {
			key: this.key,
			owner: this.owner,
			sessions: [...this.conversations.values()].map(
				({ id, state, since, fence, shellTold, filesTold }) => ({
					id,
					state,
					since,
					...(fence && shellTold && filesTold && named ? { fence } : {}),
				}),
			),
		};
	}

	private publish(): void {
		const folder = dirname(this.registryPath);
		mkdirSync(folder, { recursive: true, mode: 0o755 });
		// Past a link, outside what the fence keeps read-only, or in a
		// folder another account may write, or under one, from the closed
		// state folder down, now or as the host started, a
		// fenced command or another account could put its own record in
		// this one's place, so none names a fence and the node refuses
		// each session's carry.
		const closed = this.closedAtStart && closedIn(folder, this.closedState);
		if (!closed && !this.saidUnclosed) {
			this.saidUnclosed = true;
			process.stderr.write(
				`pi-host: ${folder} lies past a link, outside ${this.closedState}, or under a folder another account may write, now or as the host started, so its record names no session's fence and a mycelium node carries none of them.\n`,
			);
		}
		const registry = this.registry(closed);
		const temporary = `${this.registryPath}.${randomUUID()}.new`;
		try {
			writeFileSync(temporary, JSON.stringify(registry), {
				flag: "wx",
				mode: 0o600,
			});
			renameSync(temporary, this.registryPath);
		} finally {
			rmSync(temporary, { force: true });
		}
		for (const conversation of this.conversations.values())
			conversation.fenceUnwritten = false;
		// Any write that lands ends an outage, a turn's state most often.
		this.saidUnwritten = undefined;
		this.changes?.changed();
	}
}

/** What became of the record when a write failed (SessionHost.unsay). */
type Unsaid = "rewritten" | "emptied" | "left";

/** What the host's log says of each, after why the write failed. */
const UNSAID: Readonly<Record<Unsaid, string>> = {
	rewritten:
		"so it was rewritten where it lies naming no session's fence, until a write lands",
	emptied:
		"so it was emptied, which names no session's fence, and which pi reads as no host at all, so its sessions are held only where its service keeps them, until a write lands",
	left: "nor rewritten where it lies, so it may still name a fence the host has dropped until a write lands",
};

/** Where in the home folder the fence keeps pi's state read-only (fence-home.ts). */
const CLOSED_STATE = ".local/state/pi";

/** How tight each fence holds a session's tools. */
const TIGHTNESS: Readonly<Record<FenceKind, number>> = {
	none: 0,
	fence: 1,
	strict: 2,
};

/** The looser of two fences, where an unsaid one is no fence yet. */
function loosest(
	kept: FenceKind | undefined,
	told: FenceKind | undefined,
): FenceKind | undefined {
	if (kept === undefined) return told;
	if (told === undefined) return kept;
	return TIGHTNESS[told] < TIGHTNESS[kept] ? told : kept;
}

/**
 * Whether `folder` lies in `closed`, spelled as it really is, through no
 * link, and it and each folder from `closed` down to it are this
 * account's own, which no other may write: another account could
 * otherwise rename one away and put its own, holding its own record, there.
 */
function closedIn(folder: string, closed: string): boolean {
	const folders = downTo(folder, closed);
	return folders !== undefined && folders.every(ownAlone);
}

/** `closed` and each folder below it down to `folder`; none outside it. */
function downTo(folder: string, closed: string): string[] | undefined {
	const at = relative(closed, folder);
	if (at === "" || at.startsWith("..") || isAbsolute(at)) return undefined;
	const steps = at.split(sep);
	return [
		closed,
		...steps.map((_, i) => join(closed, ...steps.slice(0, i + 1))),
	];
}

function ownAlone(folder: string): boolean {
	let real: string;
	let held: Stats;
	try {
		real = realpathSync(folder);
		held = lstatSync(folder);
	} catch {
		return false;
	}
	return (
		real === folder &&
		held.isDirectory() &&
		held.uid === process.getuid?.() &&
		(held.mode & 0o022) === 0
	);
}

/**
 * Count a runner whose shell or file guard told a fence and the other
 * didn't as unfenced: pi ran the other's tools as its own, and what
 * they started may still run.
 */
function untold(conversation: Conversation): void {
	if (Boolean(conversation.shellTold) !== Boolean(conversation.filesTold))
		conversation.fence = "none";
}

/**
 * Clear group and other write from each folder from `closed` down to
 * `folder` that is this account's own and no link, as code before this
 * host may have made them under a looser umask; closedIn then judges
 * them as they stand. The walk stops at the first that isn't at its
 * real path, so nothing past a link is changed; a link swapped in at
 * the last part after that look is refused by the open, though one
 * higher up may still be followed.
 */
function closeToOthers(folder: string, closed: string): void {
	for (const each of downTo(folder, closed) ?? []) {
		let opened: number;
		try {
			if (realpathSync(each) !== each) return;
			opened = openSync(
				each,
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			);
		} catch {
			// closedIn names no fence for a folder it can't read.
			return;
		}
		try {
			const held = fstatSync(opened);
			if (held.uid === process.getuid?.() && (held.mode & 0o022) !== 0)
				fchmodSync(opened, held.mode & 0o7755);
		} catch {
			// As above: left as it is, closedIn judges it.
		} finally {
			closeSync(opened);
		}
	}
}

/** A conversation's private environment: `input` under its own id, never process.env. */
export function sessionEnvironment(
	input: NodeJS.ProcessEnv,
	id: string,
): SessionEnvironment {
	const values: NodeJS.ProcessEnv = { ...input, PI_SESSION_ID: id };
	// Listed again only after a write or delete changes what it holds.
	let names: readonly string[] | undefined;
	return {
		get: (name) => values[name],
		set: (name, value) => {
			if (!(name in values)) names = undefined;
			values[name] = value;
		},
		delete: (name) => {
			if (name in values) names = undefined;
			delete values[name];
		},
		snapshot: () => ({ ...values }),
		names: () => {
			names ??= Object.keys(values);
			return names;
		},
	};
}
