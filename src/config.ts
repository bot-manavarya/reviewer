import * as github from '@actions/github';
import YAML from 'yaml';
import type { Issue } from './schema';

type Octokit = ReturnType<typeof github.getOctokit>;

export interface RepoConfig {
  provider?: 'gemini' | 'ollama';
  model?: string;
  minConfidence?: number;
  maxDailyReviews?: number;
  ignorePaths?: string[];
  promptAddendum?: string;
  severityOverrides?: Record<string, Issue['severity']>;
  disableSecretScan?: boolean;
  disableInlineComments?: boolean;
  disableTestNudge?: boolean;
  autoApprove?: {
    riskAtMost?: number;
    qualityAtLeast?: number;
  };
  labels?: {
    risk?: boolean;
    needsTests?: boolean;
    securityReview?: boolean;
  };
}

const CONFIG_PATH = '.manavarya-bot.yml';

export async function loadRepoConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<RepoConfig> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: CONFIG_PATH,
      ref,
    });
    const file = data as { type?: string; content?: string; encoding?: string };
    if (file.type !== 'file' || !file.content) return {};
    const raw = Buffer.from(file.content, 'base64').toString('utf8');
    const parsed = YAML.parse(raw);
    return normalize(parsed);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return {};
    throw e;
  }
}

function normalize(raw: unknown): RepoConfig {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const camel = (snake: string) =>
    snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) out[camel(k)] = v;
  return out as RepoConfig;
}

export function pathIsIgnored(path: string, patterns: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => matchGlob(p, path));
}

function matchGlob(pattern: string, path: string): boolean {
  // Minimal glob: supports **, *, ?
  const rx = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '::GLOBSTAR::')
        .replace(/\*/g, '[^/]*')
        .replace(/::GLOBSTAR::/g, '.*')
        .replace(/\?/g, '.') +
      '$'
  );
  return rx.test(path);
}
