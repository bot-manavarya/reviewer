import * as core from '@actions/core';
import * as github from '@actions/github';
import { fetchPrContext, upsertReviewComment } from './github';
import { chatJson, ensureModel } from './ollama';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt';
import { parseReview } from './schema';
import { finalize } from './scoring';
import { renderMarkdown } from './markdown';

async function run(): Promise<void> {
  try {
    const token = core.getInput('github-token', { required: true });
    const ollamaUrl = core.getInput('ollama-url') || 'http://localhost:11434';
    const model = core.getInput('model') || 'qwen2.5-coder:7b';
    const maxFileBytes = Number(core.getInput('max-file-bytes') || '20000');
    const maxTotalBytes = Number(core.getInput('max-total-bytes') || '120000');
    const minConfidence = Number(core.getInput('min-confidence') || '0.65');
    const dryRun = (core.getInput('dry-run') || 'false').toLowerCase() === 'true';

    const octokit = github.getOctokit(token);

    core.info(`Using model ${model} at ${ollamaUrl}`);
    await ensureModel({ baseUrl: ollamaUrl, model });

    core.info('Fetching PR context…');
    const ctx = await fetchPrContext(octokit, maxFileBytes, maxTotalBytes);
    core.info(
      `PR #${ctx.prNumber}: ${ctx.filesChanged} files, +${ctx.linesAdded}/-${ctx.linesRemoved}, ${ctx.files.length} files loaded for context.`
    );

    const user = buildUserPrompt({
      prNumber: ctx.prNumber,
      prTitle: ctx.prTitle,
      prBody: ctx.prBody,
      filesChanged: ctx.filesChanged,
      linesAdded: ctx.linesAdded,
      linesRemoved: ctx.linesRemoved,
      diff: ctx.diff,
      files: ctx.files,
    });

    core.info('Calling Ollama…');
    const raw = await chatJson(
      { baseUrl: ollamaUrl, model, temperature: 0.1 },
      SYSTEM_PROMPT,
      user
    );

    const parsed = parseReview(raw);
    parsed.summary.files_changed = ctx.filesChanged;
    parsed.summary.lines_added = ctx.linesAdded;
    parsed.summary.lines_removed = ctx.linesRemoved;

    const { review, risk, quality } = finalize(
      parsed,
      {
        filesChanged: ctx.filesChanged,
        linesAdded: ctx.linesAdded,
        linesRemoved: ctx.linesRemoved,
        touchedPaths: ctx.touchedPaths,
        hasTestChanges: ctx.hasTestChanges,
      },
      minConfidence
    );

    const md = renderMarkdown(ctx.prNumber, review, risk, quality, model);

    core.setOutput('risk-score', String(risk));
    core.setOutput('quality-score', String(quality));
    core.setOutput('issue-count', String(review.issues.length));

    if (dryRun) {
      core.info('Dry run — not posting comment.');
      core.info(md);
      return;
    }

    await upsertReviewComment(octokit, ctx.owner, ctx.repo, ctx.prNumber, md);
    core.info(`Posted review on PR #${ctx.prNumber}.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.setFailed(msg);
  }
}

run();
