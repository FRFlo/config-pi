import { promises as fs } from "node:fs";
import path from "node:path";

export type InsertMode = "append" | "prepend" | "after_line" | "before_line";

export interface MoveCodeArgs {
  source_file: string;
  destination_file: string;
  start_line?: number;
  end_line?: number;
  insert_mode?: InsertMode;
  insert_line?: number;
  adjust_indentation?: boolean;
  dry_run?: boolean;
}

export interface MoveCodeContext {
  worktree: string;
  mutateFiles?: <T>(filePaths: string[], run: () => Promise<T>) => Promise<T>;
}

export interface MoveCodeResult {
  dry_run: boolean;
  moved: boolean;
  source_file: string;
  destination_file: string;
  removed_lines: string;
  inserted_at: string;
  same_file: boolean;
  preview: {
    removed_text: string;
    inserted_text: string;
  };
  warnings: string[];
}

export interface FileWrite {
  filePath: string;
  content: string;
}

interface TextLine {
  text: string;
  eol: string;
}

interface TextDocument {
  lines: TextLine[];
  newline: string;
}

interface SelectedBlock {
  startIndex: number;
  endIndexExclusive: number;
  lines: TextLine[];
  label: string;
}

interface InsertionPoint {
  index: number;
  label: string;
}

interface PreparedMove {
  sourcePath: string;
  destinationPath: string;
  newSourceText: string;
  newDestinationText: string;
  selected: SelectedBlock;
  insertedText: string;
  insertion: InsertionPoint;
  sameFile: boolean;
  warnings: string[];
}

interface BackupRecord {
  filePath: string;
  backupPath: string;
  tempPath: string;
  existed: boolean;
}

export class MoveToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoveToolError";
  }
}

export async function moveCode(args: MoveCodeArgs, context: MoveCodeContext): Promise<MoveCodeResult> {
  const prepared = await prepareMove(args, context);
  const dryRun = args.dry_run ?? true;

  if (!dryRun) {
    const writes = prepared.sameFile
      ? [{ filePath: prepared.sourcePath, content: prepared.newSourceText }]
      : [
          { filePath: prepared.destinationPath, content: prepared.newDestinationText },
          { filePath: prepared.sourcePath, content: prepared.newSourceText },
        ];
    const write = () => applyFileWrites(writes);
    if (context.mutateFiles) await context.mutateFiles(writes.map((item) => item.filePath), write);
    else await write();
  }

  return {
    dry_run: dryRun,
    moved: !dryRun,
    source_file: prepared.sourcePath,
    destination_file: prepared.destinationPath,
    removed_lines: prepared.selected.label,
    inserted_at: prepared.insertion.label,
    same_file: prepared.sameFile,
    preview: {
      removed_text: stringifyLines(prepared.selected.lines),
      inserted_text: prepared.insertedText,
    },
    warnings: prepared.warnings,
  };
}

export async function prepareMove(args: MoveCodeArgs, context: MoveCodeContext): Promise<PreparedMove> {
  validateArgs(args);

  const worktreePath = await canonicalWorktree(context.worktree);
  const sourcePath = await resolveWorkspacePath(args.source_file, worktreePath, "source_file", true);
  const destinationPath = await resolveWorkspacePath(args.destination_file, worktreePath, "destination_file", false);
  const sameFile = samePath(sourcePath, destinationPath);

  const sourceText = await readRequiredFile(sourcePath, "source_file");
  const destinationText = sameFile ? sourceText : await readOptionalFile(destinationPath);
  const sourceDocument = parseText(sourceText);
  const destinationDocument = sameFile ? sourceDocument : parseText(destinationText);
  const selected = selectBlock(args, sourceDocument);
  const insertion = getInsertion(args, destinationDocument);

  if (sameFile && insertion.index >= selected.startIndex && insertion.index <= selected.endIndexExclusive) {
    throw new MoveToolError(
      `${insertion.label} is inside or adjacent to the moved range (${selected.label}); choose a location outside the block.`,
    );
  }

  const selectedLines = cloneLines(selected.lines);
  const insertedLines = args.adjust_indentation
    ? reindentLines(selectedLines, getTargetIndent(destinationDocument.lines, insertion.index))
    : selectedLines;
  const warnings = args.adjust_indentation
    ? ["adjust_indentation is best-effort and only changes leading whitespace; imports and semantic refactors remain manual."]
    : ["Text was relocated only; review imports, exports, formatting, and references manually."];

  if (sameFile) {
    const updatedLines = cloneLines(sourceDocument.lines);
    updatedLines.splice(selected.startIndex, selected.endIndexExclusive - selected.startIndex);
    const adjustedInsertionIndex = insertion.index > selected.startIndex
      ? insertion.index - (selected.endIndexExclusive - selected.startIndex)
      : insertion.index;
    insertLinesWithBoundaries(updatedLines, adjustedInsertionIndex, insertedLines, sourceDocument.newline);
    const updatedText = stringifyLines(updatedLines);

    return {
      sourcePath,
      destinationPath,
      newSourceText: updatedText,
      newDestinationText: updatedText,
      selected,
      insertedText: stringifyLines(insertedLines),
      insertion,
      sameFile,
      warnings,
    };
  }

  const newSourceLines = cloneLines(sourceDocument.lines);
  newSourceLines.splice(selected.startIndex, selected.endIndexExclusive - selected.startIndex);
  const newDestinationLines = cloneLines(destinationDocument.lines);
  const destinationInsertedLines = normalizeInsertedLineEndings(insertedLines, destinationDocument.newline);
  insertLinesWithBoundaries(newDestinationLines, insertion.index, destinationInsertedLines, destinationDocument.newline);

  return {
    sourcePath,
    destinationPath,
    newSourceText: stringifyLines(newSourceLines),
    newDestinationText: stringifyLines(newDestinationLines),
    selected,
    insertedText: stringifyLines(destinationInsertedLines),
    insertion,
    sameFile,
    warnings,
  };
}

export async function applyFileWrites(
  writes: FileWrite[],
  options: { failAfterWrites?: number } = {},
): Promise<void> {
  const deduped = dedupeWrites(writes);
  const token = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const backups: BackupRecord[] = [];
  let completedWrites = 0;

  try {
    for (const write of deduped) {
      const directory = path.dirname(write.filePath);
      await fs.mkdir(directory, { recursive: true });

      const tempPath = path.join(directory, `.${path.basename(write.filePath)}.pi-move-${token}.tmp`);
      const backupPath = path.join(directory, `.${path.basename(write.filePath)}.pi-move-${token}.bak`);
      const existed = await fileExists(write.filePath);

      if (existed) {
        await fs.copyFile(write.filePath, backupPath);
      }

      backups.push({ filePath: write.filePath, backupPath, tempPath, existed });
      await fs.writeFile(tempPath, write.content, "utf8");
      await fs.copyFile(tempPath, write.filePath);
      await fs.rm(tempPath, { force: true });
      completedWrites += 1;

      if (options.failAfterWrites !== undefined && completedWrites >= options.failAfterWrites) {
        throw new MoveToolError("Injected write failure for rollback verification.");
      }
    }
  } catch (error) {
    await restoreBackups(backups);
    throw error;
  } finally {
    await cleanupBackups(backups);
  }
}

function validateArgs(args: MoveCodeArgs): void {
  if (!args.source_file?.trim()) throw new MoveToolError("source_file is required.");
  if (!args.destination_file?.trim()) throw new MoveToolError("destination_file is required.");

  if (!isPositiveInteger(args.start_line)) throw new MoveToolError("start_line is required.");
  if (args.end_line !== undefined && (!isPositiveInteger(args.end_line) || args.end_line < args.start_line)) {
    throw new MoveToolError("end_line must be greater than or equal to start_line.");
  }

  const insertMode = args.insert_mode ?? "append";
  if (!["append", "prepend", "after_line", "before_line"].includes(insertMode)) {
    throw new MoveToolError("insert_mode must be append, prepend, after_line, or before_line.");
  }
  if ((insertMode === "after_line" || insertMode === "before_line") && !isPositiveInteger(args.insert_line)) {
    throw new MoveToolError(`${insertMode} requires insert_line.`);
  }
  if ((insertMode === "append" || insertMode === "prepend") && args.insert_line !== undefined) {
    throw new MoveToolError("insert_line is only valid with insert_mode='after_line' or 'before_line'.");
  }
}

async function canonicalWorktree(worktree: string): Promise<string> {
  const resolved = path.resolve(worktree);
  try {
    return await fs.realpath(resolved);
  } catch (error) {
    throw new MoveToolError(`Unable to resolve worktree '${worktree}': ${formatError(error)}`);
  }
}

async function resolveWorkspacePath(input: string, worktree: string, fieldName: string, mustExist: boolean): Promise<string> {
  const lexicalPath = path.resolve(path.isAbsolute(input) ? input : path.join(worktree, input));
  assertContained(lexicalPath, worktree, fieldName, input);

  if (await fileExists(lexicalPath)) {
    const realFilePath = await fs.realpath(lexicalPath);
    assertContained(realFilePath, worktree, fieldName, input);
    return realFilePath;
  }

  if (mustExist) {
    throw new MoveToolError(`${fieldName} does not exist: ${input}`);
  }

  const parent = await nearestExistingParent(path.dirname(lexicalPath), worktree);
  const realParent = await fs.realpath(parent);
  assertContained(realParent, worktree, fieldName, input);
  return lexicalPath;
}

function assertContained(candidate: string, worktree: string, fieldName: string, originalInput: string): void {
  const relative = path.relative(normalizeForCompare(worktree), normalizeForCompare(candidate));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new MoveToolError(`${fieldName} must stay inside the current project: ${originalInput}`);
}

async function nearestExistingParent(start: string, worktree: string): Promise<string> {
  let current = path.resolve(start);
  const root = path.parse(current).root;

  while (!(await fileExists(current))) {
    if (samePath(current, root)) throw new MoveToolError(`No existing parent directory for destination: ${start}`);
    current = path.dirname(current);
  }

  assertContained(current, worktree, "destination_file", start);
  return current;
}

async function readRequiredFile(filePath: string, fieldName: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new MoveToolError(`Unable to read ${fieldName} '${filePath}': ${formatError(error)}`);
  }
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "";
    throw new MoveToolError(`Unable to read destination_file '${filePath}': ${formatError(error)}`);
  }
}

function parseText(text: string): TextDocument {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const matches = text.matchAll(/([^\r\n]*)(\r\n|\n|$)/g);
  const lines: TextLine[] = [];

  for (const match of matches) {
    const fullMatch = match[0];
    if (fullMatch === "") continue;
    lines.push({ text: match[1] ?? "", eol: match[2] ?? "" });
  }

  return { lines, newline };
}

function stringifyLines(lines: TextLine[]): string {
  return lines.map((line) => `${line.text}${line.eol}`).join("");
}

function selectBlock(args: MoveCodeArgs, source: TextDocument): SelectedBlock {
  const startLine = requireNumber(args.start_line, "start_line");
  const endLine = args.end_line ?? startLine;
  if (startLine > source.lines.length || endLine > source.lines.length) {
    throw new MoveToolError(`line_range ${startLine}-${endLine} is outside source line count ${source.lines.length}.`);
  }

  return {
    startIndex: startLine - 1,
    endIndexExclusive: endLine,
    lines: cloneLines(source.lines.slice(startLine - 1, endLine)),
    label: `${startLine}-${endLine}`,
  };
}

function getInsertion(args: MoveCodeArgs, destination: TextDocument): InsertionPoint {
  const insertMode = args.insert_mode ?? "append";
  if (insertMode === "prepend") return { index: 0, label: "start of destination_file" };
  if (insertMode === "append") return { index: destination.lines.length, label: "end of destination_file" };

  const insertLine = requireNumber(args.insert_line, "insert_line");
  if (destination.lines.length === 0) {
    throw new MoveToolError(`${insertMode} cannot target an empty destination_file; use append or prepend.`);
  }
  if (insertLine > destination.lines.length) {
    throw new MoveToolError(`insert_line ${insertLine} is outside destination line count ${destination.lines.length}.`);
  }

  return insertMode === "after_line"
    ? { index: insertLine, label: `after original line ${insertLine}` }
    : { index: insertLine - 1, label: `before original line ${insertLine}` };
}

function reindentLines(lines: TextLine[], targetIndent: string): TextLine[] {
  const indents = lines.filter((line) => line.text.trim().length > 0).map((line) => leadingWhitespace(line.text));
  if (indents.length === 0) return cloneLines(lines);

  const commonIndent = commonWhitespacePrefix(indents);
  return lines.map((line) => {
    if (line.text.trim().length === 0) return { ...line };
    return { text: `${targetIndent}${line.text.slice(commonIndent.length)}`, eol: line.eol };
  });
}

function normalizeInsertedLineEndings(lines: TextLine[], newline: string): TextLine[] {
  return lines.map((line) => ({ text: line.text, eol: line.eol ? newline : "" }));
}

function insertLinesWithBoundaries(
  targetLines: TextLine[],
  insertionIndex: number,
  insertedLines: TextLine[],
  newline: string,
): void {
  if (insertedLines.length === 0) return;

  const previousLine = targetLines[insertionIndex - 1];
  if (previousLine && previousLine.eol === "") {
    previousLine.eol = newline;
  }

  const nextLine = targetLines[insertionIndex];
  const lastInsertedLine = insertedLines[insertedLines.length - 1];
  if (nextLine && lastInsertedLine.eol === "") {
    lastInsertedLine.eol = newline;
  }

  targetLines.splice(insertionIndex, 0, ...insertedLines);
}

function getTargetIndent(lines: TextLine[], insertionIndex: number): string {
  return leadingWhitespace(lines[insertionIndex]?.text ?? lines[insertionIndex - 1]?.text ?? "");
}

function cloneLines(lines: TextLine[]): TextLine[] {
  return lines.map((line) => ({ ...line }));
}

function leadingWhitespace(text: string): string {
  return /^\s*/.exec(text)?.[0] ?? "";
}

function commonWhitespacePrefix(values: string[]): string {
  let prefix = values[0] ?? "";
  for (const value of values.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index] === value[index]) index += 1;
    prefix = prefix.slice(0, index);
  }
  return prefix;
}

function dedupeWrites(writes: FileWrite[]): FileWrite[] {
  return [...new Map(writes.map((write) => [write.filePath, write])).values()];
}

async function restoreBackups(backups: BackupRecord[]): Promise<void> {
  for (const backup of [...backups].reverse()) {
    try {
      if (backup.existed) await fs.copyFile(backup.backupPath, backup.filePath);
      else await fs.rm(backup.filePath, { force: true });
    } catch {
      // Best-effort rollback; preserve the original write error for the caller.
    }
  }
}

async function cleanupBackups(backups: BackupRecord[]): Promise<void> {
  await Promise.all(
    backups.flatMap((backup) => [
      fs.rm(backup.tempPath, { force: true }).catch(() => undefined),
      fs.rm(backup.backupPath, { force: true }).catch(() => undefined),
    ]),
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  return normalizeForCompare(left) === normalizeForCompare(right);
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPositiveInteger(value: number | undefined): value is number {
  return Number.isInteger(value) && value !== undefined && value >= 1;
}

function requireNumber(value: number | undefined, fieldName: string): number {
  if (value === undefined) throw new MoveToolError(`${fieldName} is required.`);
  return value;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
