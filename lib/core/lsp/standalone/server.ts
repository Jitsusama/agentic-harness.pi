/**
 * One language server, spawned and supervised over stdio.
 *
 * Owns the JSON-RPC connection, the initialize handshake and
 * the open-document set, and pulls diagnostics on demand.
 * Positions cross the boundary here: the tool's
 * byte columns convert to LSP's UTF-16 columns on the way in
 * and back on the way out.
 *
 * What the client advertises and answers the server is in
 * `handshake.ts`, and what a server's answers mean in the tool's
 * terms in `answers.ts`.
 */

import { spawn } from "node:child_process";
import { basename } from "node:path";
import {
	type CancellationToken,
	CancellationTokenSource,
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
	CodeActionRequest,
	DefinitionRequest,
	DidChangeTextDocumentNotification,
	DidOpenTextDocumentNotification,
	DocumentDiagnosticReportKind,
	DocumentDiagnosticRequest,
	DocumentSymbolRequest,
	HoverRequest,
	InitializedNotification,
	InitializeRequest,
	type WorkspaceEdit as ProtocolWorkspaceEdit,
	PublishDiagnosticsNotification,
	ReferencesRequest,
	RenameRequest,
	WorkspaceSymbolRequest,
} from "vscode-languageserver-protocol";
import { systemProgram } from "../../../internal/sandbox/system-program.ts";
import type { ServerConfig } from "../config.ts";
import type {
	CodeAction,
	Diagnostic,
	HoverInfo,
	LspFence,
	LspLocation,
	LspRange,
	LspTarget,
	SymbolInfo,
	WorkspaceEdit,
} from "../types.ts";
import {
	flattenDocumentSymbol,
	fromSymbols,
	hoverText,
	type ProtocolDiagnostic,
	toDiagnostic,
	toLocations,
} from "./answers.ts";
import {
	fileToUri,
	fromProtocolRange,
	languageIdFor,
	toLines,
	toProtocolPosition,
} from "./document.ts";
import {
	END_GRACE_MS,
	exitOf,
	FENCE_REFUSED,
	groupEnder,
	lastSaid,
} from "./fenced-process.ts";
import { answerClientRequests, CLIENT_CAPABILITIES } from "./handshake.ts";
import { type Refuses, readJudged } from "./judged-files.ts";
import { settledWriter } from "./settled-writer.ts";
import { applyWorkspaceEdit } from "./workspace-edit.ts";

/** How long a cold initialize may take before we give up. */
const WARMUP_TIMEOUT_MS = 15_000;
/** Quiet window after the last diagnostics publish before we read them. */
const DIAGNOSTICS_SETTLE_MS = 300;
/** Hard cap on waiting for a document's diagnostics. Generous
 * because it also bounds the first request against a cold,
 * large project whose program is still building. */
const DIAGNOSTICS_TIMEOUT_MS = 20_000;

/** A live server connection rooted at one project directory. */
export class StandaloneServer {
	private readonly openDocs = new Set<string>();
	private readonly lineCache = new Map<string, string[]>();
	private readonly diagnostics = new Map<string, ProtocolDiagnostic[]>();
	private readonly diagWaiters = new Set<(uri: string) => void>();
	// Whether the server answers pull diagnostics (textDocument/diagnostic).
	// Set from the initialize response; false means it pushes instead.
	// biome-ignore lint/style/useReadonlyClassProperties: start() sets it on the instance it builds, which Biome doesn't follow.
	private pullSupported = false;
	private version = 0;
	private gone = false;
	private readonly goneListeners = new Set<() => void>();

	readonly serverName: string;
	readonly root: string;
	private readonly end: () => void;
	private readonly connection: MessageConnection;
	private readonly fence: LspFence | undefined;

	private constructor(
		serverName: string,
		root: string,
		end: () => void,
		connection: MessageConnection,
		fence: LspFence | undefined,
	) {
		this.serverName = serverName;
		this.root = root;
		this.end = end;
		this.connection = connection;
		this.fence = fence;
	}

	/**
	 * Spawn a server, run the initialize handshake and return it ready.
	 * Under a fence the server runs inside it, as the fence launches it,
	 * and one the fence refuses never starts. A fenced server ends with
	 * its whole process group, told first and killed `graceMs` later.
	 * The bash that runs the fence's text runs outside it, so it is the
	 * system's own, from `bash`, never one found on the session's PATH.
	 */
	static async start(
		config: ServerConfig,
		root: string,
		binaryPath: string,
		fence?: LspFence,
		graceMs: number = END_GRACE_MS,
		bash: () => string | undefined = () => systemProgram("bash"),
	): Promise<StandaloneServer> {
		const words = [binaryPath, ...config.args];
		const fenced = await fence?.launch(words);
		if (fenced && "refused" in fenced) {
			throw new Error(`${config.name} won't start: ${fenced.refused}`);
		}
		const shell = fenced ? bash() : undefined;
		if (fenced && !shell)
			throw new Error(
				`${config.name} won't start: no bash lies where only the system's administrator can put one, to run its fence`,
			);
		// The fence's text is bash's, and runs in a process group of its
		// own: strict's landrun doesn't die with the shell that started it,
		// so the whole group is ended with the server. The fourth pipe is
		// held for the server's life, so the text can tell once pi is gone.
		const child =
			fenced && shell
				? spawn(shell, ["-c", fenced.text], {
						cwd: root,
						env: fenced.env,
						stdio: ["pipe", "pipe", "pipe", "pipe"],
						detached: true,
					})
				: spawn(binaryPath, [...config.args], {
						cwd: root,
						stdio: ["pipe", "pipe", "pipe"],
					});
		// Its far end closes as the group ends.
		child.stdio[3]?.on("error", () => {});
		const end = fenced
			? groupEnder(child, graceMs)
			: () => {
					child.kill();
				};
		const said = fenced ? lastSaid(child) : undefined;
		const exited = exitOf(child);
		// A spawn that fails says so here, and nowhere else would catch it.
		let failed: Error | undefined;
		child.once("error", (error) => {
			failed = error;
			started?.markGone();
		});
		const { stdout, stdin } = child;
		if (!stdout || !stdin) {
			end();
			throw new Error(`failed to open stdio for ${config.name}`);
		}
		// Killing the server mid-write (on dispose) makes the jsonrpc
		// writer hit EPIPE on a destroyed stream. That is expected at
		// teardown, so swallow it here rather than let it surface as an
		// unhandled stream error.
		stdin.on("error", () => {});
		stdout.on("error", () => {});
		// A write that fails means the server can hear nothing more, and
		// says so by ending it, rather than by a rejection nothing catches.
		let started: StandaloneServer | undefined;
		const connection = createMessageConnection(
			new StreamMessageReader(stdout),
			settledWriter(new StreamMessageWriter(stdin), () => started?.markGone()),
		);
		const server: StandaloneServer = new StandaloneServer(
			config.name,
			root,
			end,
			connection,
			fence,
		);
		started = server;
		// Swallow transport errors (a write after the child is killed);
		// they are expected during dispose and must not go unhandled.
		connection.onError(() => {});
		// Whichever comes first says the server can answer nothing more.
		child.once("exit", () => server.markGone());
		connection.onClose(() => server.markGone());
		// A push-style server publishes a file's diagnostics after it
		// opens; capture them so a pull-incapable server still reports.
		connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
			server.diagnostics.set(
				params.uri,
				params.diagnostics as unknown as ProtocolDiagnostic[],
			);
			for (const waiter of server.diagWaiters) waiter(params.uri);
		});
		answerClientRequests(connection, root);
		connection.listen();
		const initResult = await withTimeout(
			connection.sendRequest(InitializeRequest.type, {
				// A fenced server may not see pi's pid, in a namespace of its
				// own or kept from signalling out, and would take pi for gone.
				processId: fenced ? null : process.pid,
				rootUri: fileToUri(root),
				workspaceFolders: [{ uri: fileToUri(root), name: basename(root) }],
				capabilities: CLIENT_CAPABILITIES,
				...(config.initOptions
					? { initializationOptions: config.initOptions }
					: {}),
			}),
			WARMUP_TIMEOUT_MS,
			`initialize ${config.name}`,
		).catch(async (error: unknown) => {
			// A fenced server that exits says why on its error output, which
			// can come after the request has failed: by the status it exits
			// with, the fence's own refusal or a program bash can't run, which
			// share it, and anything else as the server's. One
			// still running when its output settles failed for its own
			// reason, which stands.
			const why = (await said?.())?.trim();
			const ended = why ? await exited() : undefined;
			end();
			if (failed)
				throw new Error(`${config.name} didn't start: ${failed.message}`, {
					cause: failed,
				});
			if (!why || !ended) throw error;
			throw new Error(
				ended.code === FENCE_REFUSED
					? `${config.name} couldn't run in the fence: ${why}`
					: `${config.name} exited as it started: ${why}`,
				{ cause: error },
			);
		});
		// Prefer pull diagnostics when the server advertises them, and
		// fall back to the pushed stream otherwise.
		server.pullSupported = Boolean(
			initResult?.capabilities?.diagnosticProvider,
		);
		connection
			.sendNotification(InitializedNotification.type, {})
			// Nothing answers a notification; a server gone before it hears
			// this fails the first request sent to it, which reports it.
			.catch(() => {});
		return server;
	}

	/** Problems the server reports against the file's current bytes. */
	async diagnose(path: string, signal?: AbortSignal): Promise<Diagnostic[]> {
		this.ensureOpen(path);
		const raw = this.pullSupported
			? await this.pullDiagnostics(path, signal)
			: await this.pushedDiagnostics(path);
		const lines = this.linesFor(path);
		return raw.map((d) => toDiagnostic(path, lines, d));
	}

	/** Where the symbol under the target is defined. */
	async definition(
		target: LspTarget,
		signal?: AbortSignal,
	): Promise<LspLocation[]> {
		await this.ensureReady(target.path, signal);
		const result = await this.cancellable(signal, (token) =>
			this.connection.sendRequest(
				DefinitionRequest.type,
				{
					textDocument: { uri: fileToUri(target.path) },
					position: toProtocolPosition(
						this.linesFor(target.path),
						target.position,
					),
				},
				token,
			),
		);
		return toLocations(result, (file) => this.linesFor(file));
	}

	/** Every reference to the symbol under the target. */
	async references(
		target: LspTarget,
		signal?: AbortSignal,
	): Promise<LspLocation[]> {
		await this.ensureReady(target.path, signal);
		const result = await this.cancellable(signal, (token) =>
			this.connection.sendRequest(
				ReferencesRequest.type,
				{
					textDocument: { uri: fileToUri(target.path) },
					position: toProtocolPosition(
						this.linesFor(target.path),
						target.position,
					),
					context: { includeDeclaration: true },
				},
				token,
			),
		);
		return toLocations(result, (file) => this.linesFor(file));
	}

	/** Documentation for the symbol under the target, or null. */
	async hover(
		target: LspTarget,
		signal?: AbortSignal,
	): Promise<HoverInfo | null> {
		await this.ensureReady(target.path, signal);
		const result = await this.cancellable(signal, (token) =>
			this.connection.sendRequest(
				HoverRequest.type,
				{
					textDocument: { uri: fileToUri(target.path) },
					position: toProtocolPosition(
						this.linesFor(target.path),
						target.position,
					),
				},
				token,
			),
		);
		if (!result) return null;
		const contents = hoverText(result.contents);
		if (!contents) return null;
		return result.range
			? {
					contents,
					range: fromProtocolRange(this.linesFor(target.path), result.range),
				}
			: { contents };
	}

	/** Symbols declared in one file. */
	async documentSymbols(
		path: string,
		signal?: AbortSignal,
	): Promise<SymbolInfo[]> {
		await this.ensureReady(path, signal);
		const result = await this.cancellable(signal, (token) =>
			this.connection.sendRequest(
				DocumentSymbolRequest.type,
				{ textDocument: { uri: fileToUri(path) } },
				token,
			),
		);
		if (!result) return [];
		const lines = this.linesFor(path);
		return result.flatMap((item) =>
			"location" in item
				? fromSymbols([item], (file) => this.linesFor(file))
				: flattenDocumentSymbol(path, lines, item),
		);
	}

	/** Symbols across the project matching a query. */
	async workspaceSymbols(
		query: string,
		signal?: AbortSignal,
	): Promise<SymbolInfo[]> {
		const result = await this.cancellable(signal, (token) =>
			this.connection.sendRequest(
				WorkspaceSymbolRequest.type,
				{ query },
				token,
			),
		);
		if (!result) return [];
		return fromSymbols(result, (file) => this.linesFor(file));
	}

	/** Rename the symbol under the target and apply the edits. */
	async rename(
		target: LspTarget,
		newName: string,
		signal?: AbortSignal,
	): Promise<WorkspaceEdit> {
		await this.ensureReady(target.path, signal);
		const edit = await this.cancellable(signal, (token) =>
			this.connection.sendRequest(
				RenameRequest.type,
				{
					textDocument: { uri: fileToUri(target.path) },
					position: toProtocolPosition(
						this.linesFor(target.path),
						target.position,
					),
					newName,
				},
				token,
			),
		);
		if (!edit) return { changes: [] };
		return this.applyWorkspaceEdit(edit);
	}

	/** Code actions the server offers for a file, optionally at a range. */
	async codeActions(
		path: string,
		range?: LspRange,
		signal?: AbortSignal,
	): Promise<CodeAction[]> {
		await this.ensureReady(path, signal);
		const lines = this.linesFor(path);
		const protocolRange = range
			? {
					start: toProtocolPosition(lines, range.start),
					end: toProtocolPosition(lines, range.end),
				}
			: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
		const result = await this.cancellable(signal, (token) =>
			this.connection.sendRequest(
				CodeActionRequest.type,
				{
					textDocument: { uri: fileToUri(path) },
					range: protocolRange,
					context: { diagnostics: [] },
				},
				token,
			),
		);
		if (!result) return [];
		return result.map((item) => ({
			title: item.title,
			...("kind" in item && item.kind ? { kind: item.kind } : {}),
		}));
	}

	/** Re-sync a document after the caller edited it, so diagnostics stay current. */
	syncDocument(path: string, text: string): void {
		if (!this.fence) {
			this.tell(path, text);
			return;
		}
		// The caller read its text by path, which the server could have
		// pointed anywhere since, so a fenced server gets only what pi
		// reads here through a descriptor its fence lets it read.
		let judged: string;
		try {
			judged = this.read(path);
		} catch {
			return;
		}
		this.tell(path, judged);
	}

	/** Tells the server a document now holds `text`, which pi vouches for. */
	private tell(path: string, text: string): void {
		const uri = fileToUri(path);
		if (!this.openDocs.has(uri)) {
			this.ensureOpen(path);
			return;
		}
		this.lineCache.set(uri, toLines(text));
		this.version += 1;
		this.notify(() =>
			this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
				textDocument: { uri, version: this.version },
				contentChanges: [{ text }],
			}),
		);
	}

	/**
	 * Tell the server something that wants no answer. A connection that
	 * has closed throws at once rather than rejecting, which from an edit's
	 * sync would escape every caller, and a server that is gone has
	 * nothing to be told.
	 */
	private notify(send: () => Promise<void>): void {
		if (this.gone) return;
		try {
			// A send that rejects is a server gone, with nothing to be told.
			send().catch(() => {});
		} catch {
			// Closed between the check and the send: the server is going, and
			// its exit or close marks it gone.
		}
	}

	/**
	 * Call `listener` once this server can answer nothing more: its
	 * process exited or its connection closed. At once if it already has.
	 */
	onGone(listener: () => void): void {
		if (this.gone) {
			listener();
			return;
		}
		this.goneListeners.add(listener);
	}

	private markGone(): void {
		if (this.gone) return;
		this.gone = true;
		// vscode-jsonrpc rejects the requests still waiting only when its
		// connection is disposed, not when it closes, so a call caught by
		// the death would otherwise wait out its whole timeout.
		try {
			this.connection.dispose();
		} catch {
			// Already torn down; the waiting requests went with it.
		}
		// What it left running ends with it: a fenced server's shell can
		// exit, or its output close, while the rest of its group runs on.
		this.end();
		for (const listener of this.goneListeners) listener();
		this.goneListeners.clear();
	}

	/** Release the connection and kill the server process. */
	async dispose(): Promise<void> {
		try {
			this.connection.dispose();
		} catch {
			// The connection may already be torn down; nothing to do.
		}
		this.end();
	}

	/**
	 * Send one request under a token the caller's signal cancels.
	 *
	 * A cancelled token sends the server `$/cancelRequest`, so a
	 * server busy on a large program stops the work rather than
	 * finishing an answer nobody is waiting for. The caller's wait is
	 * ended above this, by the backend's bound: a server is free to
	 * ignore a cancellation, and many answer late or never.
	 */
	private async cancellable<T>(
		signal: AbortSignal | undefined,
		send: (token: CancellationToken) => Promise<T>,
	): Promise<T> {
		const source = new CancellationTokenSource();
		const cancel = (): void => source.cancel();
		if (signal?.aborted) cancel();
		else signal?.addEventListener("abort", cancel, { once: true });
		try {
			return await send(source.token);
		} finally {
			signal?.removeEventListener("abort", cancel);
			source.dispose();
		}
	}

	/**
	 * Open the target and wait for the server to finish building
	 * the project's program before a type-intelligence request.
	 * The server answers references and definition only across
	 * files in the loaded program. Both diagnostics modes signal
	 * that build: a pull resolves once the program is ready, and a
	 * push server publishes the file's first diagnostics then.
	 * Cached per file so warm requests skip the wait.
	 */
	private async ensureReady(path: string, signal?: AbortSignal): Promise<void> {
		const uri = fileToUri(path);
		const alreadyOpen = this.openDocs.has(uri);
		this.ensureOpen(path);
		if (alreadyOpen) return;
		// Drive the program build and use its completion as the gate.
		if (this.pullSupported) {
			// Only its end is the gate: a failed pull lets the request go on to
			// the server, which answers for itself.
			await this.pullDiagnostics(path, signal).catch(() => {});
		} else await this.settleDiagnostics(uri);
	}

	/**
	 * Pull the current diagnostics for a file. TypeScript 7's native
	 * LSP computes them on request and resolves once the program is
	 * built, so this both reports problems and gates readiness.
	 */
	private async pullDiagnostics(
		path: string,
		signal?: AbortSignal,
	): Promise<ProtocolDiagnostic[]> {
		const report = await withTimeout(
			this.cancellable(signal, (token) =>
				this.connection.sendRequest(
					DocumentDiagnosticRequest.type,
					{ textDocument: { uri: fileToUri(path) } },
					token,
				),
			),
			DIAGNOSTICS_TIMEOUT_MS,
			`diagnostics ${path}`,
		);
		if (report?.kind === DocumentDiagnosticReportKind.Full) {
			return report.items as unknown as ProtocolDiagnostic[];
		}
		return [];
	}

	/** Read the diagnostics a push server published, waiting for them to settle. */
	private async pushedDiagnostics(path: string): Promise<ProtocolDiagnostic[]> {
		const uri = fileToUri(path);
		await this.settleDiagnostics(uri);
		return this.diagnostics.get(uri) ?? [];
	}

	/**
	 * Resolve once a push server's diagnostics for `uri` have gone
	 * quiet, or the hard timeout fires. The quiet window only starts
	 * after the first publish, so a server slower than the window is
	 * still caught, while the timeout bounds one that never speaks.
	 */
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
			if (this.diagnostics.has(uri)) arm();
		});
	}

	private ensureOpen(path: string): void {
		const uri = fileToUri(path);
		if (this.openDocs.has(uri)) return;
		const text = this.read(path);
		this.lineCache.set(uri, toLines(text));
		this.version += 1;
		this.openDocs.add(uri);
		this.notify(() =>
			this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
				textDocument: {
					uri,
					languageId: languageIdFor(path),
					version: this.version,
					text,
				},
			}),
		);
	}

	private linesFor(path: string): string[] {
		const uri = fileToUri(path);
		const cached = this.lineCache.get(uri);
		if (cached) return cached;
		const lines = toLines(this.read(path));
		this.lineCache.set(uri, lines);
		return lines;
	}

	/**
	 * Apply a protocol workspace edit to disk, re-syncing open
	 * documents, and return what changed in tool coordinates.
	 */
	private applyWorkspaceEdit(edit: ProtocolWorkspaceEdit): WorkspaceEdit {
		return applyWorkspaceEdit(edit, {
			name: this.serverName,
			refuses: this.refuses,
			tell: (path, text) => this.tell(path, text),
		});
	}

	/** What the fence refuses pi for this server, when it has one. */
	private get refuses(): Refuses | undefined {
		return this.fence?.refuses;
	}

	/**
	 * A file's text, read by pi for the server. Under a fence, the file
	 * opened is judged as pi's file tools are there, since its text would
	 * reach the server past the fence (`judged-files.ts`).
	 */
	private read(path: string): string {
		return readJudged(path, this.refuses);
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
