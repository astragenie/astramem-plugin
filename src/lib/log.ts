/**
 * log.ts — fail-silent append-only ingest log.
 *
 * File: unifiedConfigDir()/ingest.log
 * Format: one JSON line per entry (newline-delimited JSON).
 *
 * Rotation rule:
 *   On each write, if the file currently exceeds 10 MB:
 *     - rename ingest.log → ingest.log.1  (overwrites any previous .1)
 *     - start a fresh ingest.log with the current entry
 *
 * All entries are scrubbed before writing.
 * Errors are swallowed — this is a fail-silent log.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { unifiedConfigDir } from './datadir.ts';
import { scrub } from './scrub.ts';

const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB

function logPath(): string {
  return join(unifiedConfigDir(), 'ingest.log');
}

function rotatedPath(): string {
  return join(unifiedConfigDir(), 'ingest.log.1');
}

/**
 * Append a JSON log line to the ingest log after scrubbing.
 * Silently ignores all I/O errors (fail-silent by design).
 *
 * On write, if the existing file is > 10 MB, the file is rotated:
 *   ingest.log → ingest.log.1, then a fresh ingest.log is created.
 */
export function appendIngestLog(entry: unknown): void {
  try {
    const dir = unifiedConfigDir();
    mkdirSync(dir, { recursive: true });

    const file = logPath();

    // Check size before appending — rotate if needed.
    try {
      const stat = statSync(file);
      if (stat.size > MAX_LOG_BYTES) {
        renameSync(file, rotatedPath());
      }
    } catch {
      // File doesn't exist yet — no rotation needed.
    }

    const scrubbed = scrub(entry);
    const line = JSON.stringify(scrubbed) + '\n';
    appendFileSync(file, line, 'utf-8');
  } catch {
    // Fail-silent: never propagate log errors to callers.
  }
}

/**
 * Read the last N lines from the ingest log.
 * Returns empty array if the log does not exist or is unreadable.
 */
export function readIngestLogTail(n: number): string[] {
  try {
    const file = logPath();
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}
