/**
 * One language server, spawned and supervised over stdio.
 *
 * Owns the JSON-RPC connection, the initialize handshake, the
 * open-document set and the latest diagnostics each document
 * published. Positions cross the boundary here: the tool's
 * byte columns convert to LSP's UTF-16 columns on the way in
 * and back on the way out.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
	type ClientCapabilities,
	DefinitionRequest,
	DidChangeTextDocumentNotification,
	DidOpenTextDocumentNotification,
	InitializedNotification,
	InitializeRequest,
	type Location,
	type LocationLink,
	PublishDiagnosticsNotification,
	ReferencesRequest,
} from "vscode-languageserver-protocol";
import type { ServerConfig } from "../config.js";
import type {
	Diagnostic,
	DiagnosticSeverity,
	LspLocation,
	LspTarget,
} from "../types.js";
import {
	fileToUri,
	fromProtocolRange,
	languageIdFor,
	toLines,
	toProtocolPosition,
	uriToFile,
} from "./document.js";

/**
 * Client capabilities advertised at initialize. A server
 * that respects capabilities pushes diagnostics only when the
 * client declares publishDiagnostics and synchronization, so
 * these are load-bearing, not decorative.
 */
const CLIENT_CAPABILITIES: ClientCapabilities = {
	textDocument: {
		synchronization: { didSave: true, dynamicRegistration: true },
		publishDiagnostics: { relatedInformation: true },
		definition: { linkSupport: true },
		references: {},
		hover: { contentFormat: ["markdown", "plaintext"] },
		documentSymbol: { hierarchicalDocumentSymbolSupport: true },
		rename: { prepareSupport: true },
		codeAction: {},
	},
	workspace: { workspaceEdit: { documentChanges: true } },
};

/** How long a cold initialize may take before we give up. */
const WARMUP_TIMEOUT_MS = 15_000;
/** Quiet window after the last diagnostics publish before we read them. */
const DIAGNOSTICS_SETTLE_MS = 300;
/** Hard cap on waiting for a document's diagnostics. Generous
 * because it also bounds the first request against a cold,
 * large project whose program is still building. */
const DIAGNOSTICS_TIMEOUT_MS = 20_000;

interface ProtocolDiagnostic {
	readonly range: {
		readonly start: { readonly line: number; readonly character: number };
		readonly end: { readonly line: number; readonly character: number };
	};
	readonly severity?: number;
	readonly message: string;
	readonly source?: string;
	readonly code?: string | number;
}

const SEVERITY: Readonly<Record<number, DiagnosticSeverity>> = {
	1: "error",
	2: "warning",
	3: "information",
	4: "hint",
};

/** A live server connection rooted at one project directory. */
export class StandaloneServer {
	private readonly openDocs = new Set<string>();
	private readonly lineCache = new Map<string, string[]>();
	private readonly diagnostics = new Map<string, ProtocolDiagnostic[]>();
	private readonly diagWaiters = new Set<(uri: string) => void>();
	private version = 0;

	private constructor(
		readonly serverName: string,
		readonly root: string,
		private readonly child: ChildProcess,
		private readonly connection: MessageConnection,
	) {}

	/** Spawn a server, run the initialize handshake and return it ready. */
	static async start(
		config: ServerConfig,
		root: string,
		binaryPath: string,
	): Promise<StandaloneServer> {
		const child = spawn(binaryPath, [...config.args], {
			cwd: root,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const { stdout, stdin } = child;
		if (!stdout || !stdin) {
			child.kill();
			throw new Error(`failed to open stdio for ${config.name}`);
		}
		const connection = createMessageConnection(
			new StreamMessageReader(stdout),
			new StreamMessageWriter(stdin),
		);
		const server = new StandaloneServer(config.name, root, child, connection);
		connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
			server.diagnostics.set(
				params.uri,
				params.diagnostics as unknown as ProtocolDiagnostic[],
			);
			for (const waiter of server.diagWaiters) waiter(params.uri);
		});
		connection.listen();
		await withTimeout(
			connection.sendRequest(InitializeRequest.type, {
				processId: process.pid,
				rootUri: fileToUri(root),
				capabilities: CLIENT_CAPABILITIES,
				...(config.initOptions
					? { initializationOptions: config.initOptions }
					: {}),
			}),
			WARMUP_TIMEOUT_MS,
			`initialize ${config.name}`,
		);
		connection.sendNotification(InitializedNotification.type, {});
		return server;
	}

	/** Problems the server reports against the file's current bytes. */
	async diagnose(path: string): Promise<Diagnostic[]> {
		const uri = fileToUri(path);
		this.ensureOpen(path);
		await this.settleDiagnostics(uri);
		const raw = this.diagnostics.get(uri) ?? [];
		const lines = this.linesFor(path);
		return raw.map((d) => this.toDiagnostic(path, lines, d));
	}

	/** Where the symbol under the target is defined. */
	async definition(target: LspTarget): Promise<LspLocation[]> {
		await this.ensureReady(target.path);
		const result = await this.connection.sendRequest(DefinitionRequest.type, {
			textDocument: { uri: fileToUri(target.path) },
			position: toProtocolPosition(this.linesFor(target.path), target.position),
		});
		return this.toLocations(result);
	}

	/** Every reference to the symbol under the target. */
	async references(target: LspTarget): Promise<LspLocation[]> {
		await this.ensureReady(target.path);
		const result = await this.connection.sendRequest(ReferencesRequest.type, {
			textDocument: { uri: fileToUri(target.path) },
			position: toProtocolPosition(this.linesFor(target.path), target.position),
			context: { includeDeclaration: true },
		});
		return this.toLocations(result);
	}

	/** Re-sync a document after pi edited it, so diagnostics stay current. */
	syncDocument(path: string, text: string): void {
		const uri = fileToUri(path);
		if (!this.openDocs.has(uri)) {
			this.ensureOpen(path);
			return;
		}
		this.lineCache.set(uri, toLines(text));
		this.version += 1;
		this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
			textDocument: { uri, version: this.version },
			contentChanges: [{ text }],
		});
	}

	/** Release the connection and kill the server process. */
	async dispose(): Promise<void> {
		try {
			this.connection.dispose();
		} catch {
			// The connection may already be torn down; nothing to do.
		}
		this.child.kill();
	}

	/**
	 * Open the target and wait for the server to finish building
	 * the project's program before a type-intelligence request.
	 * tsserver answers references and definition only across files
	 * in the loaded program, and it publishes a file's diagnostics
	 * once that program is built, so the first publish is a
	 * deterministic readiness signal. Cached per file so warm
	 * requests skip the wait.
	 */
	private async ensureReady(path: string): Promise<void> {
		const uri = fileToUri(path);
		const alreadyOpen = this.openDocs.has(uri);
		this.ensureOpen(path);
		if (alreadyOpen) return;
		await this.settleDiagnostics(uri);
	}

	private ensureOpen(path: string): void {
		const uri = fileToUri(path);
		if (this.openDocs.has(uri)) return;
		const text = readFileSync(path, "utf8");
		this.lineCache.set(uri, toLines(text));
		this.version += 1;
		this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
			textDocument: {
				uri,
				languageId: languageIdFor(path),
				version: this.version,
				text,
			},
		});
		this.openDocs.add(uri);
	}

	private linesFor(path: string): string[] {
		const uri = fileToUri(path);
		const cached = this.lineCache.get(uri);
		if (cached) return cached;
		const lines = toLines(readFileSync(path, "utf8"));
		this.lineCache.set(uri, lines);
		return lines;
	}

	private settleDiagnostics(uri: string): Promise<void> {
		return new Promise((resolve) => {
			let settleTimer: ReturnType<typeof setTimeout>;
			let done = false;
			const finish = (): void => {
				if (done) return;
				done = true;
				clearTimeout(settleTimer);
				clearTimeout(hardTimer);
				this.diagWaiters.delete(onPublish);
				resolve();
			};
			const arm = (): void => {
				clearTimeout(settleTimer);
				settleTimer = setTimeout(finish, DIAGNOSTICS_SETTLE_MS);
			};
			const onPublish = (published: string): void => {
				if (published === uri) arm();
			};
			const hardTimer = setTimeout(finish, DIAGNOSTICS_TIMEOUT_MS);
			this.diagWaiters.add(onPublish);
			// Only start the quiet-window countdown once at least one
			// publish has landed. Arming before the first publish would
			// return empty for any server slower than the settle window;
			// the hard timeout still bounds a server that never speaks.
			if (this.diagnostics.has(uri)) arm();
		});
	}

	private toDiagnostic(
		path: string,
		lines: readonly string[],
		d: ProtocolDiagnostic,
	): Diagnostic {
		return {
			path,
			range: fromProtocolRange(lines, d.range),
			severity: SEVERITY[d.severity ?? 1] ?? "error",
			message: d.message,
			...(d.source ? { source: d.source } : {}),
			...(d.code !== undefined ? { code: String(d.code) } : {}),
		};
	}

	private toLocations(
		result: Location | Location[] | LocationLink[] | null,
	): LspLocation[] {
		if (!result) return [];
		const array = Array.isArray(result) ? result : [result];
		return array.map((item) => {
			if ("targetUri" in item) {
				const path = uriToFile(item.targetUri);
				return {
					path,
					range: fromProtocolRange(this.linesFor(path), item.targetRange),
				};
			}
			const path = uriToFile(item.uri);
			return {
				path,
				range: fromProtocolRange(this.linesFor(path), item.range),
			};
		});
	}
}

function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label} timed out after ${ms}ms`)),
			ms,
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}
