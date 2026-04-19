import * as github from '@actions/github';
import { BOT_MARKER } from './markdown';
import type { Issue } from './schema';
import { isLineInDiff, parseDiff, type DiffIndex } from './diff';

type Octokit = ReturnType<typeof github.getOctokit>;

export interface PrContext {
  owner: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  prBody: string;
  headSha: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  diff: string;
  files: Array<{ path: string; truncated: boolean; content: string }>;
  touchedPaths: string[];
  hasTestChanges: boolean;
}

const TEST_PATH_RX = /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|\.(test|spec)\.[jt]sx?$/i;
const BINARY_EXT_RX =
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|tgz|mp3|mp4|mov|wav|woff2?|ttf|otf|eot|bin|exe|dll|so|dylib)$/i;

export async function fetchPrContext(
  octokit: Octokit,
  maxFileBytes: number,
  maxTotalBytes: number
): Promise<PrContext> {
  const ctx = github.context;
  let pr = ctx.payload.pull_request as
    | {
        number: number;
        title?: string;
        body?: string;
        head: { sha: string };
      }
    | undefined;

  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;

  // issue_comment events don't ship a pull_request payload — fetch it.
  if (!pr && ctx.payload.issue?.pull_request) {
    const issueNumber = ctx.payload.issue.number;
    const { data } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: issueNumber,
    });
    pr = {
      number: data.number,
      title: data.title,
      body: data.body ?? '',
      head: { sha: data.head.sha },
    };
  }

  if (!pr) throw new Error('This action must run on a pull_request or pr comment event.');

  const prNumber = pr.number;
  const headSha: string = pr.head.sha;

  const diffRes = await octokit.request(
    'GET /repos/{owner}/{repo}/pulls/{pull_number}',
    {
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: 'diff' },
    }
  );
  const diff = (diffRes.data as unknown as string) ?? '';

  const prFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  let linesAdded = 0;
  let linesRemoved = 0;
  const touchedPaths: string[] = [];
  const candidateFiles: Array<{ path: string; status: string }> = [];
  for (const f of prFiles) {
    linesAdded += f.additions ?? 0;
    linesRemoved += f.deletions ?? 0;
    touchedPaths.push(f.filename);
    if (f.status === 'removed') continue;
    if (BINARY_EXT_RX.test(f.filename)) continue;
    candidateFiles.push({ path: f.filename, status: f.status });
  }

  const files: PrContext['files'] = [];
  let totalBytes = 0;
  for (const f of candidateFiles) {
    if (totalBytes >= maxTotalBytes) break;
    const content = await fetchFile(octokit, owner, repo, f.path, headSha);
    if (content === null) continue;
    let truncated = false;
    let clipped = content;
    if (clipped.length > maxFileBytes) {
      clipped = clipped.slice(0, maxFileBytes);
      truncated = true;
    }
    const budget = maxTotalBytes - totalBytes;
    if (clipped.length > budget) {
      clipped = clipped.slice(0, budget);
      truncated = true;
    }
    totalBytes += clipped.length;
    files.push({ path: f.path, truncated, content: clipped });
  }

  const hasTestChanges = touchedPaths.some((p) => TEST_PATH_RX.test(p));
  const diffClipped =
    diff.length > 60000 ? diff.slice(0, 60000) + '\n… (diff truncated)' : diff;

  return {
    owner,
    repo,
    prNumber,
    prTitle: pr.title ?? '',
    prBody: pr.body ?? '',
    headSha,
    filesChanged: prFiles.length,
    linesAdded,
    linesRemoved,
    diff: diffClipped,
    files,
    touchedPaths,
    hasTestChanges,
  };
}

async function fetchFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | null> {
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    const data = res.data as { type?: string; encoding?: string; content?: string };
    if (data.type !== 'file' || !data.content) return null;
    if (data.encoding === 'base64') {
      return Buffer.from(data.content, 'base64').toString('utf8');
    }
    return data.content;
  } catch {
    return null;
  }
}

export async function upsertReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> {
  const existing = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  const prior = existing.find((c) => (c.body ?? '').includes(BOT_MARKER));
  if (prior) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: prior.id,
      body,
    });
    return;
  }
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

export async function postInlineReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  diff: string,
  issues: Issue[],
  summary: string
): Promise<{ posted: number; orphans: Issue[] }> {
  const diffIdx = parseDiff(diff);
  const lineable = issues.filter(
    (i) =>
      i.severity !== 'SUGGESTION' &&
      i.line > 0 &&
      isLineInDiff(diffIdx, i.file, i.line)
  );
  const orphans = issues.filter((i) => !lineable.includes(i));

  if (lineable.length === 0) return { posted: 0, orphans };

  const comments = lineable.map((i) => ({
    path: i.file,
    line: i.line,
    side: 'RIGHT' as const,
    body: renderInlineBody(i),
  }));

  await dismissPriorBotReviews(octokit, owner, repo, prNumber);

  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    commit_id: headSha,
    event: 'COMMENT',
    body: summary,
    comments,
  });

  return { posted: lineable.length, orphans };
}

function renderInlineBody(i: Issue): string {
  const tag =
    i.severity === 'CRITICAL' ? '**CRITICAL**' : '**WARNING**';
  return [
    `${tag} — ${i.issue}`,
    '',
    `**Why:** ${i.why}`,
    `**Fix:** ${i.fix}`,
    `_confidence: ${i.confidence.toFixed(2)}_`,
  ].join('\n');
}

async function dismissPriorBotReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  try {
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    const mine = reviews.filter(
      (r) =>
        r.user?.login?.toLowerCase() === 'bot-manavarya' &&
        r.state !== 'DISMISSED' &&
        r.state !== 'APPROVED' &&
        r.state !== 'CHANGES_REQUESTED'
    );
    for (const r of mine) {
      const comments = await octokit.paginate(
        octokit.rest.pulls.listCommentsForReview,
        { owner, repo, pull_number: prNumber, review_id: r.id, per_page: 100 }
      );
      for (const c of comments) {
        await octokit.rest.pulls
          .deleteReviewComment({ owner, repo, comment_id: c.id })
          .catch(() => {});
      }
    }
  } catch {
    // best effort
  }
}

export async function applyLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  labels: string[]
): Promise<void> {
  if (labels.length === 0) return;
  try {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels,
    });
  } catch (e) {
    // Labels don't exist yet — create them, then retry.
    for (const name of labels) {
      await octokit.rest.issues
        .createLabel({
          owner,
          repo,
          name,
          color: colorFor(name),
          description: 'Set by manavarya-bot',
        })
        .catch(() => {});
    }
    await octokit.rest.issues
      .addLabels({ owner, repo, issue_number: prNumber, labels })
      .catch(() => {});
  }
}

function colorFor(label: string): string {
  if (label.startsWith('risk:high')) return 'b60205';
  if (label.startsWith('risk:med')) return 'fbca04';
  if (label.startsWith('risk:low')) return '0e8a16';
  if (label.startsWith('needs-tests')) return 'f9d0c4';
  if (label.startsWith('security')) return '5319e7';
  if (label.startsWith('size:xl')) return 'c5def5';
  return 'ededed';
}

export function diffIndexFromString(diff: string): DiffIndex {
  return parseDiff(diff);
}
