# Clados

A [Claude Code](https://claude.com/claude-code) hook that surfaces a relevant
**Hacker News article in the spinner tip while Claude is working** — picked from
what you're actually talking about in the session.

```
📰 Incremental Rust Builds in CI
- Cranelift backend cuts debug build times noticeably.
- sccache shares artifacts across CI runs to skip recompiles.
- Splitting crates improves incremental rebuild granularity.
- Most wins come from caching the dependency graph, not codegen.
- Worth it for large workspaces; marginal for small ones.
🔗 https://earthly.dev/blog/incremental-rust-builds/
```

## How it works

On every prompt you submit, a `UserPromptSubmit` hook fires and does the slow
work off the critical path:

1. **`hook.ts`** (instant) stamps a generation marker and spawns a detached
   worker — your prompt is never blocked on the network.
2. **`worker.ts`** (background):
   - reads the last few turns of the conversation from the session transcript
     (text only — no tool calls or hidden reasoning),
   - asks a fast LLM (via [OpenRouter](https://openrouter.ai)) for a couple of
     search keywords,
   - searches Hacker News (Algolia API), broadening the query if a niche combo
     matches nothing,
   - writes the article title to the spinner tip immediately, then enriches it
     with a 5-bullet summary generated from the story's HN comments.

The previous tip stays on screen until a fresh one replaces it, and a stale
worker never clobbers a newer prompt's tip.

## Install

One-shot (clones, installs deps, registers the hook):

```bash
curl -fsSL https://raw.githubusercontent.com/dalechyn/better-claude-tips/main/install.sh | bash
```

Seed your OpenRouter key at the same time (optional):

```bash
curl -fsSL https://raw.githubusercontent.com/dalechyn/better-claude-tips/main/install.sh | OPENROUTER_API_KEY=sk-or-... bash
```

Then **restart Claude Code** to load the hook.

### API key

Clados needs an [OpenRouter](https://openrouter.ai/keys) API key — the default
models are on the **free tier**, so this costs nothing. Put it in
`~/.clados/config.json`:

```json
{
  "openrouterKey": "sk-or-..."
}
```

## Configuration

All optional — `~/.clados/config.json`:

| Key             | Default                                   | Description                                              |
| --------------- | ----------------------------------------- | ------------------------------------------------------- |
| `openrouterKey` | —                                         | Your OpenRouter API key (required to produce tips).     |
| `model`         | `nvidia/nemotron-3-nano-30b-a3b:free`     | Primary model, used first for extraction + summaries.   |
| `fallbackModel` | `openai/gpt-oss-20b:free`                 | Tried when the primary is rate-limited or returns empty.|
| `debug`         | `false`                                   | Write a per-run debug log (see below).                  |

The file is created with `600` permissions. Model reasoning is disabled on
every request, so reasoning-capable models return clean answers without burning
their token budget on hidden chain-of-thought.

## Debugging

Set `"debug": true` (or `CLADOS_DEBUG=1`) and watch:

```bash
tail -f ~/.clados/debug.log
```

Each run logs its inputs, outputs, the model used, and per-stage timings for
keyword extraction, HN search, and summarization. The log truncates past 1 MB.
It records prompt and conversation text, so leave it off unless you're
debugging.

## Development

Point the hook at your working tree so edits take effect with no reinstall:

```bash
git clone https://github.com/dalechyn/better-claude-tips.git
cd better-claude-tips
./dev-install.sh
```

Both installers **append** the hook to `UserPromptSubmit` — any existing hooks
you have are preserved.

## Uninstall

Remove the Clados entry from the `UserPromptSubmit` array in
`~/.claude/settings.json`, then `rm -rf ~/.clados`.

## License

[MIT](./LICENSE)
