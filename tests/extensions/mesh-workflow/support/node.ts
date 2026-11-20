/**
 * A mycelium node for a test session to reach: it lists the cells and
 * ties a test gives it and holds no hubs, on the socket the realm
 * `work` is found by under the fixture's runtime folder.
 */

import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fixture } from "./mesh.ts";

let servers: Server[] = [];

/**
 * A node listing these cells and ties, and the environment a session
 * reaches it by. Close it with `closeNodes` after the test.
 */
export async function node(
	cells: object[],
	ties: object[],
): Promise<NodeJS.ProcessEnv> {
	const runtime = join(fixture.root, "run");
	mkdirSync(join(runtime, "mycelium"), { recursive: true });
	const server = createServer((client) => {
		client.setEncoding("utf8");
		let said = "";
		client.on("data", (chunk: string) => {
			said += chunk;
			for (let end = said.indexOf("\n"); end >= 0; end = said.indexOf("\n")) {
				const ask = JSON.parse(said.slice(0, end));
				said = said.slice(end + 1);
				const records =
					ask.kind === "cell" ? cells : ask.kind === "tie" ? ties : undefined;
				const reply =
					ask.ask === "list" && records
						? { id: ask.id, records }
						: { id: ask.id, error: { code: "unknown-kind" } };
				client.write(`${JSON.stringify(reply)}\n`);
			}
		});
	});
	servers.push(server);
	await new Promise<void>((listening) =>
		server.listen(join(runtime, "mycelium", "work.sock"), listening),
	);
	return { MYCELIUM_REALM: "work", XDG_RUNTIME_DIR: runtime };
}

/** Close every node a test started. */
export async function closeNodes(): Promise<void> {
	await Promise.all(
		servers.map((server) => new Promise((done) => server.close(done))),
	);
	servers = [];
}
