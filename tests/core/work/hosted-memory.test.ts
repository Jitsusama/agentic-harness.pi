/** Two conversations in one host remain distinct holders of shared work. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { installHost, withSession } from "../../../lib/core/session/index.ts";
import type { HeldTree } from "../../../lib/core/work/broker.ts";
import { createTreeMemory, TreeInUse } from "../../../lib/core/work/memory.ts";
import { sessionHost } from "../../support/session-host.ts";

const OWNER = { pid: 123, startedAt: 1_760_000_000_000 };
const facts = { alive: () => true, startedAt: async () => OWNER.startedAt };
let root: string;
let removeHost: () => void;
let close: (id: string, why: string) => void | Promise<void>;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hosted-tree-"));
	const { host } = sessionHost(OWNER);
	removeHost = installHost(host);
	close = host.close;
});
afterEach(() => {
	removeHost();
	rmSync(root, { recursive: true, force: true });
});

it("B sees A as another holder, and releasing A never removes B", async () => {
	const memory = createTreeMemory(join(root, "records"));
	const path = join(root, "tree");
	mkdirSync(path);
	const tree: HeldTree = {
		path,
		identity: { key: "shared", shareable: true },
		providerId: "git",
	};
	await withSession("a", () => memory.rememberHeldByUs(tree, facts));
	expect(
		await withSession("b", () => memory.otherHolders(path, facts)),
	).toEqual([{ ...OWNER, session: "a", host: "test-host" }]);

	await withSession("b", () => memory.rememberHeldByUs(tree, facts));
	expect(memory.recall()[0]?.owners?.map((owner) => owner.session)).toEqual([
		"a",
		"b",
	]);
	await withSession("a", () => memory.forgetUsAsHolder(path, facts));
	expect(memory.recall()[0]?.owners?.map((owner) => owner.session)).toEqual([
		"b",
	]);
	await close("a", "test");

	expect(await memory.heldNow(facts)).toHaveLength(1);
	expect(
		await withSession("b", () => memory.otherHolders(path, facts)),
	).toEqual([]);
});

it("a closed conversation no longer holds its tree while the host lives", async () => {
	const memory = createTreeMemory(join(root, "records"));
	const path = join(root, "tree");
	mkdirSync(path);
	await withSession("a", () =>
		memory.rememberHeldByUs(
			{
				path,
				identity: { key: "only-a", shareable: false },
				providerId: "git",
			},
			facts,
		),
	);

	await close("a", "test");

	expect(await memory.heldNow(facts)).toEqual([]);
});

it("finishes a stopped removal whose only joiners are its own conversation, and refuses one another joined", async () => {
	// In a host every conversation shares its process, and one resumed
	// after a restart is named again under a new one: read as joiners, the
	// marking conversation's own names would keep its removal unfinished.
	const memory = createTreeMemory(join(root, "records"));
	const holder = { ...OWNER, session: "a", host: "test-host" };
	const resumed = { pid: 456, startedAt: OWNER.startedAt, session: "a" };
	const stoppedAt = (key: string, joiner?: typeof holder): HeldTree => {
		const path = join(root, key);
		mkdirSync(path);
		const tree: HeldTree = {
			path,
			identity: { key, shareable: true },
			providerId: "git",
			owners: [
				holder,
				{ ...resumed, host: "test-host" },
				...(joiner ? [joiner] : []),
			],
			going: { at: Date.now(), by: OWNER, holder },
		};
		memory.remember(tree);
		return tree;
	};
	const own = stoppedAt("own");
	const joined = stoppedAt("joined", {
		...OWNER,
		session: "b",
		host: "test-host",
	});
	const released: string[] = [];
	const release = (tree: HeldTree) => async () => {
		released.push(tree.path);
		rmSync(tree.path, { recursive: true, force: true });
	};

	await withSession("b", () => memory.finishGoing(own, release(own), facts));
	await expect(
		withSession("b", () => memory.finishGoing(joined, release(joined), facts)),
		"the removal another conversation joined",
	).rejects.toThrow(TreeInUse);

	expect(released, "what was released").toEqual([own.path]);
	expect(
		memory.recall().map((one) => one.identity.key),
		"the records left",
	).toEqual(["joined"]);
});
