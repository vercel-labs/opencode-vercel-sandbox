export type FileRequest = {
  operation: "read" | "write" | "edit" | "ls" | "glob" | "grep";
  path: string;
  content?: string;
  edits?: { oldString: string; newString: string; replaceAll?: boolean }[];
  offset?: number;
  limit?: number;
  pattern?: string;
  include?: string;
};

export async function fileWorker(input: FileRequest): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile);
  const bounded = (text: string) => text.length > 64_000 ? `${text.slice(0, 64_000)}\n[output truncated]` : text;
  if (input.operation === "ls") return bounded((await fs.readdir(input.path, { withFileTypes: true })).slice(0, 2000).map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).join("\n"));
  if (input.operation === "glob" || input.operation === "grep") {
    const args = input.operation === "glob"
      ? ["--files", "--hidden", "-g", "!.git", "-g", input.pattern ?? "*", "--", input.path]
      : ["--line-number", "--hidden", "--no-heading", "--max-count", "100", "-g", "!.git", ...(input.include ? ["-g", input.include] : []), "--", input.pattern ?? "", input.path];
    try { return bounded((await execute("rg", args, { timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout); }
    catch (error) {
      if ((error as { code?: number }).code === 1) return "No matches";
      throw new Error("Search failed or exceeded its output/time limit; narrow the query.");
    }
  }
  let content = input.content ?? "";
  if (input.operation === "read" || input.operation === "edit") {
    const metadata = await fs.stat(input.path);
    if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024) throw new Error("Read/edit requires a regular file smaller than 2 MiB.");
    const bytes = await fs.readFile(input.path);
    if (bytes.includes(0)) throw new Error("Binary file; use remote bash for binary operations.");
    content = bytes.toString("utf8");
  }
  if (input.operation === "read") {
    const offset = (input.offset ?? 1) - 1;
    return bounded(content.split("\n").slice(offset, offset + (input.limit ?? 2000)).map((line, index) => `${offset + index + 1}: ${line}`).join("\n"));
  }
  for (const edit of input.edits ?? []) {
    if (!edit.oldString || !content.includes(edit.oldString)) throw new Error("Edit text not found; read the file first.");
    if (!edit.replaceAll && content.indexOf(edit.oldString) !== content.lastIndexOf(edit.oldString)) throw new Error("Edit text is ambiguous; provide more context or replaceAll.");
    content = edit.replaceAll ? content.split(edit.oldString).join(edit.newString) : content.replace(edit.oldString, () => edit.newString);
  }
  await fs.mkdir(path.dirname(input.path), { recursive: true });
  await fs.writeFile(input.path, content);
  return `${input.operation === "write" ? "Wrote" : "Edited"} ${input.path}`;
}
