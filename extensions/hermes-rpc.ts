/** Dependency-free Pi RPC dialogs shared by Hermes and T3 Code's Pi provider. */
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

export function resolveRpcSelection(
  selected: string | undefined,
  optionLabels: readonly string[],
): { kind: "option"; index: number } | { kind: "other"; value: string } | null {
  if (selected === undefined) return null;
  const index = optionLabels.indexOf(selected);
  return index >= 0 ? { kind: "option", index } : { kind: "other", value: selected };
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
