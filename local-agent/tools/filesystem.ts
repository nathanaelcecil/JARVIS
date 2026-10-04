/**
 * Filesystem tools — read-only operations on the local filesystem.
 * No delete/move in this phase.
 */

import { execSync } from "child_process";
import { readdirSync, statSync, readFileSync } from "fs";
import { join, resolve, basename, extname } from "path";
import { homedir } from "os";

const HOME = homedir();

/** Resolve ~ to home directory */
function resolvePath(p: string): string {
  const expanded = p.startsWith("~") ? join(HOME, p.slice(1)) : p;
  return resolve(expanded);
}

/** List files and directories in a path */
export function listDirectory(args: { path: string }): {
  success: boolean;
  path: string;
  entries: Array<{ name: string; type: "file" | "directory"; size?: number }>;
  error?: string;
} {
  try {
    const dirPath = resolvePath(args.path);
    const entries = readdirSync(dirPath, { withFileTypes: true }).map((e) => {
      const entryPath = join(dirPath, e.name);
      const result: { name: string; type: "file" | "directory"; size?: number } = {
        name: e.name,
        type: e.isDirectory() ? "directory" : "file",
      };
      if (e.isFile()) {
        try {
          result.size = statSync(entryPath).size;
        } catch {
          // ignore
        }
      }
      return result;
    });

    return { success: true, path: dirPath, entries };
  } catch (err) {
    return {
      success: false,
      path: args.path,
      entries: [],
      error: `Cannot list directory: ${err instanceof Error ? err.message : err}`,
    };
  }
}

/** Search for files by name pattern (glob-like) within a directory tree */
export function searchFiles(args: {
  path: string;
  pattern: string;
  maxResults?: number;
}): {
  success: boolean;
  results: Array<{ path: string; name: string }>;
  error?: string;
} {
  try {
    const searchPath = resolvePath(args.path);
    const pattern = args.pattern.toLowerCase();
    const max = args.maxResults ?? 50;
    const results: Array<{ path: string; name: string }> = [];

    function walk(dir: string, depth: number) {
      if (depth > 8 || results.length >= max) return;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (results.length >= max) break;
          if (e.name.startsWith(".") && depth > 0) continue; // skip hidden dirs after root
          const fullPath = join(dir, e.name);
          if (e.name.toLowerCase().includes(pattern)) {
            results.push({ path: fullPath, name: e.name });
          }
          if (e.isDirectory()) {
            walk(fullPath, depth + 1);
          }
        }
      } catch {
        // skip directories we can't read
      }
    }

    walk(searchPath, 0);
    return { success: true, results };
  } catch (err) {
    return {
      success: false,
      results: [],
      error: `Search failed: ${err instanceof Error ? err.message : err}`,
    };
  }
}

/** Open a file or folder in Finder */
export function openInFinder(args: { path: string }): {
  success: boolean;
  path: string;
  error?: string;
} {
  try {
    const targetPath = resolvePath(args.path);
    execSync(`open "${targetPath}"`, { timeout: 5000, stdio: "pipe" });
    return { success: true, path: targetPath };
  } catch (err) {
    return {
      success: false,
      path: args.path,
      error: `Cannot open in Finder: ${err instanceof Error ? err.message : err}`,
    };
  }
}

/** Get basic metadata about a file or directory */
export function getFileMetadata(args: { path: string }): {
  success: boolean;
  path: string;
  metadata?: {
    name: string;
    type: string;
    size: number;
    created: string;
    modified: string;
    permissions: string;
  };
  error?: string;
} {
  try {
    const targetPath = resolvePath(args.path);
    const stat = statSync(targetPath);
    return {
      success: true,
      path: targetPath,
      metadata: {
        name: basename(targetPath),
        type: stat.isDirectory() ? "directory" : extname(targetPath) || "file",
        size: stat.size,
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        permissions: (stat.mode & 0o777).toString(8),
      },
    };
  } catch (err) {
    return {
      success: false,
      path: args.path,
      error: `Cannot get metadata: ${err instanceof Error ? err.message : err}`,
    };
  }
}
