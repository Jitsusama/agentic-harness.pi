// A host with pi's own screens, as the host program composes it, run by node under a seal: it prints its socket and serves until stopped.
/**
 * Run as `node screen-host.mts <package dir>`, with the seal's environment.
 * It composes what the host program does, with the program's own pieces:
 * its resolve hook, registered before any host code is imported, so the
 * screens' terminal and pi's screen share one pi-tui; the viewers'
 * terminal named in the host's environment before the theme reads it,
 * since pi-tui keeps its first answer for the whole process; the theme
 * the agent folder's settings name; a screen per conversation through
 * hostScreens over pi's InteractiveMode, which asks pi's startup questions,
 * such as whether to trust a folder, with the selector and main-screen TUI
 * of the host's own pi; and createEngine, starting each
 * conversation from the host's environment less what only the host sees,
 * handing its conversations to those screens under serveHost.
 *
 * Only the model and its key differ from the program, which asks the
 * gateway for a key: here pi answers from pi-ai's scripted provider,
 * registered in this process, by what the latest message asks: a long
 * answer, an answer with its thinking, a read of a long file, or one held
 * until the turn is stopped or the test writes the file it names in
 * HOME. Its agent folder offers a second model to pick, and gives every
 * conversation a `/pick` command that shows a select panel and writes the
 * answer to `picked` in HOME, and a `/gate` command that raises one of
 * the harness's own gates, with this checkout's panel extensions loaded,
 * and writes its answer to `gated`, a `/tabs` command that raises its
 * tabbed gate the same way, a `/view` command that shows one of the
 * harness's views over more rows than any screen, and a `/theme` command
 * that switches pi's one theme, as /settings does. A `/throw` command
 * sets a footer whose every frame throws, as a stale extension's did. A
 * `/footer` command
 * draws a footer naming the load that drew it and the conversation's
 * folder, read as it draws; once asked for, each later load of that
 * conversation takes a while to start, asking for a frame first, as a
 * harness's many extensions do, then draws its own. A `/host-reload`
 * command asks the host to reload the conversation, as the harness's
 * follower does once its install moves. A stand-in `wl-paste`
 * holds a picture on a sealed Wayland clipboard, handing it only to a
 * reader that has the session's Wayland display and runtime folder,
 * which the host's environment holds as the host unit sets it.
 *
 * It prints one JSON line naming its socket once it listens, and stops at
 * SIGTERM. Errors it is told of go to standard error.
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	watch,
	writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { EngineKey } from "../../../../host/engine/index.ts";
import { piFromHost } from "../../../../host/service/pi-resolution.ts";

/** What the fixture uses of pi-ai's scripted provider. */
interface Compat {
	registerFauxProvider(options: object): {
		readonly api: string;
		setResponses(responses: readonly unknown[]): void;
	};
	getApiProvider(api: string): object | undefined;
	registerApiProvider(provider: object): void;
	fauxAssistantMessage(content: unknown, options?: object): unknown;
	fauxToolCall(name: string, args: object, options: { id: string }): unknown;
	fauxText(text: string): unknown;
	fauxThinking(thinking: string): unknown;
}

/** What the scripted provider hands an answer of the request it answers. */
interface Asked {
	readonly signal?: AbortSignal;
}

/** A message as the scripted provider is handed it. */
interface Said {
	readonly role: string;
	readonly content: string | readonly { type: string; text?: string }[];
}

/** A pi module as the fixture uses it: pi's JavaScript carries no types here, so the shape is declared above. */
function piModule<T>(module: unknown): T {
	return module as T;
}

const [packageDir] = process.argv.slice(2);
if (!packageDir) throw new Error("usage: screen-host.mts <package dir>");

registerHooks({ resolve: piFromHost(packageDir) });
const { createEngine } = await import("../../../../host/engine/index.ts");
const { loadHostPi } = await import("../../../../host/engine/host-pi.ts");
const { hostedModeOf, hostScreens } = await import(
	"../../../../host/screen/screens.ts"
);
const { serveHost } = await import("../../../../host/service/serve.ts");
const { conversationBase, nameViewerTerminal, startupQuestions, themeStarter } =
	await import("../../../../host/service/program.ts");
const { hostedAskerOf } = await import(
	"../../../../host/screen/startup-ask.ts"
);

/** The sealed session's Wayland display, as the host unit is given it. */
const WAYLAND_DISPLAY = "wayland-sealed";
/** The picture on the sealed clipboard: a one-pixel PNG. */
const CLIPBOARD_PICTURE =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PROVIDER = "screen-faux";
const MODEL = "faux-1";
/** A second model, for the model selector to pick. */
const OTHER_MODEL = "faux-2";
/** What a held answer is held by: words naming the file in HOME that releases it. */
const HELD = /hold until (\S+)/;
/** More answers than any run of the proofs asks for. */
const ANSWERS = 200;
const home = homedir();
const agentDir = join(home, ".pi", "agent");
const report = (error: unknown) => {
	const said = error instanceof Error ? (error.stack ?? error.message) : error;
	process.stderr.write(`screen-host: ${String(said)}\n`);
};

const compat = piModule<Compat>(
	await import(
		pathToFileURL(
			join(packageDir, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
		).href
	),
);
const faux = compat.registerFauxProvider({ tokenSize: { min: 2, max: 2 } });
faux.setResponses(Array.from({ length: ANSWERS }, () => answer));
// pi's reload clears every provider registered in the process, as it does
// before an extension's provider comes back with its new load; the agent
// folder's footer extension brings this one back the same way.
const scripted = compat.getApiProvider(faux.api);
(globalThis as Record<symbol, unknown>)[
	Symbol.for("screen-host.faux.restore")
] = () => {
	if (scripted && !compat.getApiProvider(faux.api))
		compat.registerApiProvider(scripted);
};
writeAgentFolder(faux.api);
const clipboard = writeClipboard();
// What the host unit gives the host: the session's Wayland display beside
// its runtime folder, and the clipboard reader on its PATH. Offline comes
// from the seal, or pi's startup tries to fetch fd, rg and its version.
process.env.WAYLAND_DISPLAY = WAYLAND_DISPLAY;
process.env.PATH = `${clipboard}:${process.env.PATH ?? ""}`;

const pi = await loadHostPi(packageDir);
nameViewerTerminal(process.env);
themeStarter(pi.modules.codingAgent, home)();
const questions = startupQuestions(pi.modules);

const screens = hostScreens({
	create: hostedModeOf(pi.modules.codingAgent.InteractiveMode),
	ask: hostedAskerOf(questions.selector, questions.mainScreen),
	report,
});
const key: EngineKey = {
	inherited: false,
	current: async () => "faux-key",
	refused: () => {},
};
const serving = await serveHost({
	realm: process.env.MYCELIUM_REALM ?? "sealed",
	kind: "attended",
	engine: (host) =>
		createEngine({
			packageDir,
			stateDir: join(home, "engine"),
			host,
			env: conversationBase(process.env),
			key,
			report,
			screens: screens.screens,
		}),
	viewer: () => screens.viewer,
	report,
	runtimeDir: process.env.XDG_RUNTIME_DIR,
	rollout: () => Promise.resolve(),
});
process.stdout.write(`${JSON.stringify({ path: serving.path })}\n`);
process.once("SIGTERM", () => {
	serving.stop().then(
		() => process.exit(0),
		(error: unknown) => {
			report(error);
			process.exit(1);
		},
	);
});

/**
 * Answer by what the latest message asks: a picture is a read of
 * `picture.png` in the conversation's folder and notes a read of
 * `notes.txt`, a tool's result is acknowledged, a long answer is 120
 * lines, thinking comes before its answer, a hold waits to be stopped or
 * released, and anything else is echoed back.
 */
async function answer(
	context: { readonly messages: readonly Said[] },
	asked?: Asked,
): Promise<unknown> {
	const last = context.messages.at(-1);
	if (last?.role === "toolResult") return compat.fauxAssistantMessage("done");
	const words = last ? text(last) : "";
	const hold = HELD.exec(words)?.[1];
	if (hold) {
		await released(hold, asked?.signal);
		return compat.fauxAssistantMessage(`released: ${hold}`);
	}
	if (words.includes("read notes"))
		return compat.fauxAssistantMessage(
			[
				compat.fauxToolCall(
					"read",
					{ path: "notes.txt" },
					{ id: `read-${Date.now()}` },
				),
			],
			{ stopReason: "toolUse" },
		);
	if (words.includes("think first"))
		return compat.fauxAssistantMessage([
			compat.fauxThinking("weighing it up first"),
			compat.fauxText("thought it through"),
		]);
	if (words.includes("picture"))
		return compat.fauxAssistantMessage(
			[
				compat.fauxToolCall(
					"read",
					{ path: "picture.png" },
					{ id: `read-${Date.now()}` },
				),
			],
			{ stopReason: "toolUse" },
		);
	if (words.includes("long answer"))
		return compat.fauxAssistantMessage(
			Array.from({ length: 120 }, (_, n) => `line ${n + 1}`).join("\n"),
		);
	return compat.fauxAssistantMessage(`heard: ${words}`);
}

/** Settle once the turn is stopped, or once `name` is a file in HOME. */
function released(name: string, signal: AbortSignal | undefined) {
	const release = join(home, name);
	return new Promise<void>((done) => {
		const watcher = watch(home, () => {
			if (existsSync(release)) settle();
		});
		const settle = () => {
			watcher.close();
			done();
		};
		signal?.addEventListener("abort", settle, { once: true });
		if (signal?.aborted || existsSync(release)) settle();
	});
}

function text(message: Said): string {
	return typeof message.content === "string"
		? message.content
		: message.content.map((part) => part.text ?? "").join("");
}

/**
 * A stand-in `wl-paste` for the sealed session's clipboard, run by this
 * node: it lists and hands over the picture only to a reader with the
 * session's display and runtime folder, and fails like wl-paste without a
 * compositor otherwise. Answers the folder it is in.
 */
function writeClipboard(): string {
	const folder = join(home, "clipboard");
	mkdirSync(folder, { recursive: true });
	const program = join(folder, "wl-paste");
	const runtime = JSON.stringify(process.env.XDG_RUNTIME_DIR ?? "");
	writeFileSync(
		program,
		[
			`#!${process.execPath}`,
			`if (process.env.WAYLAND_DISPLAY !== ${JSON.stringify(WAYLAND_DISPLAY)} || process.env.XDG_RUNTIME_DIR !== ${runtime}) process.exit(1);`,
			`if (process.argv.includes("--list-types")) process.stdout.write("image/png\\n");`,
			`else process.stdout.write(Buffer.from(${JSON.stringify(CLIPBOARD_PICTURE)}, "base64"));`,
			"",
		].join("\n"),
	);
	chmodSync(program, 0o755);
	return folder;
}

/**
 * pi's agent folder: the scripted provider's two models, the `/pick`
 * extension, and the harness's own gates: a `/gate` command raising this
 * checkout's `showSinglePrompt` and keeping its answer in `gated` in HOME,
 * with 100 numbered rows below its question when its name starts with
 * `tall`, a `/tabs` command raising its `showTabbedPrompt` over two items and
 * keeping its answer there too, a `/view` command showing this checkout's `view` over 200 numbered
 * rows, a `/theme` command switching pi's theme by name and saying which,
 * a `/footer` naming its load with a `/host-reload` command reloading it
 * through the host, a `/throw` command setting a footer that throws on
 * every frame, and this checkout's panel-lifecycle and panel-zoom
 * extensions.
 */
function writeAgentFolder(api: string): void {
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[PROVIDER]: {
					baseUrl: "http://faux.invalid",
					api,
					apiKey: "$SHOPIFY_PROXY_KEY",
					models: [
						[MODEL, "Faux"],
						[OTHER_MODEL, "Faux Two"],
					].map(([id, name]) => ({
						id,
						name,
						reasoning: false,
						input: ["text", "image"],
						contextWindow: 128_000,
						maxTokens: 16_384,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					})),
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: PROVIDER,
			defaultModel: MODEL,
			quietStartup: true,
		}),
	);
	writeFileSync(
		join(agentDir, "extensions", "pick.ts"),
		`import { appendFileSync } from "node:fs";
export default function (pi) {
	pi.registerCommand("pick", {
		description: "Show a select panel and keep the answer",
		handler: async (_args, ctx) => {
			const choice = await ctx.ui.select("Pick one", ["alpha", "beta", "gamma"]);
			appendFileSync(${JSON.stringify(join(home, "picked"))}, String(choice) + "\\n");
		},
	});
}
`,
	);
	const harness = join(import.meta.dirname, "../../../..");
	writeFileSync(
		join(agentDir, "extensions", "gate.ts"),
		`import { appendFileSync } from "node:fs";
import { showSinglePrompt } from ${JSON.stringify(join(harness, "lib/ui/prompt-single.ts"))};
export default function (pi) {
	pi.registerCommand("gate", {
		description: "Raise one of the harness's gates and keep its answer",
		handler: async (name, ctx) => {
			const result = await showSinglePrompt(ctx, {
				title: "Gate " + name,
				content: () =>
					name.startsWith("tall")
						? ["Gate " + name + " asks", ...Array.from({ length: 100 }, (_, at) => "row " + (at + 1))]
						: ["Gate " + name + " asks"],
				actions: [{ key: "a", label: "Approve" }, { key: "r", label: "Reject" }],
			});
			const said =
				result?.type === "action"
					? result.key
					: result?.type === "redirect"
						? "redirected " + result.note
						: "cancelled";
			appendFileSync(${JSON.stringify(join(home, "gated"))}, name + " " + said + "\\n");
		},
	});
}
`,
	);
	writeFileSync(
		join(agentDir, "extensions", "tabs.ts"),
		`import { appendFileSync } from "node:fs";
import { showTabbedPrompt } from ${JSON.stringify(join(harness, "lib/ui/prompt-tabbed.ts"))};
export default function (pi) {
	pi.registerCommand("tabs", {
		description: "Raise one of the harness's tabbed gates and keep its answer",
		handler: async (name, ctx) => {
			const item = (label) => ({
				label,
				views: [{ key: "c", label: "Content", content: () => ["Tabs " + name + " " + label] }],
			});
			const result = await showTabbedPrompt(ctx, {
				title: "Tabs " + name,
				items: [item("Q1"), item("Q2")],
				actions: [{ key: "a", label: "Approve" }, { key: "r", label: "Reject" }],
			});
			const said = result === null ? "cancelled" : "submitted";
			appendFileSync(${JSON.stringify(join(home, "gated"))}, name + " " + said + "\\n");
		},
	});
}
`,
	);
	writeFileSync(
		join(agentDir, "extensions", "view.ts"),
		`import { view } from ${JSON.stringify(join(harness, "lib/ui/panel.ts"))};
export default function (pi) {
	pi.registerCommand("view", {
		description: "Show one of the harness's views, longer than any screen",
		handler: async (_args, ctx) => {
			await view(ctx, {
				content: () => Array.from({ length: 200 }, (_, at) => "row " + (at + 1)),
			});
		},
	});
}
`,
	);
	writeFileSync(
		join(agentDir, "extensions", "theme.ts"),
		`export default function (pi) {
	pi.registerCommand("theme", {
		description: "Switch pi's theme by name, as /settings does",
		handler: async (name, ctx) => {
			const result = ctx.ui.setTheme(name.trim());
			ctx.ui.notify(result.success ? "Theme is now " + name.trim() : "No theme " + name.trim() + ": " + result.error, "info");
		},
	});
}
`,
	);
	writeFileSync(
		join(agentDir, "extensions", "footer.ts"),
		`import { hosted, sessionKeyOf } from ${JSON.stringify(join(harness, "lib/core/session/index.ts"))};
const LOADS = Symbol.for("screen-host.footer.loads");
const WANTED = Symbol.for("screen-host.footer.wanted");
const wanted = (globalThis[WANTED] ??= new Set());
export default function (pi) {
	globalThis[Symbol.for("screen-host.faux.restore")]?.();
	const load = (globalThis[LOADS] = (globalThis[LOADS] ?? 0) + 1);
	const draw = (ctx) =>
		ctx.ui.setFooter(() => ({
			invalidate() {},
			render: () => ["footer of load " + load + " in " + ctx.cwd],
		}));
	pi.on("session_start", async (_event, ctx) => {
		if (!wanted.has(ctx.sessionManager.getSessionId())) return;
		ctx.ui.setStatus("footer", "load " + load + " starting");
		// Stands in for a load's slow start, during which the screen draws the frame just asked for.
		await new Promise((started) => setTimeout(started, 300));
		draw(ctx);
	});
	pi.registerCommand("footer", {
		description: "Draw a footer naming its load, now and after each reload",
		handler: async (_args, ctx) => {
			wanted.add(ctx.sessionManager.getSessionId());
			draw(ctx);
		},
	});
	pi.registerCommand("host-reload", {
		description: "Ask the host to reload this conversation, as the follower does",
		handler: async (_args, ctx) => {
			// Not awaited: the host waits for the conversation to be idle, which this command holds it from.
			void hosted()?.reload?.(sessionKeyOf(ctx), { reason: "the proof" });
		},
	});
}
`,
	);
	writeFileSync(
		join(agentDir, "extensions", "throw.ts"),
		`export default function (pi) {
	pi.registerCommand("throw", {
		description: "Set a footer whose every frame throws, as a stale extension's did",
		handler: async (_args, ctx) => {
			ctx.ui.setFooter(() => ({
				render() {
					throw new Error("this footer's extension is stale");
				},
				invalidate() {},
			}));
		},
	});
}
`,
	);
	for (const extension of ["panel-lifecycle-workflow", "panel-zoom-widget"])
		writeFileSync(
			join(agentDir, "extensions", `${extension}.ts`),
			`export { default } from ${JSON.stringify(join(harness, "extensions", extension, "index.ts"))};\n`,
		);
}
