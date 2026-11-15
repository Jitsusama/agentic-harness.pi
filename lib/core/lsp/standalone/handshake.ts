/**
 * What the client tells a language server it can do, and how it answers
 * the requests a server sends back.
 *
 * Apart from the server because these change when a server expects
 * something new of its client, which is learned one server at a time,
 * while the server changes when how it supervises the process does.
 */

import { basename } from "node:path";
import type { MessageConnection } from "vscode-jsonrpc/node";
import {
	type ClientCapabilities,
	ConfigurationRequest,
	RegistrationRequest,
	UnregistrationRequest,
	WorkDoneProgressCreateRequest,
	WorkspaceFoldersRequest,
} from "vscode-languageserver-protocol";
import { fileToUri } from "./document.ts";

/**
 * Client capabilities advertised at initialize. A server may
 * report diagnostics two ways: TypeScript 7's native LSP answers
 * them on demand (pull), while tsserver-based and many other
 * servers push them after a document opens. We advertise both so
 * the backend stays general, and it picks the mode per server
 * from the initialize response. The native server also drives
 * the client with dynamic registration and workspace queries, so
 * the configuration, workspaceFolders and workDoneProgress
 * capabilities are load-bearing, not decorative.
 */
export const CLIENT_CAPABILITIES: ClientCapabilities = {
	textDocument: {
		synchronization: { didSave: true, dynamicRegistration: true },
		diagnostic: { dynamicRegistration: true },
		publishDiagnostics: { relatedInformation: true },
		definition: { linkSupport: true },
		references: {},
		hover: { contentFormat: ["markdown", "plaintext"] },
		documentSymbol: { hierarchicalDocumentSymbolSupport: true },
		rename: { prepareSupport: true },
		codeAction: {},
	},
	workspace: {
		workspaceEdit: { documentChanges: true },
		configuration: true,
		workspaceFolders: true,
		didChangeConfiguration: { dynamicRegistration: true },
	},
	window: { workDoneProgress: true },
};

/**
 * Answer what a server asks of its client, with `root` as the one
 * workspace folder.
 *
 * TypeScript 7's native LSP drives the client with dynamic
 * capability registration and workspace queries, and stalls until
 * they are answered. Accept registration as a no-op, answer
 * configuration with defaults, grant progress tokens, and report
 * the resolved project root as the one workspace folder.
 */
export function answerClientRequests(
	connection: MessageConnection,
	root: string,
): void {
	connection.onRequest(RegistrationRequest.type, () => undefined);
	connection.onRequest(UnregistrationRequest.type, () => undefined);
	connection.onRequest(ConfigurationRequest.type, (params) =>
		params.items.map(() => ({})),
	);
	connection.onRequest(WorkDoneProgressCreateRequest.type, () => undefined);
	connection.onRequest(WorkspaceFoldersRequest.type, () => [
		{ uri: fileToUri(root), name: basename(root) },
	]);
}
