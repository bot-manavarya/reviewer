import * as core from '@actions/core';
import * as github from '@actions/github';

const STATE_BRANCH = 'manavarya-bot-state';
const COUNTER_PATH = '.counters.json';

type Octokit = ReturnType<typeof github.getOctokit>;

interface Counters {
  [dateUtc: string]: number;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {}
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 2000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const retryable =
        msg.includes('429') ||
        msg.includes('503') ||
        msg.includes('504') ||
        /temporar|timeout|ETIMEDOUT|ECONNRESET/i.test(msg);
      if (!retryable || i === attempts - 1) throw e;
      const delay = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 500);
      core.info(`retry ${i + 1}/${attempts - 1} in ${delay}ms (${msg.slice(0, 120)})`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Per-repo daily counter stored on an orphan branch in the target repo
 * (`manavarya-bot-state`). Atomic via ETag check to survive concurrent runs.
 */
export async function checkAndIncrementDaily(
  octokit: Octokit,
  owner: string,
  repo: string,
  maxPerDay: number
): Promise<{ allowed: boolean; used: number; limit: number }> {
  const today = todayUtc();
  let sha: string | undefined;
  let counters: Counters = {};

  try {
    const res = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: COUNTER_PATH,
      ref: STATE_BRANCH,
    });
    const data = res.data as { type?: string; sha?: string; content?: string; encoding?: string };
    if (data.type === 'file' && data.content) {
      sha = data.sha;
      const raw = Buffer.from(data.content, 'base64').toString('utf8');
      try {
        counters = JSON.parse(raw);
      } catch {
        counters = {};
      }
    }
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status !== 404) throw e;
    // Counter file not found — either branch missing or first run. We'll
    // create both below.
  }

  // Prune all dates except today to keep the file small.
  const used = counters[today] ?? 0;
  if (used >= maxPerDay) {
    return { allowed: false, used, limit: maxPerDay };
  }

  counters = { [today]: used + 1 };
  const newContent = Buffer.from(JSON.stringify(counters)).toString('base64');

  try {
    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      branch: STATE_BRANCH,
      path: COUNTER_PATH,
      message: `chore(manavarya-bot): counter ${today}=${used + 1}`,
      content: newContent,
      sha,
      committer: {
        name: 'bot-manavarya',
        email: '277266521+bot-manavarya@users.noreply.github.com',
      },
      author: {
        name: 'bot-manavarya',
        email: '277266521+bot-manavarya@users.noreply.github.com',
      },
    });
  } catch (e) {
    const status = (e as { status?: number }).status;
    // 422 typically means the branch doesn't exist yet; create it off the
    // default branch's HEAD as an orphan-ish placeholder (we just need any
    // commit there).
    if (status === 422 || status === 404) {
      try {
        await ensureStateBranch(octokit, owner, repo);
        await octokit.rest.repos.createOrUpdateFileContents({
          owner,
          repo,
          branch: STATE_BRANCH,
          path: COUNTER_PATH,
          message: `chore(manavarya-bot): init counter ${today}=1`,
          content: newContent,
          committer: {
            name: 'bot-manavarya',
            email: '277266521+bot-manavarya@users.noreply.github.com',
          },
          author: {
            name: 'bot-manavarya',
            email: '277266521+bot-manavarya@users.noreply.github.com',
          },
        });
      } catch (inner) {
        // If even branch-init fails, don't block the review — just log.
        core.warning(
          `rate-limit: couldn't persist counter (${
            inner instanceof Error ? inner.message : String(inner)
          }). Proceeding without daily cap.`
        );
      }
    } else {
      core.warning(
        `rate-limit: counter write failed (${
          e instanceof Error ? e.message : String(e)
        }). Proceeding without daily cap.`
      );
    }
  }

  return { allowed: true, used: used + 1, limit: maxPerDay };
}

async function ensureStateBranch(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<void> {
  try {
    await octokit.rest.repos.getBranch({ owner, repo, branch: STATE_BRANCH });
    return;
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
  }
  const { data: repoInfo } = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = repoInfo.default_branch;
  const { data: ref } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${defaultBranch}`,
  });
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${STATE_BRANCH}`,
    sha: ref.object.sha,
  });
}
