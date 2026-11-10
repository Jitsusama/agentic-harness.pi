/** The host refuses a pi that lacks any seam it needs, naming each missing patch. */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	HOST_SEAMS,
	HostPiRefused,
	hostPiFiles,
	loadHostPi,
} from "../../../host/engine/host-pi.ts";

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
	const agent = seams.agent ? "static hostAgentInterfaceVersion = 1;" : "";
	const screen = seams.screen ? "static hostedLifecycleVersion = 1;" : "";
	const auth = seams.auth ? "static hostAuthContextVersion = 1;" : "";
	const phases = seams.turn
		? "{ committedTurn() {}, turnBoundary() {} }"
		: "{ request() {} }";
	const sources: Record<keyof typeof files, string> = {
		codingAgent: `export const VERSION = "${FAKE_VERSION}";\nexport class AgentSession { ${agent} }\nexport class InteractiveMode { ${screen} }\nexport class ModelRuntime { ${auth} }\n`,
		durable: `export const GenerationTask = { definition: { version: ${seams.turn ? 3 : 2}, phases: ${phases} } };\n`,
		agentCore: "export const DEFAULT_AGENT_IDENTITY = {};\n",
		ai: "export const validateToolArguments = () => {};\n",
		sqlite: "export const openSqlite = () => {};\n",
		nodeEnv: "export const nodeEnv = {};\n",
		context: "export const BACKGROUND_CONTEXT = {};\n",
	};
	for (const [name, file] of Object.entries(files)) {
		if (name === omit) continue;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, sources[name as keyof typeof files]);
	}
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
	expect(Object.keys(pi.modules.durable)).toEqual(["GenerationTask"]);
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
			"hostAuthContextVersion = 1",
			"hostAuthContextVersion = 2",
		),
	);
	await expect(loadHostPi(dir)).resolves.toMatchObject({ packageDir: dir });
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
		"export class AgentSession { static hostAgentInterfaceVersion = 1; }\nexport class InteractiveMode { static hostedLifecycleVersion = 1; }\nexport class ModelRuntime { static hostAuthContextVersion = 1; }\n",
	);
	await expect(loadHostPi(dir)).rejects.toThrow("names no version");
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

it("refuses a relative install path", async () => {
	await expect(loadHostPi("pi-1.5.0")).rejects.toThrow(
		"must be an absolute path",
	);
});

const installed = process.env.PI_PACKAGE_DIR;
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
