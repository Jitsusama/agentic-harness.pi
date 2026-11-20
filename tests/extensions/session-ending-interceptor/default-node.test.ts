/**
 * The node the session-ending interceptor reads by default: every realm's
 * node on the machine, the machines they named kept across a fresh start,
 * and whether the session is on the mesh at all.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeDeps } from "../../../extensions/session-ending-interceptor/index.ts";

/** A node at `socket` holding one idle session on `machine`. */
async function nodeAnswering(
	socket: string,
	address: string,
	machine: string,
	listed: readonly string[] = [machine],
): Promise<Server> {
	const server = createServer((client) => {
		client.setEncoding("utf8");
		client.on("data", (line: string) => {
			const asked = line.trim();
			const answer =
				asked === '"Machines"'
					? { Ok: { Machines: listed.map((name) => ({ name })) } }
					: {
							Ok: {
								Sessions: [{ id: address, address, machine, state: "idle" }],
							},
						};
			client.write(`${JSON.stringify(answer)}\n`);
		});
	});
	await new Promise<void>((listening) => server.listen(socket, listening));
	return server;
}

describe("the node the interceptor reads by default", () => {
	const empty = () => mkdtempSync(join(tmpdir(), "session-ending-"));

	it("remembers the machines its nodes named, across a fresh start while none answers and a read of only some", async () => {
		const state = empty();
		const run = join(state, "run");
		mkdirSync(join(run, "mycelium"), { recursive: true });
		const work = join(run, "mycelium", "work.sock");
		const personal = join(run, "mycelium", "personal.sock");
		const env = {
			MYCELIUM_REALM: "work",
			XDG_STATE_HOME: state,
			XDG_RUNTIME_DIR: run,
		};
		const closing = (server: Server) =>
			new Promise<void>((closed) => server.close(() => closed()));
		const servers = await Promise.all([
			nodeAnswering(work, "BXNMUC", "optimus"),
			nodeAnswering(personal, "A210QS", "penelope"),
		]);
		try {
			await nodeDeps(env).machines();
			await Promise.all(servers.splice(0).map(closing));

			expect([...((await nodeDeps(env).machines()) ?? [])].sort()).toEqual([
				"optimus",
				"penelope",
			]);

			servers.push(await nodeAnswering(personal, "A210QS", "titan"));
			expect([...((await nodeDeps(env).machines()) ?? [])].sort()).toEqual([
				"optimus",
				"penelope",
				"titan",
			]);
		} finally {
			await Promise.all(servers.map(closing));
			rmSync(state, { recursive: true, force: true });
		}
	});

	it("remembers a machine only a node's sessions named, across a fresh start while none answers", async () => {
		const state = empty();
		const run = join(state, "run");
		mkdirSync(join(run, "mycelium"), { recursive: true });
		const env = {
			MYCELIUM_REALM: "work",
			XDG_STATE_HOME: state,
			XDG_RUNTIME_DIR: run,
		};
		const server = await nodeAnswering(
			join(run, "mycelium", "work.sock"),
			"EWUL44",
			"equilibrius",
			["optimus"],
		);
		try {
			await nodeDeps(env).sessions();
		} finally {
			await new Promise<void>((closed) => server.close(() => closed()));
		}
		try {
			expect(await nodeDeps(env).machines()).toContain("equilibrius");
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});

	it("is on the mesh where a realm is named, though no runtime folder says where its socket is", async () => {
		const state = empty();
		try {
			const deps = nodeDeps({
				MYCELIUM_REALM: "work",
				XDG_STATE_HOME: state,
				XDG_RUNTIME_DIR: join(state, "run"),
			});

			expect(deps.onMesh(), "a named realm puts the session on the mesh").toBe(
				true,
			);
			expect(await deps.sessions()).toBeUndefined();
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});

	it.each([
		["the session names", { MYCELIUM_REALM: "../work" }, undefined],
		["the session names as blanks", { MYCELIUM_REALM: "  " }, undefined],
		["the node keeps", {}, "../work"],
	])(
		"is on the mesh where the realm %s is no name a socket's file may carry, so its sessions can't be read",
		async (_, named, kept) => {
			const state = empty();
			try {
				const run = join(state, "run");
				mkdirSync(join(run, "mycelium"), { recursive: true });
				if (kept !== undefined) {
					mkdirSync(join(state, "mycelium"), { recursive: true });
					writeFileSync(join(state, "mycelium", "realm"), `${kept}\n`);
				}
				const deps = nodeDeps({
					...named,
					XDG_STATE_HOME: state,
					XDG_RUNTIME_DIR: run,
				});

				expect(deps.onMesh(), "a malformed realm still names one").toBe(true);
				expect(
					await deps.sessions(),
					"its node's sessions can't be read, so an ask is refused",
				).toBeUndefined();
			} finally {
				rmSync(state, { recursive: true, force: true });
			}
		},
	);

	it("reads the sessions of every realm's node on the machine", async () => {
		const state = empty();
		const run = join(state, "run");
		mkdirSync(join(run, "mycelium"), { recursive: true });
		const servers = await Promise.all([
			nodeAnswering(join(run, "mycelium", "work.sock"), "BXNMUC", "optimus"),
			nodeAnswering(
				join(run, "mycelium", "personal.sock"),
				"A210QS",
				"penelope",
			),
		]);
		try {
			const env = {
				MYCELIUM_REALM: "work",
				XDG_STATE_HOME: state,
				XDG_RUNTIME_DIR: run,
			};
			const sessions = await nodeDeps(env).sessions();

			expect(sessions?.map((one) => one.address).sort()).toEqual([
				"A210QS",
				"BXNMUC",
			]);
			expect([...((await nodeDeps(env).machines()) ?? [])].sort()).toEqual([
				"optimus",
				"penelope",
			]);

			writeFileSync(join(run, "mycelium", "stale.sock"), "");
			expect(
				(await nodeDeps(env).sessions())?.map((one) => one.address).sort(),
			).toEqual(["A210QS", "BXNMUC"]);

			const silent = createServer(() => {});
			await new Promise<void>((listening) =>
				silent.listen(join(run, "mycelium", "quiet.sock"), listening),
			);
			servers.push(silent);
			expect(await nodeDeps(env).sessions()).toBeUndefined();
		} finally {
			for (const server of servers) server.close();
			rmSync(state, { recursive: true, force: true });
		}
	});

	it("is off the mesh where no realm is named", () => {
		const state = empty();
		try {
			expect(
				nodeDeps({ XDG_STATE_HOME: state }).onMesh(),
				"no realm named leaves the session off the mesh",
			).toBe(false);
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});
});
