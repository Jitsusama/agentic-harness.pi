import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ArchaicFinding, RoleAssignment } from "../../lib/roles/index.ts";

/** Render the derived roles and the archaic audit as a list of lines. */
export function renderRoles(
	roles: readonly RoleAssignment[],
	archaic: readonly ArchaicFinding[],
	theme: Theme,
): string[] {
	const lines: string[] = [""];

	if (roles.length === 0) {
		lines.push(theme.fg("muted", "  No models available from any provider."));
		lines.push("");
		return lines;
	}

	for (const assignment of [...roles].sort((a, b) =>
		a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0,
	)) {
		lines.push(theme.fg("text", `  ${assignment.provider}`));
		lines.push(
			`    ${theme.fg("dim", "premium")}  ${assignment.premium ?? theme.fg("muted", "-")}`,
		);
		lines.push(
			`    ${theme.fg("dim", "primary")}  ${assignment.primary ?? theme.fg("muted", "-")}`,
		);
		lines.push(
			`    ${theme.fg("dim", "light")}    ${assignment.light ?? theme.fg("muted", "-")}`,
		);
		lines.push("");
	}

	if (archaic.length === 0) {
		lines.push(theme.fg("muted", "  No archaic models found."));
		lines.push("");
		return lines;
	}

	lines.push(theme.fg("text", "  Archaic"));
	for (const finding of archaic) {
		lines.push(
			`    ${theme.fg("warning", finding.id)} ${theme.fg("dim", "->")} ${finding.supersededBy}`,
		);
	}
	lines.push("");
	return lines;
}
