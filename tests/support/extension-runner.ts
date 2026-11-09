/** In-process runners for testing extension lifetime and caller context. */
import {
	createEventBus,
	createExtensionRuntime,
	type Extension,
	type ExtensionFactory,
	ExtensionRunner,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

/** Run one factory with a real pi dispatcher, without a model or a screen. */
export function extensionRunner(
	factory: ExtensionFactory,
	cwd: string,
	manager = SessionManager.inMemory(cwd),
) {
	const runtime = createExtensionRuntime();
	const extension: Extension = {
		path: "test",
		resolvedPath: "test",
		sourceInfo: {
			path: "test",
			source: "sdk",
			scope: "temporary",
			origin: "top-level",
		},
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	const tools = new Map<string, ToolDefinition>();
	const events = createEventBus();
	const loaded = factory({
		events,
		on(name: string, handler: Handler) {
			const handlers = extension.handlers.get(name) ?? [];
			handlers.push(handler);
			extension.handlers.set(name, handlers);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerMessageRenderer() {},
		// Commands need a screen; lifetime tests drive only events and tools.
		registerCommand() {},
	} as never);
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		cwd,
		manager,
		{} as never,
	);
	const errors: string[] = [];
	runner.onError((error) => errors.push(error.error));
	return {
		runner,
		events,
		errors,
		async start() {
			await loaded;
			await runner.emit({ type: "session_start", reason: "startup" });
		},
		async stop() {
			await runner.emit({ type: "session_shutdown", reason: "quit" });
		},
		async call(name: string, params: unknown) {
			const tool = tools.get(name);
			if (!tool) throw new Error(`No tool ${name}`);
			return tool.execute(
				"test",
				params,
				undefined,
				undefined,
				runner.createToolContext("test", undefined),
			);
		},
	};
}
