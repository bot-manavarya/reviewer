import * as core from '@actions/core';
import * as github from '@actions/github';
import YAML from 'yaml';

const BOT_PREFIX = '/bot';

type Octokit = ReturnType<typeof github.getOctokit>;

interface SlashCtx {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  actor: string;
  body: string;
}

export async function isSlashEvent(): Promise<boolean> {
  if (github.context.eventName !== 'issue_comment') return false;
  const body = (github.context.payload.comment?.body ?? '').trim();
  const issue = github.context.payload.issue;
  if (!issue?.pull_request) return false;
  return body.startsWith(BOT_PREFIX);
}

export async function handleSlash(octokit: Octokit): Promise<void> {
  const ctx = github.context;
  const body = (ctx.payload.comment?.body ?? '').trim();
  const actor = ctx.payload.comment?.user?.login ?? 'unknown';
  const issueNumber = ctx.payload.issue!.number;
  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;

  const sctx: SlashCtx = {
    octokit,
    owner,
    repo,
    prNumber: issueNumber,
    actor,
    body,
  };

  const cmd = parseCommand(body);
  core.info(`slash command from @${actor}: ${cmd.name} ${cmd.arg ?? ''}`);

  await react(octokit, ctx.payload.comment!.id, 'eyes');

  try {
    switch (cmd.name) {
      case 'help':
        await postReply(sctx, helpText());
        break;
      case 'approve':
        await handleApprove(sctx);
        break;
      case 'ignore':
        if (!cmd.arg) {
          await postReply(sctx, '`/bot ignore <path>` needs a path argument.');
          break;
        }
        await handleIgnore(sctx, cmd.arg);
        break;
      case 'explain':
        await postReply(
          sctx,
          cmd.arg
            ? `Deep-dive queued for \`${cmd.arg}\` — push any commit or use \`/bot review\` for a fresh audit.`
            : '`/bot explain <file>` needs a file path.'
        );
        break;
      case 'why':
        await postReply(
          sctx,
          'Push any new commit to this branch and I will re-review with a fresh pass.'
        );
        break;
      case 'review':
        (process as unknown as { _slashReview?: boolean })._slashReview = true;
        break;
      default:
        await postReply(sctx, `Unknown command: \`${cmd.name}\`\n\n${helpText()}`);
    }
    await react(octokit, ctx.payload.comment!.id, '+1');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await postReply(sctx, `Command failed: ${msg}`);
    await react(octokit, ctx.payload.comment!.id, '-1');
    throw e;
  }
}

export function shouldFallThroughToReview(): boolean {
  return (process as unknown as { _slashReview?: boolean })._slashReview === true;
}

function parseCommand(body: string): { name: string; arg?: string } {
  const trimmed = body.slice(BOT_PREFIX.length).trim();
  const [name, ...rest] = trimmed.split(/\s+/);
  return { name: (name || 'help').toLowerCase(), arg: rest.join(' ') || undefined };
}

async function postReply(
  { octokit, owner, repo, prNumber }: SlashCtx,
  body: string
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `_manavarya-bot:_ ${body}`,
  });
}

async function react(
  octokit: Octokit,
  commentId: number,
  content: '+1' | '-1' | 'eyes' | 'rocket'
): Promise<void> {
  try {
    await octokit.rest.reactions.createForIssueComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      comment_id: commentId,
      content,
    });
  } catch {
    // ignore
  }
}

async function handleApprove({
  octokit,
  owner,
  repo,
  prNumber,
  actor,
}: SlashCtx): Promise<void> {
  const { data: perm } = await octokit.rest.repos
    .getCollaboratorPermissionLevel({ owner, repo, username: actor })
    .catch(
      () =>
        ({ data: { permission: 'none' } }) as unknown as {
          data: { permission: string };
        }
    );
  if (!['admin', 'write'].includes(perm.permission)) {
    await postReply(
      { octokit, owner, repo, prNumber, actor, body: '' },
      'Only write-level collaborators can use `/bot approve`.'
    );
    return;
  }

  const last = await findLastAudit(octokit, owner, repo, prNumber);
  if (!last) {
    await postReply(
      { octokit, owner, repo, prNumber, actor, body: '' },
      'I have no recent audit on this PR — run `/bot review` first.'
    );
    return;
  }
  const riskMax = 3;
  const qualityMin = 85;
  if (last.risk > riskMax || last.quality < qualityMin) {
    await postReply(
      { octokit, owner, repo, prNumber, actor, body: '' },
      `Not approving — risk ${last.risk}/10 or quality ${last.quality}/100 does not meet thresholds (risk ≤ ${riskMax}, quality ≥ ${qualityMin}).`
    );
    return;
  }

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    commit_id: pr.head.sha,
    event: 'APPROVE',
    body: `Auto-approved via \`/bot approve\` by @${actor} — risk ${last.risk}/10, quality ${last.quality}/100.`,
  });
}

async function findLastAudit(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ risk: number; quality: number } | null> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  const marker = '<!-- manavarya-bot-review -->';
  const ours = comments.filter((c) => (c.body ?? '').includes(marker)).pop();
  if (!ours?.body) return null;
  const riskMatch = /Risk[^0-9]*?(\d{1,2})\/10/.exec(ours.body);
  const qualityMatch = /Quality[^0-9]*?(\d{1,3})\/100/.exec(ours.body);
  if (!riskMatch || !qualityMatch) return null;
  return {
    risk: Number(riskMatch[1]),
    quality: Number(qualityMatch[1]),
  };
}

async function handleIgnore(
  { octokit, owner, repo, prNumber, actor }: SlashCtx,
  path: string
): Promise<void> {
  const { data: perm } = await octokit.rest.repos
    .getCollaboratorPermissionLevel({ owner, repo, username: actor })
    .catch(
      () =>
        ({ data: { permission: 'none' } }) as unknown as {
          data: { permission: string };
        }
    );
  if (!['admin', 'write'].includes(perm.permission)) {
    await postReply(
      { octokit, owner, repo, prNumber, actor, body: '' },
      'Only write-level collaborators can use `/bot ignore`.'
    );
    return;
  }

  const configPath = '.manavarya-bot.yml';
  let sha: string | undefined;
  let existing: Record<string, unknown> = {};
  try {
    const res = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: configPath,
    });
    const d = res.data as { sha?: string; content?: string; encoding?: string };
    sha = d.sha;
    if (d.content && d.encoding === 'base64') {
      existing =
        (YAML.parse(Buffer.from(d.content, 'base64').toString('utf8')) as
          | Record<string, unknown>
          | null) ?? {};
    }
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
  }

  const current = Array.isArray(existing.ignore_paths)
    ? (existing.ignore_paths as string[])
    : [];
  if (current.includes(path)) {
    await postReply(
      { octokit, owner, repo, prNumber, actor, body: '' },
      `\`${path}\` is already in the ignore list.`
    );
    return;
  }
  current.push(path);
  existing.ignore_paths = current;

  const newContent = YAML.stringify(existing);
  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: configPath,
    message: `chore(manavarya-bot): ignore ${path} (by @${actor})`,
    content: Buffer.from(newContent).toString('base64'),
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
  await postReply(
    { octokit, owner, repo, prNumber, actor, body: '' },
    `Added \`${path}\` to \`.manavarya-bot.yml\` ignore list. Future reviews will skip it.`
  );
}

function helpText(): string {
  return [
    '**Commands:**',
    '- `/bot review` — re-run the audit',
    '- `/bot approve` — auto-approve if risk ≤ 3 and quality ≥ 85 (write-level only)',
    '- `/bot ignore <path>` — add a glob to `.manavarya-bot.yml` ignore list (write-level only)',
    '- `/bot explain <file>` — request a deeper pass on a file (next review)',
    '- `/bot why` — ask for re-explanation (push a commit to retry)',
    '- `/bot help` — this message',
  ].join('\n');
}
