/**
 * A language server that dies the first time it is asked anything.
 *
 * Each start appends a line to the file named by its first argument.
 * The first process to start exits on its first hover, the way a real
 * server crashes mid-session; any process started after it answers. So
 * a test can tell a backend that started a fresh server from one that
 * kept asking the dead one.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-languageserver-protocol/node";

const log = process.argv[2];
const earlier = existsSync(log)
	? readFileSync(log, "utf8").split("\n").filter(Boolean).length
	: 0;
appendFileSync(log, "start\n");

const connection = createMessageConnection(
	new StreamMessageReader(process.stdin),
	new StreamMessageWriter(process.stdout),
);

connection.onRequest("initialize", () => ({
	capabilities: { hoverProvider: true },
}));

connection.onNotification("textDocument/didOpen", (params) => {
	connection.sendNotification("textDocument/publishDiagnostics", {
		uri: params.textDocument.uri,
		diagnostics: [],
	});
});

connection.onRequest("textDocument/hover", () => {
	if (earlier === 0) process.exit(1);
	return { contents: { kind: "plaintext", value: "alive" } };
});

connection.listen();
