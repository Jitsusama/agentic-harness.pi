/**
 * The host refuses a pi that lacks any seam it needs, naming each missing
 * patch, and reports one it only wants without refusing.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
	HOST_SEAMS,
	HOST_WANTED_SEAMS,
	HostPiRefused,
	hostPiFiles,
	lackingSeams,
	loadHostPi,
} from "../../../host/engine/host-pi.ts";
import { piBuiltInExtensions } from "../../../host/engine/pi-session.ts";
import { isRecord } from "../../../lib/internal/record.ts";

/** Loading every module of a real pi install, which a busy machine slows past vitest's default. */
const REAL_PI_LOAD_MS = 30_000;

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

interface FakeSeams {
	readonly agent?: boolean;
	readonly turn?: boolean;
	readonly screen?: boolean;
	/** Whether the screen's lifecycle patch has its hosted quit; it does unless said. */
	readonly quit?: boolean;
	/** Whether the agent-interface patch shows the agent's queued words; it does unless said. */
	readonly queue?: boolean;
	readonly auth?: boolean;
}

/** The version every fake install says it is. */
const FAKE_VERSION = "1.5.0-fake";

/** A pi install laid out as World's and nixpkgs' are, with the markers each patch adds. */
function fakeInstall(
	seams: FakeSeams,
	omit?: keyof ReturnType<typeof hostPiFiles>,
) {
	const dir = mkdtempSync(join(tmpdir(), "host-pi-"));
	directories.push(dir);
	const files = hostPiFiles(dir);
	const queue =
		seams.agent && seams.queue !== false
			? " static hostQueueDisplay = true;"
			: "";
	const agent = seams.agent
		? `static hostAgentInterfaceVersion = 1;${queue}`
		: "";
	const lifecycle = seams.screen ? "static hostedLifecycleVersion = 1;" : "";
	const quit =
		seams.screen && seams.quit !== false ? " static hostedQuit = true;" : "";
	const screen = lifecycle + quit;
	const auth = seams.auth ? "static hostAuthContextVersion = 2;" : "";
	const phases = seams.turn
		? "{ committedTurn() {}, turnBoundary() {} }"
		: "{ request() {} }";
	const sources: Record<keyof typeof files, string> = {
		codingAgent: `export const VERSION = "${FAKE_VERSION}";\nexport class AgentSession { ${agent} }\nexport class InteractiveMode { ${screen} }\nexport class ModelRuntime { ${auth} }\n`,
		builtins:
			'export const builtInExtensions = [{ name: "tool-search", factory: () => {}, replaceable: true, builtin: true }];\n',
		projectTrust: "export const resolveProjectTrusted = async () => true;\n",
		durable: `export const GenerationTask = { definition: { version: ${seams.turn ? 3 : 2}, phases: ${phases} } };\n`,
		agentCore: "export const DEFAULT_AGENT_IDENTITY = {};\n",
		ai: "export const validateToolArguments = () => {};\n",
		tui: "export class TuiMainScreen {}\n",
		sqlite: "export const openSqlite = () => {};\n",
		nodeEnv: "export const nodeEnv = {};\n",
		context: "export const BACKGROUND_CONTEXT = {};\n",
	};
	for (const [name, file] of Object.entries(files)) {
		if (name === omit) continue;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, sources[name as keyof typeof files]);
	}
	const command = join(dir, "dist", "bundle", "cli.js");
	mkdirSync(dirname(command), { recursive: true });
	writeFileSync(command, "");
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ bin: { pi: "dist/bundle/cli.js" } }),
	);
	return dir;
}

async function refusal(packageDir: string): Promise<HostPiRefused> {
	const error = await loadHostPi(packageDir).then(
		() => undefined,
		(thrown: unknown) => thrown,
	);
	if (!(error instanceof HostPiRefused))
		throw new Error(`not refused: ${String(error)}`);
	return error;
}

it("loads a pi that carries every host seam", async () => {
	const dir = fakeInstall({
		agent: true,
		turn: true,
		screen: true,
		auth: true,
	});
	const pi = await loadHostPi(dir);
	expect(pi.packageDir).toBe(dir);
	expect(pi.version).toBe(FAKE_VERSION);
	expect(pi.command).toBe(join(dir, "dist", "bundle", "cli.js"));
	expect(Object.keys(pi.modules.durable)).toEqual(["GenerationTask"]);
	expect(pi.lacking).toEqual([]);
});

it("loads a pi built before the queued-words seam, saying what goes without it", async () => {
	const dir = fakeInstall({
		agent: true,
		turn: true,
		screen: true,
		queue: false,
		auth: true,
	});
	const pi = await loadHostPi(dir);
	expect(pi.lacking).toEqual(HOST_WANTED_SEAMS);
	expect(lackingSeams(pi.packageDir, pi.lacking)).toBe(
		`The pi at ${dir} lacks pi-host-agent-interface.patch: without it words sent as a conversation reopens show nowhere until their turn starts`,
	);
});

it("refuses a pi whose package names no pi command", async () => {
	const dir = fakeInstall({
		agent: true,
		turn: true,
		screen: true,
		auth: true,
	});
	writeFileSync(join(dir, "package.json"), JSON.stringify({ bin: {} }));
	await expect(loadHostPi(dir)).rejects.toThrow("names no pi command");
});

it("takes a later auth-context patch", async () => {
	const dir = fakeInstall({
		agent: true,
		turn: true,
		screen: true,
		auth: true,
	});
	const { codingAgent } = hostPiFiles(dir);
	writeFileSync(
		codingAgent,
		readFileSync(codingAgent, "utf8").replace(
			"hostAuthContextVersion = 2",
			"hostAuthContextVersion = 3",
		),
	);
	await expect(loadHostPi(dir)).resolves.toMatchObject({ packageDir: dir });
});

it("refuses the first auth-context patch, which left header variables to the host", async () => {
	const dir = fakeInstall({
		agent: true,
		turn: true,
		screen: true,
		auth: true,
	});
	const { codingAgent } = hostPiFiles(dir);
	writeFileSync(
		codingAgent,
		readFileSync(codingAgent, "utf8").replace(
			"hostAuthContextVersion = 2",
			"hostAuthContextVersion = 1",
		),
	);
	const error = await refusal(dir);
	expect(error.missing.map((seam) => seam.patch)).toEqual([
		"pi-host-model-auth-context.patch",
	]);
});

it("refuses a pi that names no version", async () => {
	const dir = fakeInstall({
		agent: true,
		turn: true,
		screen: true,
		auth: true,
	});
	const { codingAgent } = hostPiFiles(dir);
	writeFileSync(
		codingAgent,
		"export class AgentSession { static hostAgentInterfaceVersion = 1; }\nexport class InteractiveMode { static hostedLifecycleVersion = 1; static hostedQuit = true; }\nexport class ModelRuntime { static hostAuthContextVersion = 2; }\n",
	);
	await expect(loadHostPi(dir)).rejects.toThrow("names no version");
});

it("refuses a pi whose screens would quit without asking the host", async () => {
	const error = await refusal(
		fakeInstall({
			agent: true,
			turn: true,
			screen: true,
			auth: true,
			quit: false,
		}),
	);
	expect(error.missing.map((seam) => seam.patch)).toEqual([
		"pi-host-interactive-lifecycle.patch",
	]);
	expect(error.message).toContain(
		"pi-host-interactive-lifecycle.patch: without it a quit typed while other windows watch would end the conversation",
	);
});

it("names a missing patch once, with every reason the host needs it", async () => {
	const error = await refusal(
		fakeInstall({ agent: true, turn: true, screen: false, auth: true }),
	);
	const named = error.message.split("pi-host-interactive-lifecycle.patch");
	expect(named.length - 1, `named once: ${error.message}`).toBe(1);
	expect(error.message).toContain(
		"would own the host's process exit and signals, and a quit typed while other windows watch",
	);
});

it("names only the patch a pi is missing", async () => {
	const error = await refusal(
		fakeInstall({ agent: true, screen: true, auth: true }),
	);
	expect(error.missing.map((seam) => seam.patch)).toEqual([
		"pi-host-committed-turn.patch",
	]);
	expect(error.message).toContain(
		"pi-host-committed-turn.patch: without it a committed turn cannot wait",
	);
});

it("refuses a generation at the committed-turn version without its phases", async () => {
	const dir = fakeInstall({ agent: true, screen: true, auth: true });
	writeFileSync(
		hostPiFiles(dir).durable,
		"export const GenerationTask = { definition: { version: 3, phases: {} } };\n",
	);
	const error = await refusal(dir);
	expect(error.missing.map((seam) => seam.patch)).toEqual([
		"pi-host-committed-turn.patch",
	]);
});

it("says which module files an incomplete install lacks", async () => {
	const dir = fakeInstall(
		{ agent: true, turn: true, screen: true, auth: true },
		"sqlite",
	);
	await expect(loadHostPi(dir)).rejects.toThrow(
		`is incomplete; it has no ${hostPiFiles(dir).sqlite}`,
	);
});

it("hands on pi's built-in extensions whole, flags and all", async () => {
	const pi = await loadHostPi(
		fakeInstall({ agent: true, turn: true, screen: true, auth: true }),
	);
	const [only, ...rest] = piBuiltInExtensions(pi.modules);
	expect(rest).toEqual([]);
	expect(only).toMatchObject({
		name: "tool-search",
		replaceable: true,
		builtin: true,
	});
});

it("refuses an install whose built-in list it can't load", () => {
	for (const builtInExtensions of [undefined, [], [{ name: "mcp" }]])
		expect(() =>
			piBuiltInExtensions({ builtins: { builtInExtensions } }),
		).toThrow("lists no built-in extensions it can load");
});

it("refuses a relative install path", async () => {
	await expect(loadHostPi("pi-1.5.0")).rejects.toThrow(
		"must be an absolute path",
	);
});

const installed = process.env.PI_PACKAGE_DIR;
it.runIf(installed !== undefined)(
	"reads the CLI's own built-in list from a real install, in its order",
	async () => {
		const file = hostPiFiles(installed ?? "").builtins;
		const builtins: unknown = await import(pathToFileURL(file).href);
		if (!isRecord(builtins)) throw new Error(`${file} exports nothing`);
		const names = piBuiltInExtensions({ builtins }).map((one) => one.name);
		expect(names).toEqual(expect.arrayContaining(["tool-search", "codemode"]));
	},
	REAL_PI_LOAD_MS,
);

it.runIf(installed !== undefined)(
	"refuses the ordinary pi this session runs, naming every host patch",
	async () => {
		const error = await refusal(installed ?? "");
		expect(error.missing.map((seam) => seam.patch)).toEqual(
			HOST_SEAMS.map((seam) => seam.patch),
		);
	},
	REAL_PI_LOAD_MS,
);
