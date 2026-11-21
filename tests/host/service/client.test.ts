import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { controlRequest } from "../../../host/service/client.ts";
import {
	type ControlBackend,
	dispatchControl,
} from "../../../host/service/dispatch.ts";

let folder: string;
let server: Server | undefined;

beforeEach(async () => {
	folder = await mkdtemp(join(tmpdir(), "host-client-"));
});

afterEach(async () => {
	const listening = server;
	server = undefined;
	if (listening) await new Promise((closed) => listening.close(closed));
	await rm(folder, { recursive: true, force: true });
});

/** A backend nothing reaches, since dispatch refuses before it is asked. */
const untouched: ControlBackend = {
	identity: { key: "older", owner: { pid: process.pid, startedAt: 1 } },
	async execute() {
		throw new Error("an unreadable request reached the backend");
	},
};

/** A host answering each line with what `answer` makes of it. */
async function hostAnswering(
	answer: (line: string) => Promise<unknown>,
): Promise<string> {
	const socket = join(folder, "host.sock");
	server = createServer((client) => {
		client.setEncoding("utf8");
		client.on("data", async (line: string) => {
			client.write(`${JSON.stringify(await answer(line.trim()))}\n`);
		});
	});
	const listening = server;
	await new Promise<void>((done) => listening.listen(socket, done));
	return socket;
}

/** A list request, which needs no host identity. */
function listing(): { v: 1; id: string; op: "list" } {
	return { v: 1, id: randomUUID(), op: "list" };
}

describe("a control request's answer", () => {
	it("takes the refusal a host gives a request it can't read, which names no id", async () => {
		// An older host's parser refuses a field this client's knows, as one
		// from before a carried variable refuses that variable.
		const socket = await hostAnswering((line) =>
			dispatchControl({ ...JSON.parse(line), since: "later" }, untouched),
		);

		const reply = await controlRequest(socket, listing());

		expect(reply, "the host's own refusal comes back").toMatchObject({
			id: null,
			ok: false,
			error: { code: "invalid_request" },
		});
	});

	it("refuses an error answering another request's id", async () => {
		const socket = await hostAnswering(async () => ({
			v: 1,
			id: randomUUID(),
			ok: false,
			error: { code: "invalid_request", message: "not this one" },
		}));

		await expect(
			controlRequest(socket, listing()),
			"another request's answer is refused",
		).rejects.toThrow("Host reply id does not match request");
	});

	it("refuses a success that names no id", async () => {
		const socket = await hostAnswering(async () => ({
			v: 1,
			id: null,
			ok: true,
			result: {},
		}));

		await expect(
			controlRequest(socket, listing()),
			"a success always names what it answers",
		).rejects.toThrow();
	});
});
