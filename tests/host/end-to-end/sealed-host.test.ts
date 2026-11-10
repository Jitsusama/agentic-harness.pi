/**
 * A host as its own process under a sealed HOME: the ground E1 to E5
 * stand on, proved here on the fake engine until H1's createEngine
 * lands. Each case is one a real host must also pass: it serves two
 * conversations from the seal, ends one at close and keeps the other,
 * comes back from a kill with both under their ids, and parks both at a
 * stop signal for the next start.
 */

import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type HostProcess, startHost } from "./support/host-process.ts";
import { type Seal, seal } from "./support/seal.ts";

const FAKE_ENGINE = resolve(import.meta.dirname, "support/fake-engine.ts");

/**
 * How long a case that starts one host may take: a node process's
 * start and two conversations opened, about a second alone, but past
 * vitest's 5 s on a loaded machine, where H2's gate saw it time out and
 * pass at 60 s.
 */
const ONE_HOST_MS = 60_000;

/** How long the kill of every host a case started may take. */
const TEARDOWN_MS = 30_000;

let sealed: Seal;
let hosts: HostProcess[];
beforeEach(async () => {
	sealed = await seal();
	hosts = [];
});
afterEach(async () => {
	for (const host of hosts) await host.kill();
	await sealed.dispose();
}, TEARDOWN_MS);

async function started(): Promise<HostProcess> {
	const host = await startHost({ seal: sealed, engine: FAKE_ENGINE });
	hosts.push(host);
	return host;
}

const states = (listed: readonly { sessionId: string; state: string }[]) =>
	listed.map(({ sessionId, state }) => [sessionId, state]).sort();

it(
	"serves two conversations from the seal, each in its own folder",
	async () => {
		const host = await started();

		const a = await host.open(join(sealed.root, "a"));
		const b = await host.open(join(sealed.root, "b"));

		expect(
			host.path.startsWith(sealed.root),
			`the socket ${host.path} is under the seal`,
		).toBe(true);
		expect(dirname(a.file), "the host's HOME is the seal's").toBe(
			join(sealed.home, "sessions"),
		);
		expect([a.cwd, b.cwd]).toEqual([
			join(sealed.root, "a"),
			join(sealed.root, "b"),
		]);
		expect(states(await host.list())).toEqual(
			states([
				{ sessionId: a.sessionId, state: "idle" },
				{ sessionId: b.sessionId, state: "idle" },
			]),
		);
	},
	ONE_HOST_MS,
);

it(
	"ends one conversation at close and keeps the other",
	async () => {
		const host = await started();
		const a = await host.open(join(sealed.root, "a"));
		const b = await host.open(join(sealed.root, "b"));

		await host.close(a.sessionId);

		expect(states(await host.list())).toEqual([[b.sessionId, "idle"]]);
	},
	ONE_HOST_MS,
);

it(
	"comes back from a kill with both conversations under their ids",
	async () => {
		const killed = await started();
		const ids = [
			(await killed.open(join(sealed.root, "a"))).sessionId,
			(await killed.open(join(sealed.root, "b"))).sessionId,
		];

		await killed.kill();
		const next = await started();

		expect(next.path).toBe(killed.path);
		expect(states(await next.list())).toEqual(
			states(ids.map((sessionId) => ({ sessionId, state: "idle" }))),
		);
	},
	ONE_HOST_MS * 2,
);

it(
	"parks both at a stop signal and resumes them at the next start",
	async () => {
		const first = await started();
		const ids = [
			(await first.open(join(sealed.root, "a"))).sessionId,
			(await first.open(join(sealed.root, "b"))).sessionId,
		];

		expect(await first.stop(), first.errors()).toBe(0);
		const next = await started();

		expect(states(await next.list())).toEqual(
			states(ids.map((sessionId) => ({ sessionId, state: "idle" }))),
		);
	},
	ONE_HOST_MS * 2,
);
