// Plain text files for the Ordliste import and export (DESK-68).
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

const TEXT_FILTER = [{ name: "Tekst", extensions: ["txt"] }];

/** Lets the user pick a text file and returns its content, or null. */
export async function importTextFile(): Promise<string | null> {
  try {
    const path = await open({
      multiple: false,
      directory: false,
      filters: TEXT_FILTER,
    });
    if (!path || Array.isArray(path)) return null;
    return await readTextFile(path);
  } catch (e) {
    console.warn("Import failed:", e);
    return null;
  }
}

export type ExportResult = "saved" | "copied" | "cancelled" | "failed";

/** Saves `text` where the user chooses. If the file cannot be written, the
 *  text goes to the clipboard instead, so the export is never lost. */
export async function exportTextFile(
  defaultName: string,
  text: string,
): Promise<ExportResult> {
  let path: string | null = null;
  try {
    path = await save({ defaultPath: defaultName, filters: TEXT_FILTER });
  } catch {
    path = null;
  }
  if (!path) return "cancelled";
  try {
    await writeTextFile(path, text);
    return "saved";
  } catch (e) {
    console.warn("Export failed, copying instead:", e);
    try {
      await navigator.clipboard.writeText(text);
      return "copied";
    } catch {
      return "failed";
    }
  }
}
