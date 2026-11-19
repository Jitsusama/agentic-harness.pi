/**
 * An ask of the person to end a machine's sessions, in a reply, an ask
 * or a look, is refused while the node says others are live there, and
 * when it can't say; anything else goes as it was.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	nodeDeps,
	sessionEndingInterceptor,
} from "../../../extensions/session-ending-interceptor/index.ts";
import { forgetRedirects } from "../../../lib/guardian/apply.ts";
import { setSessionMode } from "../../../lib/guardian/policy.ts";
import type { NodeSession } from "../../../lib/mesh/node.ts";
import { type FakePi, fakePi } from "../../support/fake-pi.ts";

const SELF = "self-session";
const GUARD = "no-session-ending-ask-while-live";

const ctx = { sessionManager: { getSessionId: () => SELF } };

const someoneOn = (machine: string, state: NodeSession["state"] = "idle") => [
	{ id: "other", address: "EWUL44", machine, state },
	{ id: SELF, address: "0IM95G", machine: "optimus", state: "busy" as const },
];

let node: NodeSession[] | undefined;
let listed: string[] | undefined;
let asked: number;
let onMesh: boolean;
let pi: FakePi;
let sentWith: unknown[];

beforeEach(() => {
	node = someoneOn("equilibrius");
	listed = undefined;
	asked = 0;
	onMesh = true;
	sentWith = [];
	pi = fakePi();
	const send = pi.sendMessage;
	pi.sendMessage = (message, options) => {
		sentWith.push(options);
		send(message, options);
	};
	setSessionMode(GUARD, "block");
	forgetRedirects();
	sessionEndingInterceptor({
		onMesh: () => onMesh,
		sessions: async () => {
			asked++;
			return node;
		},
		machines: async () => listed,
		here: () => "optimus",
	})(pi);
});

const handler = (event: string) => {
	const [one] = pi.recorded.handlers.get(event) ?? [];
	if (!one) throw new Error(`nothing listens for ${event}`);
	return one;
};

const call = (toolName: string, input: unknown) =>
	handler("tool_call")(
		{ type: "tool_call", toolName, toolCallId: "c1", input },
		ctx,
	);

const replyStopping = (stopReason: string, ...content: object[]) =>
	handler("message_end")(
		{
			type: "message_end",
			message: { role: "assistant", content, stopReason },
		},
		ctx,
	);

const reply = (...content: object[]) => replyStopping("stop", ...content);

const settle = () => handler("agent_settled")({ type: "agent_settled" }, ctx);

const text = (said: string) => ({ type: "text", text: said });

/** A node at `socket` holding one idle session on `machine`. */
async function nodeAnswering(
	socket: string,
	address: string,
	machine: string,
): Promise<Server> {
	const server = createServer((client) => {
		client.setEncoding("utf8");
		client.on("data", (line: string) => {
			const asked = line.trim();
			const answer =
				asked === '"Machines"'
					? { Ok: { Machines: [{ name: machine }] } }
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

describe("an ask tool call", () => {
	it("is refused when its prompt asks for a log-out on a machine others are on", async () => {
		const verdict = await call("ask", {
			questions: [
				{
					id: "q",
					prompt: "Could you log out of macOS on equilibrius to pair the card?",
					options: [{ value: "done", label: "Done" }],
				},
			],
		});

		expect(verdict).toMatchObject({ block: true });
		expect(JSON.stringify(verdict)).toContain("EWUL44 (idle)");
	});

	it("is refused when an option is the act itself", async () => {
		const verdict = await call("ask", {
			questions: [
				{
					id: "q",
					prompt: "The new kernel is in. What now?",
					options: [
						{ value: "now", label: "Reboot equilibrius now" },
						{ value: "later", label: "Later" },
					],
				},
			],
		});

		expect(verdict).toMatchObject({ block: true });
	});

	it("goes ahead when only the asker is on the machine", async () => {
		node = [
			{
				id: "other",
				address: "EWUL44",
				machine: "equilibrius",
				state: "ended",
			},
			{ id: SELF, address: "0IM95G", machine: "equilibrius", state: "busy" },
			{ id: "far", address: "FAR001", machine: "optimus", state: "idle" },
		];
		const verdict = await call("ask", {
			questions: [
				{ id: "q", prompt: "Please reboot equilibrius.", options: [] },
			],
		});

		expect(verdict).toBeUndefined();
	});

	it("goes ahead without asking the node when nothing could be an ask", async () => {
		const verdict = await call("ask", {
			questions: [{ id: "q", prompt: "Which colour?", options: [] }],
		});

		expect(verdict).toBeUndefined();
		expect(asked).toBe(0);
	});

	it("goes ahead for a machine the realm lists that no one is on", async () => {
		listed = ["optimus", "equilibrius", "penelope"];
		const verdict = await call("ask", {
			questions: [{ id: "q", prompt: "Please reboot penelope.", options: [] }],
		});

		expect(verdict).toBeUndefined();
	});

	it("goes ahead, under redirect, when asked again after a session's state moved", async () => {
		setSessionMode(GUARD, "redirect");
		const input = {
			questions: [
				{ id: "q", prompt: "Please reboot equilibrius.", options: [] },
			],
		};
		expect(await call("ask", input)).toMatchObject({ block: true });

		node = someoneOn("equilibrius", "busy");

		expect(await call("ask", input)).toBeUndefined();
	});

	it("goes ahead where no realm is named, so there is no node to ask", async () => {
		onMesh = false;
		const verdict = await call("ask", {
			questions: [
				{ id: "q", prompt: "Please reboot equilibrius.", options: [] },
			],
		});

		expect(verdict).toBeUndefined();
		expect(asked).toBe(0);
	});
});

describe("a mesh_wait call", () => {
	it("is refused when what waits on the person is the act", async () => {
		expect(
			await call("mesh_wait", { id: "w", title: "Reboot equilibrius" }),
		).toMatchObject({ block: true });
	});

	it("is refused when it is done at the next boot", async () => {
		expect(
			await call("mesh_wait", {
				id: "w",
				title: "Take the new kernel on equilibrius",
				doneWhen: { signal: "boot" },
			}),
		).toMatchObject({ block: true });
	});

	it("is refused when a step is the act, on the machine the wait names", async () => {
		expect(
			await call("mesh_wait", {
				id: "w",
				title: "Take the new kernel",
				machine: "equilibrius",
				steps: ["Save your work", "Restart"],
			}),
		).toMatchObject({ block: true });
	});

	it("goes ahead when a step is the act on a machine with no one else on it", async () => {
		expect(
			await call("mesh_wait", {
				id: "w",
				title: "Take the new kernel",
				machine: "optimus",
				steps: ["Save your work", "Restart"],
			}),
		).toBeUndefined();
	});

	it("is refused when its title names the act as a noun", async () => {
		expect(
			await call("mesh_wait", {
				id: "w",
				title: "Equilibrius log-out to pair the card",
			}),
		).toMatchObject({ block: true });
	});

	it("is refused when a step is a menu path to the act", async () => {
		expect(
			await call("mesh_wait", {
				id: "w",
				title: "Pair the card",
				machine: "equilibrius",
				steps: ["Apple menu \u2192 Log Out", "Pair at the login window"],
			}),
		).toMatchObject({ block: true });
	});

	it("is refused when the check it is done by ends sessions", async () => {
		expect(
			await call("mesh_wait", {
				id: "w",
				title: "Pair the card",
				doneWhen: { check: "loginctl terminate-user $USER" },
			}),
		).toMatchObject({ block: true });
	});

	it("goes ahead for a step or a boot on a machine nobody else is on, though others are elsewhere", async () => {
		node = someoneOn("optimus");
		listed = ["optimus", "equilibrius"];
		const wait = {
			id: "w",
			title: "Take the new kernel",
			machine: "equilibrius",
		};

		expect(
			await call("mesh_wait", {
				...wait,
				steps: ["Save your work", "Restart"],
			}),
		).toBeUndefined();
		expect(
			await call("mesh_wait", { ...wait, doneWhen: { signal: "boot" } }),
		).toBeUndefined();
	});

	it("goes ahead when it settles an item, whatever its title", async () => {
		expect(
			await call("mesh_wait", {
				id: "kernel",
				title: "Reboot equilibrius",
				done: true,
			}),
		).toBeUndefined();
	});

	it("goes ahead for a wait that ends nothing", async () => {
		expect(
			await call("mesh_wait", {
				id: "w",
				title: "Pick the theme",
				why: "It's a matter of taste.",
			}),
		).toBeUndefined();
	});
});

describe("a show_person call", () => {
	it("is refused when what it asks is a session-ending act", async () => {
		const verdict = await call("show_person", {
			kind: "page",
			target: "https://example.com",
			title: "The pairing steps",
			why: "The card pairs at the login window.",
			ask: "Log out and pair the card, then say how it went",
		});

		expect(verdict).toMatchObject({ block: true });
	});

	it("is refused for a choice that is one", async () => {
		const verdict = await call("show_person", {
			kind: "page",
			target: "https://example.com",
			title: "The kernel",
			ask: "Say when",
			choices: ["Restart the laptop now", "Tomorrow"],
		});

		expect(verdict).toMatchObject({ block: true });
	});

	it("goes ahead when its why only mentions a reboot that happened", async () => {
		const verdict = await call("show_person", {
			kind: "page",
			target: "https://example.com",
			title: "The mic",
			why: "It stopped after the last reboot.",
			ask: "Nothing, just to see",
		});

		expect(verdict).toBeUndefined();
	});

	it("goes ahead when its title only names a reboot", async () => {
		const verdict = await call("show_person", {
			kind: "page",
			target: "https://example.com",
			title: "Why the reboot broke the mic",
			ask: "Nothing, just to see",
		});

		expect(verdict).toBeUndefined();
	});
});

describe("another tool's call", () => {
	it("goes as it was, whatever it says", async () => {
		expect(
			await call("bash", { command: "echo please reboot" }),
		).toBeUndefined();
		expect(asked).toBe(0);
	});
});

describe("a reply", () => {
	it("is withheld while others are live where it asks, and the model is told why", async () => {
		const call = { type: "toolCall", id: "t1", name: "read", arguments: {} };
		const answer = await reply(
			text("Done with the guard."),
			text("Please log out of macOS on equilibrius now."),
			call,
		);

		const message = (answer as { message: { content: object[] } }).message;
		expect(message.content).toEqual([
			{ type: "text", text: expect.stringContaining("(Withheld:") },
			call,
		]);
		const [note] = pi.recorded.sent;
		expect(JSON.stringify(note)).toContain("EWUL44 (idle)");
	});

	it("tells the model once a run, however many replies are withheld in it", async () => {
		await reply(text("Please reboot equilibrius."));
		const again = await reply(text("Then reboot equilibrius, please."));
		expect(pi.recorded.sent).toHaveLength(1);
		expect(JSON.stringify(again)).toContain("(Withheld:");
		expect(JSON.stringify(again)).not.toContain("The reason follows");

		await settle();
		await reply(text("Reboot equilibrius now."));
		expect(pi.recorded.sent).toHaveLength(2);
	});

	it("tells the model as a follow-up that doesn't start a run of its own", async () => {
		await reply(text("Please reboot equilibrius."));

		expect(sentWith).toEqual([{ deliverAs: "followUp" }]);
	});

	it.each(["aborted", "error"])(
		"is withheld without a word to the model when it ended %s",
		async (stopReason) => {
			const answer = await replyStopping(
				stopReason,
				text("Please reboot equilibrius."),
			);

			expect(JSON.stringify(answer)).toContain("(Withheld:");
			expect(JSON.stringify(answer)).not.toContain("The reason follows");
			expect(pi.recorded.sent).toEqual([]);
		},
	);

	it("goes through, when the guard redirects, once the ask is said again after a session's state moved", async () => {
		setSessionMode(GUARD, "redirect");
		expect(await reply(text("Please reboot equilibrius."))).toBeDefined();
		const said = JSON.stringify(pi.recorded.sent);
		expect(said).toContain("ask it again");
		expect(said).not.toContain("make the same call again");

		node = someoneOn("equilibrius", "busy");

		expect(
			await reply(text("As I said: please reboot equilibrius.")),
		).toBeUndefined();
	});

	it("keeps no override, when the guard redirects, for a reply withheld without a word to the model", async () => {
		setSessionMode(GUARD, "redirect");
		await replyStopping("aborted", text("Please reboot equilibrius."));

		expect(await reply(text("Please reboot equilibrius."))).toBeDefined();
	});

	it("keeps no override, when the guard redirects, for a second ask withheld silently in a run", async () => {
		setSessionMode(GUARD, "redirect");
		await reply(text("Please reboot equilibrius."));
		await reply(text("Please log out of macOS on equilibrius."));

		expect(
			await reply(text("Please log out of macOS on equilibrius.")),
		).toBeDefined();
	});

	it("keeps no override, when the guard redirects, across a reload of the extension", async () => {
		setSessionMode(GUARD, "redirect");
		await reply(text("Please reboot equilibrius."));
		pi = fakePi();
		sessionEndingInterceptor({
			onMesh: () => true,
			sessions: async () => node,
			machines: async () => undefined,
			here: () => "optimus",
		})(pi);

		expect(await reply(text("Please reboot equilibrius."))).toBeDefined();
	});

	it("keeps an override, when the guard redirects, only for the run it was told in", async () => {
		setSessionMode(GUARD, "redirect");
		await reply(text("Please reboot equilibrius."));
		await settle();

		expect(await reply(text("Please reboot equilibrius."))).toBeDefined();
		expect(pi.recorded.sent).toHaveLength(2);
	});

	it("is withheld when the node can't be read", async () => {
		node = undefined;
		const answer = await reply(text("Reboot optimus when you can."));

		expect(answer).toBeDefined();
		expect(JSON.stringify(pi.recorded.sent)).toContain("couldn't be read");
	});

	it("goes as it was when it asks nothing", async () => {
		expect(
			await reply(text("A log-out on equilibrius ended five sessions.")),
		).toBeUndefined();
		expect(pi.recorded.sent).toEqual([]);
	});

	it("goes as it was when the guard is off, said to the person", async () => {
		setSessionMode(GUARD, "off");

		expect(
			await reply(text("Please log out of macOS on equilibrius.")),
		).toBeUndefined();
	});

	it("says in its place that the reason follows, when it does", async () => {
		const answer = await reply(text("Please reboot equilibrius."));

		expect(JSON.stringify(answer)).toContain("The reason follows");
	});

	it("leaves the person's and the tools' messages alone", async () => {
		const answer = await handler("message_end")(
			{
				type: "message_end",
				message: { role: "user", content: [text("Please reboot optimus.")] },
			},
			ctx,
		);

		expect(answer).toBeUndefined();
	});
});

describe("the node the interceptor reads by default", () => {
	const empty = () => mkdtempSync(join(tmpdir(), "session-ending-"));

	it("is on the mesh where a realm is named, though no runtime folder says where its socket is", async () => {
		const state = empty();
		try {
			const deps = nodeDeps({
				MYCELIUM_REALM: "work",
				XDG_STATE_HOME: state,
				XDG_RUNTIME_DIR: join(state, "run"),
			});

			expect(deps.onMesh()).toBe(true);
			expect(await deps.sessions()).toBeUndefined();
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});

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
			expect(await nodeDeps(env).sessions()).toBeUndefined();
		} finally {
			for (const server of servers) server.close();
			rmSync(state, { recursive: true, force: true });
		}
	});

	it("is off the mesh where no realm is named", () => {
		const state = empty();
		try {
			expect(nodeDeps({ XDG_STATE_HOME: state }).onMesh()).toBe(false);
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});
});
