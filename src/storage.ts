import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "./paths.js";

function ensureParentDir(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
}

export function readTextFile(path: string): string | null {
	if (!existsSync(path)) return null;
	return readFileSync(path, "utf-8");
}

export function writeTextFileAtomic(path: string, contents: string): void {
	ensureParentDir(path);
	const tempPath = `${path}.tmp`;
	writeFileSync(tempPath, contents, "utf-8");
	renameSync(tempPath, path);
}

export function readJsonFile<T>(path: string): T | null {
	const raw = readTextFile(path);
	if (!raw) return null;
	return JSON.parse(raw) as T;
}

export function writeJsonFileAtomic(path: string, value: unknown): void {
	writeTextFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function getBackupDir(): string {
	const dir = join(getConfigDir(), "backups");
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function backupFile(path: string, label: string): string | null {
	if (!existsSync(path)) return null;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = join(getBackupDir(), `${label}-${stamp}.bak`);
	writeTextFileAtomic(backupPath, readFileSync(path, "utf-8"));
	return backupPath;
}

export function listBackups(): string[] {
	const dir = getBackupDir();
	return readdirSync(dir)
		.filter((name) => name.endsWith(".bak"))
		.sort()
		.reverse()
		.map((name) => join(dir, name));
}

export function removeFileIfExists(path: string): void {
	if (existsSync(path)) rmSync(path);
}
