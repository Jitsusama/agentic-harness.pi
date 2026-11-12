import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { askVerbs } from "../../../../lib/internal/verbs/client.ts";
import {
	listenForVerbs,
	type VerbServer,
	verbServer,
} from "../../../../lib/internal/verbs/serve.ts";

describe("a client of the verbs server", () => {
	let root = "";
	let server: VerbServer | undefined;

	afterEach(async () => {
		await server?.stop();
		rmSync(root, { recursive: true, force: true });
	});

	async function serving(): Promise<string> {
		root = mkdtempSync(join(tmpdir(), "verbs-"));
		const folder = join(root, "verbs");
		mkdirSync(folder);
		writeFileSync(
			join(folder, "explain.md"),
			"---\nwords: Explain\nresult: say\n---\nExplain.\n",
		);
		server = verbServer({
			folders: [folder],
			uses: join(root, "uses.jsonl"),
			known: [],
		});
		const socket = join(root, "daemons", "pi-verbs.sock");
		await listenForVerbs(server.server, socket, false);
		return socket;
	}

	it("asks one line and gives back its answer", async () => {
		const socket = await serving();
		expect(
			await askVerbs(socket, { ask: "verb", verb: "explain", selection: "x" }),
		).toMatchObject({
			ok: true,
			system: "Explain.",
			prompt: "x",
		});
	});

	it("listens on a socket only the login can reach, in a folder made for it", async () => {
		const socket = await serving();
		expect(statSync(join(root, "daemons")).mode & 0o777).toBe(0o700);
		expect(statSync(socket).mode & 0o777).toBe(0o600);
	});

	it("takes the place of a socket a stopped server left behind", async () => {
		const socket = await serving();
		await server?.stop();
		writeFileSync(socket, "left behind");
		server = verbServer({
			folders: [],
			uses: join(root, "uses.jsonl"),
			known: [],
		});
		await listenForVerbs(server.server, socket, false);
		expect(await askVerbs(socket, { ask: "watch" })).toEqual({
			id: 1,
			changed: [],
		});
	});

	it("says when nothing is listening", async () => {
		root = mkdtempSync(join(tmpdir(), "verbs-"));
		await expect(
			askVerbs(join(root, "none.sock"), { ask: "watch" }),
		).rejects.toThrow(/the verbs server isn't running/);
	});
});
