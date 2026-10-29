export type NotifyLevel = "info" | "warning" | "error";

export type NotifyContext = {
	mode?: string;
	ui?: {
		notify?: (message: string, level: NotifyLevel) => void;
	};
};

/**
 * T3 Code's Pi RPC bridge currently renders every Pi notify event as a warning,
 * regardless of its level. Drop routine info toasts in RPC mode rather than
 * presenting normal OM progress as an error-like warning.
 */
export function notifyOm(
	ctx: NotifyContext,
	message: string,
	level: NotifyLevel,
	options: { showInfoInRpc?: boolean } = {},
): void {
	if (ctx.mode === "rpc" && level === "info" && options.showInfoInRpc !== true) return;
	ctx.ui?.notify?.(message, level);
}

export function omNotifier(ctx: NotifyContext): (message: string, level: NotifyLevel) => void {
	return (message, level) => notifyOm(ctx, message, level);
}
