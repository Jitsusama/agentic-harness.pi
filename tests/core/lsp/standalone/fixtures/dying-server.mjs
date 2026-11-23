/**
 * A language server that dies the first time it is asked anything.
 *
 * Each start appends a line to the file named by its first argument.
 * The first process to start exits on its first hover, the way a real
 * server crashes mid-session; any process started after it answers. So
 * a test can tell a backend that started a fresh server from one that
 * kept asking the dead one.
 *
 * It writes the processId its initialize named beside the log, as
 * `<log>.pid`. With FAKE_INIT_ERROR set it says so on its error output
 * and answers initialize with that error instead; with FAKE_INIT_EXIT
 * set it says that and exits instead, as a server that crashes as it
 * starts. A rename answers with an edit to the file FAKE_RENAME_PATH
 * names when it is set, first, and to the one renamed. Each change a
 * document is told of is written beside the log, as `<log>.changed`.
 */

import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import {
	createMessageConnection,
	ResponseError,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-languageserver-protocol/node";

const log = process.argv[2];
if (!log) throw new Error("usage: dying-server.mjs <log file>");
const earlier = existsSync(log)
	? readFileSync(log, "utf8").split("\n").filter(Boolean).length
	: 0;
appendFileSync(log, "start\n");

const connection = createMessageConnection(
	new StreamMessageReader(process.stdin),
	new StreamMessageWriter(process.stdout),
);

connection.onRequest("initialize", (params) => {
	writeFileSync(`${log}.pid`, JSON.stringify(params.processId));
	const crashing = process.env.FAKE_INIT_EXIT;
	if (crashing) {
		process.stderr.write(`${crashing}\n`, () => process.exit(1));
		return new Promise(() => {});
	}
	const failing = process.env.FAKE_INIT_ERROR;
	if (failing) {
		process.stderr.write("indexing the project\n");
		return new ResponseError(-32603, failing);
	}
	return { capabilities: { hoverProvider: true, renameProvider: true } };
});

connection.onRequest("textDocument/rename", (params) => {
	const also = process.env.FAKE_RENAME_PATH;
	const start = { line: 0, character: 0 };
	const edit = [{ range: { start, end: start }, newText: "renamed " }];
	return {
		changes: {
			...(also ? { [pathToFileURL(also).href]: edit } : {}),
			[params.textDocument.uri]: edit,
		},
	};
});

connection.onNotification("textDocument/didChange", (params) => {
	appendFileSync(`${log}.changed`, params.contentChanges[0]?.text ?? "");
});

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
