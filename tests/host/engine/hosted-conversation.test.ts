/** A conversation's store: opened with no checkpoint on the host's thread, and checkpointed elsewhere as it closes. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Checkpoints } from "../../../host/engine/checkpoints.ts";
import type { HostPiModules } from "../../../host/engine/host-pi.ts";
import { openHostedConversation } from "../../../host/engine/hosted-conversation.ts";
import type { PiLibrary } from "../../../host/engine/pi-library.ts";

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
			openNodeSqliteStorage: async (path: string, options?: object) => {
				said.push(`open ${path} ${JSON.stringify(options ?? {})}`);
				return { path };
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

/** Open a conversation on `modules`, kept by `checkpoints`, in a folder made for it. */
async function opened(
	modules: HostPiModules,
	checkpoints: Checkpoints,
	storePath: string,
) {
	return openHostedConversation({
		modules,
		// The store's tests never build an agent, so pi's library is never read.
		library: {} as PiLibrary,
		storePath,
		env: async () => ({}),
		checkpoints,
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
		await opened(modulesSaying(said), checkpointsSaying(said), path);
		expect(said).toEqual([
			`open ${path} {"walAutoCheckpointPages":0}`,
			`keep ${path}`,
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
