/** Conversation ownership installed before pi loads any hosted extensions. */
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { isOwner } from "../../lib/core/process/index.ts";
import {
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
	launchHints: LaunchHints;
	cleanup: ConversationRegistration["close"];
	stampCallback: ConversationRegistration["stamp"];
	reloadCallback: ConversationRegistration["reload"];
	parkCallback: ConversationRegistration["park"];
	restartingCallback: ConversationRegistration["restarting"];
	reloading?: Promise<void>;
	ending?: "signalled" | "closed";
	stamped?: "signalled" | "closed";
	closing?: Promise<void>;
	accepting: boolean;
	disposed: boolean;
}

/** One host's live ownership; persisted restart rosters belong to the service. */
export class SessionHost implements Host {
	readonly kind = "pi-durable";
	readonly key: string;
	readonly owner: SessionOwner;
	readonly registryPath: string;
	private readonly conversations = new Map<string, Conversation>();
	private readonly uninstall: () => void;
	private readonly own: NodeJS.ProcessEnv = process.env;
	private disposed = false;

	constructor(options: {
		key: string;
		owner: SessionOwner;
		registryDir?: string;
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
		this.conversations.set(input.id, {
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

	/** Stop admission, then dispose only this session; a failed close stays held. */
	close(id: string, why = "closed"): Promise<void> {
		return this.finish(id, why, "closed");
	}

	/**
	 * Reload one conversation, keeping its ownership, slots, environment
	 * and list entry: no stamp, no park, no release. A second ask while one
	 * is under way joins it. A failed reload leaves the conversation held
	 * and usable, and rejects with why.
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

	/**
	 * Stop for host restart without recording a deliberate conversation
	 * quit. `restarting` when the stop is a restart the host asked for, so
	 * the conversation may carry its work to the next host.
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
				releaseSession(id);
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
		const previous = { state: conversation.state, since: conversation.since };
		Object.assign(conversation, { state, since: new Date().toISOString() });
		try {
			this.publish();
		} catch (error) {
			Object.assign(conversation, previous);
			throw error;
		}
	}

	private publish(): void {
		const registry: HostRegistry = {
			key: this.key,
			owner: this.owner,
			sessions: this.list().map(({ id, state, since }) => ({
				id,
				state,
				since,
			})),
		};
		mkdirSync(dirname(this.registryPath), { recursive: true });
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
