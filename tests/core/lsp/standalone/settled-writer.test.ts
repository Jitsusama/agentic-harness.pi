/** A language server's connection whose pipe has gone, written to anyway. */
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { settledWriter } from "../../../../lib/core/lsp/standalone/settled-writer.ts";

/** Long enough for a failed write and anything it leaves loose to land. */
const SETTLE_MS = 200;

let loose: unknown[];
const hear = (reason: unknown) => {
	loose.push(reason);
};
let connection: MessageConnection | undefined;

beforeEach(() => {
	loose = [];
	process.on("unhandledRejection", hear);
});

afterEach(() => {
	process.off("unhandledRejection", hear);
	connection?.dispose();
	connection = undefined;
});

/** A connection over a pipe destroyed before anything is written. */
function overDeadPipe(): MessageConnection {
	const toServer = new PassThrough();
	toServer.on("error", () => {});
	toServer.destroy();
	const made: MessageConnection = createMessageConnection(
		new StreamMessageReader(new PassThrough()),
		settledWriter(new StreamMessageWriter(toServer), () => made.dispose()),
	);
	made.onError(() => {});
	made.listen();
	return made;
}

it("fails a request it can't send, leaving nothing loose", async () => {
	connection = overDeadPipe();

	const asked = connection.sendRequest("textDocument/hover", {});

	await expect(asked, "the caller hears its call failed").rejects.toThrow();
	// A real pause: what's checked is that nothing goes loose, and no
	// event marks a rejection that never comes.
	await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
	expect(
		loose.map((reason) => String(reason)),
		"no rejection left for the process to die of",
	).toEqual([]);
});

it("lets a notification it can't send go quietly", async () => {
	connection = overDeadPipe();

	await connection.sendNotification("textDocument/didChange", {});

	// A real pause: what's checked is that nothing goes loose, and no
	// event marks a rejection that never comes.
	await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
	expect(
		loose.map((reason) => String(reason)),
		"no rejection left for the process to die of",
	).toEqual([]);
});
