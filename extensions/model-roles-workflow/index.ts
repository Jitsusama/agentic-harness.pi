/**
 * Model Roles Workflow extension.
 *
 * Registers `/model-roles`, which derives premium, primary and light
 * per provider from the live model registry, and names every model
 * that a same-family, cheaper-or-equal, newer sibling has made
 * redundant.
 *
 * Reads `ctx.modelRegistry` in process rather than pi's settings file
 * on disk, so this always answers for what is actually installed and
 * priced right now, not for a snapshot somebody wrote down once. This
 * only derives and reports: nothing here selects a model for anything,
 * so there is nothing live-behaviour-changing to gate.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	deriveRoles,
	findArchaic,
	type RoleModel,
} from "../../lib/roles/index.js";
import { view } from "../../lib/ui/index.js";
import { renderRoles } from "./render.js";

export default function modelRolesWorkflow(pi: ExtensionAPI) {
	pi.registerCommand("model-roles", {
		description:
			"Show premium, primary and light per provider, and which models an archaic audit found redundant.",
		handler: async (_args, ctx) => {
			const models: RoleModel[] = ctx.modelRegistry
				.getAvailable()
				.map((model) => ({
					id: model.id,
					provider: model.provider,
					cost: model.cost,
				}));

			const archaic = findArchaic(models);
			const archaicIds = new Set(archaic.map((finding) => finding.id));
			const roles = deriveRoles(
				models.filter((model) => !archaicIds.has(model.id)),
			);

			await view(ctx, {
				title: "Model Roles",
				content: (theme: Theme, _width: number) =>
					renderRoles(roles, archaic, theme),
			});
		},
	});
}
