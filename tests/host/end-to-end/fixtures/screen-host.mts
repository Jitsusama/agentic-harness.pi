// A host with pi's own screens, as the host program composes it, run by node under a seal: it prints its socket and serves until stopped.
/**
 * Run as `node screen-host.mts <package dir>`, with the seal's environment.
 * It composes what the host program does: one theme for the host, a
 * screen per conversation through hostScreens over pi's InteractiveMode,
 * createEngine handing its conversations to those screens, and serveHost
 * with the screens' viewer bridge. Its pi answers from pi-ai's scripted
 * provider, by what the latest message asks; its agent folder gives every
 * conversation a `/pick` command that shows a select panel and writes the
 * answer to `picked` in HOME. A stand-in `wl-paste` holds a picture on a
 * sealed Wayland clipboard, handing it only to a reader that has the
 * session's Wayland display and runtime folder, as the host unit passes
 * them to every conversation.
 *
 * Host code binds the host's pi, as the host program's resolve hook has
 * it: an `@earendil-works/*` import from outside that pi resolves from its
 * root, so the screens' terminal and pi's screen share one pi-tui. The
 * hook is registered before any host code is imported.
 *
 * It prints one JSON line naming its socket once it listens, and stops at
 * SIGTERM. Errors it is told of go to standard error.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { EngineKey } from "../../../../host/engine/index.ts";

/** What the fixture uses of pi-ai's scripted provider. */
interface Compat {
	registerFauxProvider(options: object): {
		readonly api: string;
		setResponses(responses: readonly unknown[]): void;
	};
	fauxAssistantMessage(content: unknown, options?: object): unknown;
	fauxToolCall(name: string, args: object, options: { id: string }): unknown;
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

/** Resolve pi's packages from the host's pi for code outside it. */
const HOST_PI_RESOLUTION = `
let root, inside;
export function initialize(data) { root = data.root; inside = data.inside; }
export function resolve(specifier, context, next) {
	const outside = !context.parentURL?.startsWith(inside);
	if (outside && specifier.startsWith("@earendil-works/"))
		return next(specifier, { ...context, parentURL: root });
	return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOST_PI_RESOLUTION)}`, {
	data: {
		root: pathToFileURL(join(packageDir, "package.json")).href,
		inside: `${pathToFileURL(packageDir).href}/`,
	},
});
const { createEngine } = await import("../../../../host/engine/index.ts");
const { loadHostPi } = await import("../../../../host/engine/host-pi.ts");
const { hostedModeOf, hostScreens } = await import(
	"../../../../host/screen/screens.ts"
);
const { serveHost } = await import("../../../../host/service/serve.ts");

/** The sealed session's Wayland display, which only its conversations are told of. */
const WAYLAND_DISPLAY = "wayland-sealed";
/** The picture on the sealed clipboard: a one-pixel PNG. */
const CLIPBOARD_PICTURE =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PROVIDER = "screen-faux";
const MODEL = "faux-1";
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
writeAgentFolder(faux.api);
const clipboard = writeClipboard();

const pi = await loadHostPi(packageDir);
const initTheme = pi.modules.codingAgent.initTheme;
if (typeof initTheme !== "function") throw new Error("pi exports no initTheme");
// The host's one theme, as pi's own main sets it before its screen.
initTheme("dark", false);

const screens = hostScreens({
	create: hostedModeOf(pi.modules.codingAgent.InteractiveMode),
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
			// Each conversation reads only this environment. Offline, or pi's
			// startup tries to fetch fd, rg and its version; and the terminal
			// every viewer is, kitty, which pi can't see from a host's own. The
			// session's Wayland display and runtime folder reach only them.
			env: {
				PATH: `${clipboard}:${process.env.PATH ?? ""}`,
				HOME: home,
				TMPDIR: process.env.TMPDIR ?? "",
				WAYLAND_DISPLAY,
				XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "",
				PI_OFFLINE: "1",
				PI_IMAGE_PROTOCOL: "kitty",
				PI_TRUE_COLOR: "1",
			},
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
 * `picture.png` in the conversation's folder, a tool's result is
 * acknowledged, and anything else is echoed back.
 */
function answer(context: { readonly messages: readonly Said[] }): unknown {
	const last = context.messages.at(-1);
	if (last?.role === "toolResult") return compat.fauxAssistantMessage("done");
	const words = last ? text(last) : "";
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

/** pi's agent folder: the scripted provider as the only model, and the `/pick` extension. */
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
						{
							id: MODEL,
							name: "Faux",
							reasoning: false,
							input: ["text", "image"],
							contextWindow: 128_000,
							maxTokens: 16_384,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
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
}
