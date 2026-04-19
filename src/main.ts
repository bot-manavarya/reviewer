import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  fetchPrContext,
  upsertReviewComment,
  postInlineReview,
  applyLabels,
} from './github';
import * as ollama from './ollama';
import * as gemini from './gemini';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt';
import { parseReview } from './schema';
import { finalize } from './scoring';
import { renderMarkdown, renderFailureMarkdown } from './markdown';
import { checkAndIncrementDaily } from './ratelimit';
import { loadRepoConfig, pathIsIgnored, type RepoConfig } from './config';
import { scanFilesForSecrets } from './secretscan';
import { checkMissingTests } from './testnudge';
import { isSlashEvent, handleSlash, shouldFallThroughToReview } from './slash';

type Provider = 'gemini' | 'ollama';

interface PrRef {
  owner: string;
  repo: string;
  prNumber: number;
}

async function tryPostFailure(
  token: string,
  pr: PrRef | null,
  stage: string,
  err: unknown,
  model: string,
  provider: Provider
): Promise<void> {
  if (!pr) return;
  try {
    const octo = github.getOctokit(token);
    const msg = err instanceof Error ? err.message : String(err);
    const md = renderFailureMarkdown(pr.prNumber, stage, msg, model, provider);
    await upsertReviewComment(octo, pr.owner, pr.repo, pr.prNumber, md);
  } catch (postErr) {
    core.warning(
      `Could not post failure comment: ${
        postErr instanceof Error ? postErr.message : String(postErr)
      }`
    );
  }
}

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true });
  const octokit = github.getOctokit(token);

  // Slash-command path: intercept before running a review.
  if (await isSlashEvent()) {
    try {
      await handleSlash(octokit);
    } catch (e) {
      core.setFailed(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!shouldFallThroughToReview()) return;
  }

  const providerInput = (
    (core.getInput('provider') || 'gemini').toLowerCase()
  ) as Provider;
  const modelInput = core.getInput('model');
  const ollamaUrl = core.getInput('ollama-url') || 'http://localhost:11434';
  const geminiKey = core.getInput('gemini-api-key');
  const maxFileBytes = Number(core.getInput('max-file-bytes') || '20000');
  const maxTotalBytes = Number(core.getInput('max-total-bytes') || '120000');
  const minConfidenceInput = Number(core.getInput('min-confidence') || '0.65');
  const maxDailyReviewsInput = Number(core.getInput('max-daily-reviews') || '50');
  const dryRun = (core.getInput('dry-run') || 'false').toLowerCase() === 'true';

  let provider = providerInput;
  let model =
    modelInput ||
    (provider === 'gemini' ? 'gemini-2.5-flash' : 'qwen2.5-coder:7b');
  let pr: PrRef | null = null;

  try {
    if (provider !== 'gemini' && provider !== 'ollama') {
      throw new Error(`Unknown provider "${provider}".`);
    }

    core.info('Fetching PR context…');
    const ctx = await fetchPrContext(octokit, maxFileBytes, maxTotalBytes);
    pr = { owner: ctx.owner, repo: ctx.repo, prNumber: ctx.prNumber };
    core.info(
      `PR #${ctx.prNumber}: ${ctx.filesChanged} files, +${ctx.linesAdded}/-${ctx.linesRemoved}, ${ctx.files.length} files loaded.`
    );

    // Load per-repo config overrides.
    const cfg: RepoConfig = await loadRepoConfig(
      octokit,
      ctx.owner,
      ctx.repo,
      ctx.headSha
    );
    if (cfg.provider) provider = cfg.provider;
    if (cfg.model) model = cfg.model;
    const minConfidence = cfg.minConfidence ?? minConfidenceInput;
    const maxDailyReviews = cfg.maxDailyReviews ?? maxDailyReviewsInput;

    // Drop ignored files from the prompt context.
    const ignore = cfg.ignorePaths ?? [];
    const keptFiles = ctx.files.filter((f) => !pathIsIgnored(f.path, ignore));
    const keptTouched = ctx.touchedPaths.filter(
      (p) => !pathIsIgnored(p, ignore)
    );

    if (provider === 'gemini' && !geminiKey) {
      throw new Error('provider=gemini requires input "gemini-api-key".');
    }
    if (provider === 'ollama') {
      await ollama.ensureModel({ baseUrl: ollamaUrl, model });
    }

    if (maxDailyReviews > 0) {
      const { allowed, used, limit } = await checkAndIncrementDaily(
        octokit,
        ctx.owner,
        ctx.repo,
        maxDailyReviews
      );
      core.info(`Daily usage: ${used}/${limit}`);
      if (!allowed) {
        throw new Error(
          `Rate limited locally: ${used}/${limit} reviews used today for this repo. Resets at UTC midnight.`
        );
      }
    }

    // --- Deterministic pre-checks (always run) ---
    const preIssues = [] as ReturnType<typeof scanFilesForSecrets>;
    if (!cfg.disableSecretScan) {
      const found = scanFilesForSecrets(keptFiles);
      preIssues.push(...found);
      if (found.length > 0)
        core.info(`secret-scan: ${found.length} potential leak(s)`);
    }
    if (!cfg.disableTestNudge) {
      const nudge = checkMissingTests(keptTouched);
      if (nudge) preIssues.push(nudge);
    }

    const user = buildUserPrompt({
      prNumber: ctx.prNumber,
      prTitle: ctx.prTitle,
      prBody: ctx.prBody,
      filesChanged: ctx.filesChanged,
      linesAdded: ctx.linesAdded,
      linesRemoved: ctx.linesRemoved,
      diff: ctx.diff,
      files: keptFiles,
    });

    const systemWithAddendum = cfg.promptAddendum
      ? `${SYSTEM_PROMPT}\n\n## Project-specific context\n${cfg.promptAddendum.trim()}`
      : SYSTEM_PROMPT;

    core.info(`Calling ${provider} (${model})…`);
    let raw: string;
    try {
      raw =
        provider === 'gemini'
          ? await gemini.chatJson(
              { apiKey: geminiKey, model, temperature: 0.1 },
              systemWithAddendum,
              user
            )
          : await ollama.chatJson(
              { baseUrl: ollamaUrl, model, temperature: 0.1 },
              systemWithAddendum,
              user
            );
    } catch (err) {
      await tryPostFailure(token, pr, 'LLM call', err, model, provider);
      throw err;
    }

    let parsed;
    try {
      parsed = parseReview(raw);
    } catch (err) {
      await tryPostFailure(token, pr, 'Parse model output', err, model, provider);
      throw err;
    }
    parsed.summary.files_changed = ctx.filesChanged;
    parsed.summary.lines_added = ctx.linesAdded;
    parsed.summary.lines_removed = ctx.linesRemoved;

    // Drop model issues that fall under ignore_paths
    parsed.issues = parsed.issues.filter(
      (i) => !pathIsIgnored(i.file, ignore)
    );

    // Merge deterministic findings into the issues list BEFORE confidence filter.
    parsed.issues = [...preIssues, ...parsed.issues];

    const { review, risk, quality } = finalize(
      parsed,
      {
        filesChanged: ctx.filesChanged,
        linesAdded: ctx.linesAdded,
        linesRemoved: ctx.linesRemoved,
        touchedPaths: keptTouched,
        hasTestChanges: ctx.hasTestChanges,
      },
      minConfidence
    );

    const md = renderMarkdown(ctx.prNumber, review, risk, quality, model);
    core.setOutput('risk-score', String(risk));
    core.setOutput('quality-score', String(quality));
    core.setOutput('issue-count', String(review.issues.length));

    if (dryRun) {
      core.info('Dry run — not posting.');
      core.info(md);
      return;
    }

    // Post the summary comment (upsert).
    await upsertReviewComment(octokit, ctx.owner, ctx.repo, ctx.prNumber, md);

    // Inline review for CRITICAL/WARNING issues pinned to diff lines.
    if (!cfg.disableInlineComments && review.issues.length > 0) {
      try {
        const { posted, orphans } = await postInlineReview(
          octokit,
          ctx.owner,
          ctx.repo,
          ctx.prNumber,
          ctx.headSha,
          ctx.diff,
          review.issues,
          `manavarya-bot — ${review.issues.length} finding(s). Risk ${risk}/10 · Quality ${quality}/100.`
        );
        core.info(`inline review: posted ${posted}, orphans ${orphans.length}`);
      } catch (e) {
        core.warning(
          `Inline review failed (summary comment still posted): ${
            e instanceof Error ? e.message : String(e)
          }`
        );
      }
    }

    // Auto-labels
    const labelsOpt = cfg.labels ?? {
      risk: true,
      needsTests: true,
      securityReview: true,
    };
    const labels: string[] = [];
    if (labelsOpt.risk !== false) {
      if (risk >= 8) labels.push('risk:high');
      else if (risk >= 5) labels.push('risk:med');
      else labels.push('risk:low');
    }
    if (labelsOpt.needsTests !== false && !ctx.hasTestChanges && keptTouched.length > 0) {
      labels.push('needs-tests');
    }
    if (
      labelsOpt.securityReview !== false &&
      review.issues.some(
        (i) =>
          i.severity === 'CRITICAL' &&
          /secret|auth|password|token|security/i.test(i.issue)
      )
    ) {
      labels.push('security-review');
    }
    if (ctx.linesAdded + ctx.linesRemoved > 500) labels.push('size:xl');
    if (labels.length > 0) {
      try {
        await applyLabels(octokit, ctx.owner, ctx.repo, ctx.prNumber, labels);
        core.info(`labels: ${labels.join(', ')}`);
      } catch (e) {
        core.warning(
          `label apply failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    core.info(`Review posted on PR #${ctx.prNumber}.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (pr) {
      await tryPostFailure(token, pr, 'Reviewer', err, model, provider);
    }
    core.setFailed(msg);
  }
}

run();
