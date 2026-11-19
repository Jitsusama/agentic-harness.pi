/** A conversation's store: opened with no checkpoint on the host's thread, and checkpointed elsewhere as it closes. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Checkpoints } from "../../../host/engine/checkpoints.ts";
import type { HostPiModules } from "../../../host/engine/host-pi.ts";
import { openHostedConversation } from "../../../host/engine/hosted-conversation.ts";
import type { PiLibrary } from "../../../host/engine/pi-library.ts";
import type {
	StoreDatabase,
	StoreThreads,
} from "../../../host/engine/store-threads.ts";

/** What happened to the store, in order. */
type Said = string[];

/** A pi whose durable side records what was done to its one store, at `path`. */
function modulesSaying(said: Said): HostPiModules {
	const none = {};
	return {
		codingAgent: none,
		builtins: none,
		projectTrust: none,
		agentCore: none,
		ai: none,
		tui: none,
		nodeEnv: none,
		context: { BACKGROUND_CONTEXT: {} },
		sqlite: {
			SqliteStorage: {
				open: async (database: { name: string }) => {
					said.push(`storage on ${database.name}`);
					return {};
				},
			},
		},
		durable: {
			Harness: {
				open: async () => ({
					root: async () => ({ id: 1 }),
					close: async () => {
						said.push("close the store");
					},
				}),
			},
			createRegistry: () => ({}),
			defineExtension: (extension: unknown) => extension,
			hook: () => ({}),
			GenerationTask: {},
			LiveDoc: {},
		},
	};
}

/** Checkpoints that record what they were asked. */
function checkpointsSaying(said: Said): Checkpoints {
	return {
		storeOptions: { walAutoCheckpointPages: 0 },
		keep(path) {
			said.push(`keep ${path}`);
			return {
				settle: async () => {
					said.push(`checkpoint ${path}`);
				},
				release: () => {
					said.push(`release ${path}`);
				},
			};
		},
	};
}

/** Store threads that record what they were asked, and open a database named for the thread. */
function storesSaying(said: Said): StoreThreads {
	return {
		async open(path, options) {
			said.push(`open ${path} ${JSON.stringify(options ?? {})}`);
			// Only its name and close are read here.
			return {
				name: "the store's thread",
				close: async () => {
					said.push("close the store's thread");
				},
			} as unknown as StoreDatabase;
		},
	};
}

/** Open a conversation on `modules`, kept by `checkpoints`, in a folder made for it. */
async function opened(
	modules: HostPiModules,
	checkpoints: Checkpoints,
	storePath: string,
	said: Said = [],
) {
	return openHostedConversation({
		modules,
		// The store's tests never build an agent, so pi's library is never read.
		library: {} as PiLibrary,
		storePath,
		env: async () => ({}),
		checkpoints,
		stores: storesSaying(said),
	});
}

let path: string;
beforeEach(async () => {
	path = join(await mkdtemp(join(tmpdir(), "store-")), "durable.sqlite");
});
afterEach(async () => {
	await rm(join(path, ".."), { recursive: true, force: true });
});

describe("a conversation's store", () => {
	it("opens with no checkpoint of its own, and is kept checkpointed elsewhere", async () => {
		const said: Said = [];
		await opened(modulesSaying(said), checkpointsSaying(said), path, said);
		expect(said).toEqual([
			`open ${path} {"walAutoCheckpointPages":0}`,
			"storage on the store's thread",
			`keep ${path}`,
		]);
	});

	it("lets the store's thread go when durable's storage can't open on it", async () => {
		const said: Said = [];
		const modules = modulesSaying(said);
		const refusing: HostPiModules = {
			...modules,
			sqlite: {
				SqliteStorage: {
					open: async () => {
						throw new Error("the schema is newer");
					},
				},
			},
		};
		await expect(
			opened(refusing, checkpointsSaying(said), path, said),
		).rejects.toThrow("the schema is newer");
		expect(said).toEqual([
			`open ${path} {"walAutoCheckpointPages":0}`,
			"close the store's thread",
		]);
	});

	it("opens on durable's storage when it is a class, as pi-durable ships it", async () => {
		const said: Said = [];
		const modules = modulesSaying(said);
		const asClass: HostPiModules = {
			...modules,
			sqlite: {
				SqliteStorage: class Storage {
					readonly database: { name: string };
					constructor(database: { name: string }) {
						this.database = database;
					}
					static async open(database: { name: string }) {
						said.push(`class storage on ${database.name}`);
						// As pi-durable's does: only a call bound to the class builds one.
						return new this(database);
					}
				},
			},
		};
		await opened(asClass, checkpointsSaying(said), path, said);
		expect(said).toContain("class storage on the store's thread");
	});

	it("lets the store's thread go when durable's harness can't open on it", async () => {
		const said: Said = [];
		const modules = modulesSaying(said);
		const refusing: HostPiModules = {
			...modules,
			durable: {
				...modules.durable,
				Harness: {
					open: async () => {
						throw new Error("the harness refused");
					},
				},
			},
		};
		await expect(
			opened(refusing, checkpointsSaying(said), path, said),
		).rejects.toThrow("the harness refused");
		expect(said).toEqual([
			`open ${path} {"walAutoCheckpointPages":0}`,
			"storage on the store's thread",
			"close the store's thread",
		]);
	});

	it("closes the harness, then the store's thread, when its root can't be read", async () => {
		const said: Said = [];
		const modules = modulesSaying(said);
		const rootless: HostPiModules = {
			...modules,
			durable: {
				...modules.durable,
				Harness: {
					open: async () => ({
						root: async () => {
							throw new Error("no root");
						},
						close: async () => {
							said.push("close the store");
						},
					}),
				},
			},
		};
		await expect(
			opened(rootless, checkpointsSaying(said), path, said),
		).rejects.toThrow("no root");
		expect(said).toEqual([
			`open ${path} {"walAutoCheckpointPages":0}`,
			"storage on the store's thread",
			"close the store",
			"close the store's thread",
		]);
	});

	it("is checkpointed before it closes, and let go once closed", async () => {
		const said: Said = [];
		const conversation = await opened(
			modulesSaying(said),
			checkpointsSaying(said),
			path,
		);
		said.length = 0;
		await conversation.close();
		expect(said).toEqual([
			`checkpoint ${path}`,
			"close the store",
			`release ${path}`,
		]);
	});
});
