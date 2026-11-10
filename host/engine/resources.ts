/**
 * The resources every conversation loads, chosen as pi's command-line flags
 * choose them, and turned into the options pi's main hands its resource
 * loader for those flags. It changes when pi's flags do.
 */
import { isAbsolute } from "node:path";
import type {
	BuiltInExtension,
	EventBus,
	ResourceLoaderOptions,
} from "./pi-session.ts";

/**
 * The resources pi's command-line flags choose, for every conversation:
 * extensions as `-e` adds them, and `--no-extensions`, `--no-skills`,
 * `--no-prompt-templates`, `--no-context-files` and `--no-mcp`.
 */
export interface ConversationResources {
	/** Extension paths, absolute, loaded as `-e` loads them. */
	readonly extensions?: readonly string[];
	readonly noExtensions?: boolean;
	readonly noSkills?: boolean;
	readonly noPromptTemplates?: boolean;
	readonly noContextFiles?: boolean;
	/** pi's own extensions not to load, by name, as `--no-mcp` leaves out `mcp`. */
	readonly disabledBuiltinExtensions?: readonly string[];
}

/**
 * pi's resource loader options for a conversation, as pi's main sets them
 * from its flags, with pi's own built-ins as its CLI passes them.
 */
export function loaderOptions(
	eventBus: EventBus,
	extensionFactories: readonly BuiltInExtension[],
	resources: ConversationResources | undefined,
): ResourceLoaderOptions {
	if (!resources) return { eventBus, extensionFactories };
	const relative = resources.extensions?.find((path) => !isAbsolute(path));
	if (relative)
		throw new Error(`An extension path must be absolute: ${relative}`);
	return {
		eventBus,
		extensionFactories,
		...(resources.extensions
			? { additionalExtensionPaths: [...resources.extensions] }
			: {}),
		...(resources.disabledBuiltinExtensions
			? { disabledBuiltinExtensions: [...resources.disabledBuiltinExtensions] }
			: {}),
		...(resources.noExtensions ? { noExtensions: true } : {}),
		...(resources.noSkills ? { noSkills: true } : {}),
		...(resources.noPromptTemplates ? { noPromptTemplates: true } : {}),
		...(resources.noContextFiles ? { noContextFiles: true } : {}),
	};
}
