/**
 * A fleet's subagent on the mesh, as its parent's hands: what it runs
 * and changes is claimed as the parent's, the holds reaching the parent
 * reach it before it starts what they name, and nothing else does.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { meshHand } from "../../../extensions/mesh-workflow/hand.ts";
import {
	HAND_EXTENSION,
	type MeshPaths,
} from "../../../extensions/mesh-workflow/index.ts";
import { ALL, homeOf } from "../../../lib/mesh/group.ts";
import {
	changeSubject,
	createBoard,
	type Lease,
	type LeaseKind,
} from "../../../lib/mesh/lease.ts";
import { shortId } from "../../../lib/mesh/message.ts";
import { createPresences, type Presence } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import { SUBAGENT_REGISTER_DEFAULT_EXTENSION } from "../../../lib/subagent/events.ts";

let root: string;
let paths: MeshPaths;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-hand-"));
	paths = {
		mesh: join(root, "mesh"),
		sessions: join(root, "sessions"),
		quests: join(root, "quests"),
	};
	const presences = createPresences(join(paths.mesh, "presence"));
	presences.publish(present("parent", "PARENT"));
	presences.publish(present("other", "OTHERS"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const fleet = {
	SUBAGENT_SUPERVISOR: "1",
	SUBAGENT_RUN_ID: "run-1",
	SUBAGENT_ID: "lens",
	PI_MESH_SESSION: "parent",
};
const handSession = "parent.hand.run-1.lens";

function present(session: string, address: string): Presence {
	return {
		session,
		addresses: [address],
		groups: [],
		worksOn: "",
		owns: [],
		busy: false,
		at: new Date().toISOString(),
	};
}

const board = () => createBoard(join(paths.mesh, "leases"));
const transport = () => folderTransport(join(paths.mesh, "messages"));

/** Another peer's lease, on the board. */
function othersLease(kind: LeaseKind, subject: string): Lease {
	const lease = {
		kind,
		subject,
		since: new Date().toISOString(),
		until: new Date(Date.now() + 10 * 60_000).toISOString(),
	};
	const before = board().of("other")?.leases ?? [];
	board().hold({ session: "other", leases: [...before, lease] });
	return lease;
}

/** A hold another peer sends, standing on the board as it does. */
function othersHold(text: string) {
	const hold = transport().send({
		from: "OTHERS",
		to: [ALL],
		intent: "hold",
		text,
		pid: process.pid + 1,
	});
	othersLease("hold", hold.id);
	return hold;
}

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Load the extension in a subagent, with just enough of pi to run it. */
async function startHand(env: NodeJS.ProcessEnv = fleet) {
	const said: string[] = [];
	const emitted: [string, unknown][] = [];
	const lifecycle = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: Handler) => lifecycle.set(event, handler),
		sendMessage: (message: { content: string }) => said.push(message.content),
		events: {
			on: () => {},
			emit: (channel: string, data: unknown) => emitted.push([channel, data]),
		},
	};
	meshHand(paths, env)(pi as never);
	await lifecycle.get("session_start")?.({ reason: "startup" }, {});
	const fire = (event: string, payload: unknown = {}, at: unknown = {}) =>
		lifecycle.get(event)?.(payload, at);
	const bash = (id: string, command: string) =>
		fire("tool_call", { toolName: "bash", toolCallId: id, input: { command } });
	return { said, emitted, lifecycle, fire, bash };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const handLeases = () => board().of(handSession);

describe("a subagent no peer started", () => {
	it("is not on the mesh at all", async () => {
		const { lifecycle, emitted } = await startHand({
			SUBAGENT_RUN_ID: "run-1",
		});

		expect(lifecycle.size).toBe(0);
		expect(emitted).toEqual([]);
	});
});

describe("a peer's hand", () => {
	it("has the subagents it starts work as the same peer's hands", async () => {
		const { emitted } = await startHand();

		expect(emitted).toEqual([
			[SUBAGENT_REGISTER_DEFAULT_EXTENSION, HAND_EXTENSION],
		]);
	});

	it("claims heavy work as its peer's, telling another peer running it once", async () => {
		othersLease("heavy", "build");
		const { said, bash, fire } = await startHand();

		expect(await bash("1", "nix build .#x")).toBeUndefined();
		await settle();

		expect(handLeases()?.handOf).toBe("parent");
		expect(handLeases()?.leases).toMatchObject([
			{
				kind: "heavy",
				subject: "build",
				why: "nix build .#x, by a subagent",
			},
		]);
		const told = transport()
			.ids()
			.flatMap((id) => transport().read(id) ?? [])
			.filter((one) => one.intent === "fyi");
		expect(told).toMatchObject([{ from: "PARENT", to: [homeOf("OTHERS")] }]);
		expect(said.join("\n")).toContain(
			"say so in your answer, for the session that started you",
		);

		await fire("tool_result", { toolCallId: "1", content: [] });
		await settle();
		expect(handLeases()).toBeUndefined();
	});

	it("holds back a heavy command once while a hold reaching its peer stands", async () => {
		const hold = othersHold("hold builds: rebooting");
		const { bash } = await startHand();

		expect(await bash("1", "ls -la")).toBeUndefined();
		const first = (await bash("2", "nix build .#x")) as {
			block: boolean;
			reason: string;
		};
		expect(first.block).toBe(true);
		expect(first.reason).toContain(`OTHERS holds [${shortId(hold)}]`);
		expect(first.reason).toContain("hold builds: rebooting");
		expect(first.reason).toContain("this runs a build");

		expect(await bash("3", "nix build .#x")).toBeUndefined();
	});

	it("lets a VM check bound for the builder past a hold, as it doesn't run here", async () => {
		// The remote check interceptor rewrites it after the mesh's handler
		// runs, so the mesh reads the command as it will run (send.ts).
		const repo = join(root, "public");
		mkdirSync(repo);
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
		git("init", "-q");
		writeFileSync(join(repo, "flake.nix"), "{ }\n");
		git("add", "flake.nix");
		git(
			"-c",
			"user.email=t@t",
			"-c",
			"user.name=t",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qm",
			"one",
		);
		git("remote", "add", "origin", "https://github.com/Owner/public.git");
		const config = join(root, "config", "pi", "agentic-harness.pi");
		mkdirSync(config, { recursive: true });
		writeFileSync(
			join(config, "config.json"),
			JSON.stringify({
				version: 1,
				sections: { "remote-checks": { repos: ["Owner/public"] } },
			}),
		);
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "nix-offload"),
			"#!/bin/sh\nprintf 'tree\\napply\\nout\\nwants\\n'\n",
			{ mode: 0o755 },
		);
		const before = {
			path: process.env.PATH,
			config: process.env.XDG_CONFIG_HOME,
		};
		process.env.PATH = `${bin}:${before.path ?? ""}`;
		process.env.XDG_CONFIG_HOME = join(root, "config");
		try {
			othersHold("hold VM tests: rebooting");
			const { fire } = await startHand();
			const check = (id: string, cwd: string) =>
				fire(
					"tool_call",
					{
						toolName: "bash",
						toolCallId: id,
						input: {
							command: "nix build --no-link .#checks.x86_64-linux.vm-a",
						},
					},
					{ cwd },
				);

			expect(await check("sent", repo)).toBeUndefined();
			expect(await check("here", root)).toMatchObject({ block: true });
		} finally {
			process.env.PATH = before.path;
			if (before.config === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = before.config;
		}
	});

	it("lets a command that only looks for heavy work past a hold, as the queue does", async () => {
		othersHold("hold builds: rebooting");
		const { bash } = await startHand();

		expect(await bash("1", "pgrep -x qemu-system-x86")).toBeUndefined();
		expect(await bash("2", "qemu-img info disk.qcow2")).toBeUndefined();
		expect(await bash("3", "./result/bin/nixos-test-driver")).toMatchObject({
			block: true,
		});
	});

	it("is told of the holds standing as it starts, and when each is over", async () => {
		const hold = othersHold("hold builds: rebooting");
		const { fire, said } = await startHand();

		const started = (await fire("before_agent_start")) as {
			message: { content: string };
		};
		expect(started.message.content).toContain("hold builds: rebooting");
		expect(started.message.content).toContain("You cannot answer on the mesh");
		expect(await fire("before_agent_start")).toBeUndefined();

		board().hold({ session: "other", leases: [] });
		await fire("turn_end");
		expect(said).toEqual([`The mesh hold [${shortId(hold)}] is over.`]);
	});

	it("is held back once from rewriting a checkout another peer changes files in", async () => {
		mkdirSync(join(root, ".git"));
		board().hold({
			session: "other",
			leases: [{ ...othersLease("change", "x:a.ts"), checkout: root }],
		});
		const { fire } = await startHand();
		const stash = () =>
			fire(
				"tool_call",
				{ toolName: "bash", toolCallId: "s", input: { command: "git stash" } },
				{ cwd: root },
			);

		expect(await stash()).toMatchObject({ block: true });
		expect(await stash()).toBeUndefined();
		expect(handLeases()?.leases).toMatchObject([
			{ kind: "change", subject: root },
		]);
	});

	it("is held back once from a file another peer is changing, then claims it", async () => {
		const path = join(root, "a.ts");
		othersLease("change", changeSubject(path, root));
		const { fire } = await startHand();
		const edit = () =>
			fire(
				"tool_call",
				{ toolName: "edit", toolCallId: "e", input: { path } },
				{ cwd: root },
			);

		expect(await edit()).toMatchObject({ block: true });
		expect(await edit()).toBeUndefined();
		expect(handLeases()?.leases).toMatchObject([{ kind: "change" }]);

		await fire("agent_end");
		expect(handLeases()).toBeUndefined();
	});
});
