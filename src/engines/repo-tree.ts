import * as fs from 'fs';
import * as path from 'path';

export interface RepoTreeNode {
  name: string;
  type: 'file' | 'directory';
  children?: RepoTreeNode[];
  size?: number;
}

export class RepoTreeGenerator {
  private repoRoot: string;
  private maxDepth: number;
  private ignorePatterns: Set<string>;

  constructor(repoRoot: string, options: { maxDepth?: number; ignorePatterns?: string[] } = {}) {
    this.repoRoot = repoRoot;
    this.maxDepth = options.maxDepth ?? 5;
    this.ignorePatterns = new Set(
      options.ignorePatterns ?? ['.git', 'node_modules', 'dist', 'coverage', '.next', '.vscode']
    );
  }

  public generate(): RepoTreeNode {
    return this.walk(this.repoRoot, 0);
  }

  private walk(dirPath: string, depth: number): RepoTreeNode {
    const stats = fs.statSync(dirPath);
    const name = path.basename(dirPath) || path.basename(this.repoRoot);

    if (depth > this.maxDepth || this.ignorePatterns.has(name) || !stats.isDirectory()) {
      return {
        name,
        type: stats.isDirectory() ? 'directory' : 'file',
        size: stats.isDirectory() ? undefined : stats.size,
      };
    }

    try {
      const entries = fs.readdirSync(dirPath);
      const children: RepoTreeNode[] = [];

      for (const entry of entries) {
        if (this.ignorePatterns.has(entry)) continue;
        const entryPath = path.join(dirPath, entry);
        try {
          children.push(this.walk(entryPath, depth + 1));
        } catch {
          // ignore unreadable files
        }
      }

      // Sort directories first, then alphabetically
      children.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      return {
        name,
        type: 'directory',
        children,
      };
    } catch {
      return { name, type: 'directory' };
    }
  }
}
