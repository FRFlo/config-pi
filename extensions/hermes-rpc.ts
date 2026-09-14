/** Dependency-free dialogs shared by Pi extensions used through Hermes RPC. */
export type HermesDialogContext = {
  mode?: string;
  hasUI?: boolean;
  ui: {
    input(title: string, placeholder?: string, dialogOptions?: { signal?: AbortSignal }): Promise<string | undefined>;
    select(title: string, choices: string[], dialogOptions?: { signal?: AbortSignal }): Promise<string | undefined>;
    confirm(title: string, message: string, dialogOptions?: { signal?: AbortSignal }): Promise<boolean>;
  };
};

export function isHermesRpc(ctx: { mode?: string } | undefined): boolean {
  return ctx?.mode === "rpc";
}

export async function hermesInput(ctx: HermesDialogContext, title: string, placeholder?: string, signal?: AbortSignal) {
  return ctx.ui.input(title, placeholder, { signal });
}

export async function hermesSelect(ctx: HermesDialogContext, title: string, options: string[], signal?: AbortSignal) {
  return ctx.ui.select(title, options, { signal });
}

export async function hermesConfirm(ctx: HermesDialogContext, title: string, message: string, signal?: AbortSignal) {
  return ctx.ui.confirm(title, message, { signal });
}

export default function hermesRpcApi(): void {}
