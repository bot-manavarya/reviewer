# manavarya-bot

AI pull-request reviewer that acts as a **collaborator-style manager bot** across all [@Manavarya09](https://github.com/Manavarya09) repositories, powered by a **local Ollama** model (`qwen2.5-coder:7b` by default) running on your laptop.

It works the way GitHub Copilot-style bots work:

1. The `bot-manavarya` GitHub account is added as a **collaborator** to each of your main repos.
2. Each main repo includes a small workflow that calls a **reusable workflow** in this repo.
3. That workflow runs on a **self-hosted runner on your laptop** (label `ollama`), so it can reach `http://localhost:11434`.
4. The action posts a code audit as a PR comment under the `bot-manavarya` identity.

No public tunnels, no third-party API calls, no code ever leaves your machine.

---

## Architecture

```
 ┌─────────────────────────────┐         ┌──────────────────────────────┐
 │  Manavarya09/<repo>         │         │  bot-manavarya/reviewer      │
 │  .github/workflows/         │  uses:  │  action.yml + dist/index.js  │
 │   manavarya-bot.yml  ───────┼────────►│  .github/workflows/review.yml│
 │  (triggers on PR)           │         │  (reusable workflow)         │
 └────────────┬────────────────┘         └──────────────┬───────────────┘
              │ dispatched to                           │
              ▼                                         │
 ┌─────────────────────────────┐                        │
 │  Self-hosted runner         │◄───────────────────────┘
 │  (your MacBook, label:      │
 │   self-hosted,ollama)       │
 │                             │
 │   ollama serve ◄──┐         │
 │   qwen2.5-coder:7b│         │
 └──────────────────────┘      │
```

---

## One-time setup

### 1. On your laptop — Ollama

```bash
brew install ollama               # or the official installer
ollama serve &                    # keep running
ollama pull qwen2.5-coder:7b      # ~4.7 GB
```

Verify:
```bash
curl -s http://localhost:11434/api/tags | jq '.models[].name'
```

### 2. On your laptop — self-hosted GitHub runner

Register the runner under the **`bot-manavarya` user account** so every repo that invites it (via collaborator access) can use it.

- Go to `https://github.com/bot-manavarya` → *Settings* → *Actions* → *Runners* → *New self-hosted runner*.
- Follow the macOS setup steps.
- When prompted for labels, add: `ollama`
- Install as a service so it auto-starts:
  ```bash
  cd ~/actions-runner
  ./svc.sh install
  ./svc.sh start
  ```

> **Why self-hosted?** Ollama lives on your laptop. A hosted GitHub runner can’t reach `localhost:11434` without a tunnel. A self-hosted runner on the same machine is simpler and safer.

### 3. Bot account — personal access token

Log in as **`bot-manavarya`** and create a fine-grained PAT:

- *Resource owner:* `bot-manavarya`
- *Repository access:* **All repositories** (or selected — pick every repo you add the bot to)
- *Permissions — Repository:*
  - Contents: **Read**
  - Issues: **Read and write**
  - Pull requests: **Read and write**
  - Metadata: **Read**

Copy the token.

### 4. Bot account — secrets

Log in as **`bot-manavarya`** → *Settings* → *Developer settings* is for PATs; the **organization/user secrets** live on each repo, **but** workflows in *target* repos need access too. You have two equivalent choices:

**Option A — Per-target-repo secret (simpler).**
In every target repo (`Manavarya09/<repo>`): *Settings → Secrets and variables → Actions* → **New repository secret** `MANAVARYA_BOT_TOKEN` = the PAT above.

**Option B — One secret, many repos.**
If you convert `Manavarya09` into an organization later, use an **organization secret** and grant it to selected repos.

Start with Option A.

### 5. Collaborator access

For each repo you want the bot to manage, on `Manavarya09/<repo>` → *Settings → Collaborators* → add `bot-manavarya` with **Write** access.
This lets the bot comment and mark reviews as itself.

### 6. Build this action

```bash
cd bot-manavarya
npm install
npm run build         # produces dist/index.js (committed — required for node actions)
git add -A
git commit -m "initial action"
git push origin main
```

### 7. Install the workflow in each target repo

Copy [`examples/target-repo-workflow.yml`](examples/target-repo-workflow.yml) into every target repo as `.github/workflows/manavarya-bot.yml`:

```yaml
name: manavarya-bot review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  review:
    if: ${{ github.event.pull_request.draft == false }}
    uses: bot-manavarya/reviewer/.github/workflows/review.yml@main
    with:
      model: 'qwen2.5-coder:7b'
    secrets:
      bot-token: ${{ secrets.MANAVARYA_BOT_TOKEN }}
```

That's it. Open a PR — the bot will review it.

---

## How the review works

1. On every PR event, the reusable workflow runs on your laptop’s self-hosted runner.
2. `src/github.ts` downloads the unified diff + full file contents (binary & removed files skipped; large files truncated).
3. `src/ollama.ts` calls `POST /api/chat` with `format: "json"` so the model must emit valid JSON.
4. `src/schema.ts` parses & validates the JSON with zod.
5. `src/scoring.ts` computes the **risk score (1–10)** and **quality score (0–100)** deterministically from the issues list, PR stats, whether critical paths (auth/payments/etc.) were touched, and whether tests changed.
6. `src/markdown.ts` renders a clean report.
7. `src/github.ts` upserts the comment — a hidden `<!-- manavarya-bot-review -->` marker lets the bot update its own comment on new pushes instead of spamming new ones.

The model is only asked for issues + notes. Scores are computed in code so they can’t drift or be gamed.

## Tuning

All inputs on the action have defaults; override in the target repo’s workflow:

| Input            | Default                 | Meaning                                                       |
|------------------|-------------------------|---------------------------------------------------------------|
| `model`          | `qwen2.5-coder:7b`      | Any tag installed in your local Ollama.                       |
| `ollama-url`     | `http://localhost:11434`| Usually don’t change on a self-hosted runner.                 |
| `max-file-bytes` | `20000`                 | Per-file content cap sent to the model.                       |
| `max-total-bytes`| `120000`                | Total file content cap sent to the model.                     |
| `min-confidence` | `0.65`                  | Drop issues below this confidence.                            |
| `dry-run`        | `false`                 | Print report to the job log instead of commenting.            |

## Local testing

```bash
export GITHUB_TOKEN=ghp_your_personal_token
npx ts-node src/cli.ts Manavarya09 some-repo 42
# DRY_RUN defaults to true; set DRY_RUN=false to actually post.
```

## Files

| Path                                   | Purpose                                                   |
|----------------------------------------|-----------------------------------------------------------|
| `action.yml`                           | Composite Node 20 action manifest.                        |
| `src/main.ts`                          | Action entry point.                                       |
| `src/github.ts`                        | PR diff + file fetch, comment upsert.                     |
| `src/ollama.ts`                        | Minimal Ollama client with JSON mode.                     |
| `src/prompt.ts`                        | System + user prompts (the master audit prompt).          |
| `src/schema.ts`                        | zod schema + JSON extractor.                              |
| `src/scoring.ts`                       | Deterministic risk & quality scoring.                     |
| `src/markdown.ts`                      | JSON → Markdown report renderer.                          |
| `src/cli.ts`                           | Local CLI for testing without running an Action.          |
| `.github/workflows/review.yml`         | Reusable workflow called by target repos.                 |
| `.github/workflows/ci.yml`             | Typecheck + verify `dist/` is committed.                  |
| `examples/target-repo-workflow.yml`    | Drop-in workflow for every target repo.                   |

## Troubleshooting

- **`Model "qwen2.5-coder:7b" is not present`** → `ollama pull qwen2.5-coder:7b` on your laptop.
- **Runner doesn’t pick up the job** → check `./svc.sh status` in `~/actions-runner`; confirm the runner is online in `bot-manavarya`’s runner settings.
- **Comment posted as you instead of the bot** → the target repo is using `github.token` instead of `MANAVARYA_BOT_TOKEN`. Fix the `secrets:` block.
- **JSON parse failure** → rare on `qwen2.5-coder:7b` with `format:"json"`; if it happens, bump `num_ctx` or try `qwen2.5-coder:14b`.

## Roadmap (V3 ideas, not built)

- Inline review comments on specific diff lines (`pulls.createReview` with `comments[]`).
- Ollama model fallback chain (7b → 14b on retry).
- Slash-command re-review (`/review` comment triggers a rerun).
- Per-repo config file (`.manavarya-bot.yml`) for severity thresholds & path-ignore rules.
