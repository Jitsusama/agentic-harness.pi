/**
 * Budget File Provider extension.
 *
 * Says what a budget's name means from a file of the person's own: in
 * `~/.config/pi/agentic-harness.pi/budgets/` (under `XDG_CONFIG_HOME`
 * when set), `<name>.env` holds the variables a session drawing on the
 * budget runs with, or an executable `<name>` prints them. A quest
 * names the budget (`quest budget`); this answers what it means,
 * asked before any other provider, so a person's own file wins over a
 * company's mapping of the same name. See lib/budget/files.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { budgetFileProvider } from "../../lib/budget/files.ts";
import { registerBudgetProvider } from "../../lib/budget/provider.ts";
import { configDir } from "../../lib/internal/paths.ts";

export default function budgetFileProviderExtension(pi: ExtensionAPI) {
	registerBudgetProvider(pi.events, budgetFileProvider(configDir("budgets")));
}
