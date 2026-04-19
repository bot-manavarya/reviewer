/**
 * Parse a unified diff into a per-file map of line numbers that are
 * available for inline review comments. GitHub only accepts inline
 * comments on lines that appear in the diff.
 */
export interface DiffIndex {
  rightLines: Map<string, Set<number>>;
}

export function parseDiff(diff: string): DiffIndex {
  const rightLines = new Map<string, Set<number>>();
  const lines = diff.split('\n');

  let currentPath: string | null = null;
  let rightLineNum = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      currentPath = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p === '/dev/null') {
        currentPath = null;
      } else {
        currentPath = p.startsWith('b/') ? p.slice(2) : p;
        if (!rightLines.has(currentPath)) rightLines.set(currentPath, new Set());
      }
      continue;
    }
    const hunkMatch = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
    if (hunkMatch) {
      rightLineNum = Number(hunkMatch[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !currentPath) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      rightLines.get(currentPath)!.add(rightLineNum);
      rightLineNum++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // deletion — doesn't advance right side
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
    } else {
      rightLines.get(currentPath)!.add(rightLineNum);
      rightLineNum++;
    }
  }

  return { rightLines };
}

export function isLineInDiff(
  idx: DiffIndex,
  path: string,
  line: number
): boolean {
  return idx.rightLines.get(path)?.has(line) ?? false;
}
