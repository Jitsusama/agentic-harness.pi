/**
 * Helpers for interactive confirmation gates.
 *
 * Gate prompts render while the tool call is still executing. Pi's default
 * working loader can otherwise remain visible above the custom panel, which
 * makes the gate look like it has duplicate spinners and clipped chrome.
 */

interface WorkingVisibilityContext {
	readonly hasUI: boolean;
	readonly ui: {
		setWorkingVisible(visible: boolean): void;
	};
}

/** Hide Pi's working loader while an interactive gate owns the screen. */
export async function withHiddenWorking<T>(
	ctx: WorkingVisibilityContext,
	runGate: () => Promise<T>,
): Promise<T> {
	if (!ctx.hasUI) return runGate();

	ctx.ui.setWorkingVisible(false);
	try {
		return await runGate();
	} finally {
		ctx.ui.setWorkingVisible(true);
	}
}
