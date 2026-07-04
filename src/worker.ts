#!/usr/bin/env node
import * as https from "https";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface WorkerData {
  prompt: string;
  transcriptPath: string;
  settingsPath: string;
  gen: number;
}

interface HNHit {
  title?: string;
  url?: string;
  objectID: string;
  points?: number;
  num_comments?: number;
}

interface HNResponse {
  hits: HNHit[];
}

// OpenRouter model slots. `model` is tried first; on rate-limit or empty output
// it falls through to `fallbackModel`. Both are overridable in
// ~/.clados/config.json ("model" / "fallbackModel"); these apply to both the
// keyword-extraction and summarization calls.
const DEFAULT_MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";
const DEFAULT_FALLBACK_MODEL = "openai/gpt-oss-20b:free";

function readConfig(): { key: string; debug: boolean; models: string[] } {
  const configPath = path.join(os.homedir(), ".clados", "config.json");
  const envDebug = process.env.CLADOS_DEBUG === "1";
  const pick = (v: unknown, fallback: string) =>
    typeof v === "string" && v.trim() ? v.trim() : fallback;
  try {
    const c = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const main = pick(c.model, DEFAULT_MODEL);
    const fb = pick(c.fallbackModel, DEFAULT_FALLBACK_MODEL);
    return {
      key: c.openrouterKey ?? process.env.OPENROUTER_API_KEY ?? "",
      debug: !!c.debug || envDebug,
      models: main === fb ? [main] : [main, fb],
    };
  } catch {
    return {
      key: process.env.OPENROUTER_API_KEY ?? "",
      debug: envDebug,
      models: [DEFAULT_MODEL, DEFAULT_FALLBACK_MODEL],
    };
  }
}

// ---- Debug log ----------------------------------------------------------
// Opt-in via `"debug": true` in ~/.clados/config.json (or CLADOS_DEBUG=1).
// Since the worker runs detached with stdio ignored, a file is the only way
// to observe what goes into and out of each stage. NOTE: this records prompt
// and conversation text — keep it off unless you're debugging.
const LOG_PATH = path.join(os.homedir(), ".clados", "debug.log");
let DEBUG = false;
let GEN = 0;
let MODELS: string[] = [DEFAULT_MODEL, DEFAULT_FALLBACK_MODEL];

function log(section: string, data?: unknown): void {
  if (!DEBUG) return;
  try {
    let body = "";
    if (data !== undefined) {
      body = "\n" + (typeof data === "string" ? data : JSON.stringify(data, null, 2));
    }
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [gen ${GEN}] ${section}${body}\n\n`);
  } catch {
    // Never let logging disrupt the worker.
  }
}

// Keep the log from growing without bound across sessions.
function rotateLog(): void {
  if (!DEBUG) return;
  try {
    if (fs.statSync(LOG_PATH).size > 1_000_000) fs.writeFileSync(LOG_PATH, "");
  } catch {
    // No log file yet — nothing to rotate.
  }
}

function httpPost(body: string, apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "openrouter.ai",
        path: "/api/v1/chat/completions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "HTTP-Referer": "https://github.com/clados",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callOpenRouter(prompt: string, apiKey: string, maxTokens = 400, label = "llm"): Promise<string> {
  // Model list comes from config (MODELS): main model first, then fallback.
  // Free models are flaky: they rate-limit (429, transient — retry_after ~11s)
  // and the reasoning ones can burn the whole token budget on their hidden
  // reasoning and return empty content. Retry the model list a few times, and
  // treat an empty answer as a failure to fall through, not a success.
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const model of MODELS) {
      const body = JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        // We only ever want the final answer. Reasoning models (Nemotron,
        // gpt-oss) otherwise burn the token budget on hidden chain-of-thought
        // and, when truncated mid-thought, leak it into content. Disabling it
        // keeps content clean and the whole budget for the actual answer.
        reasoning: { enabled: false },
      });

      const t0 = Date.now();
      const raw = await httpPost(body, apiKey);
      const ms = Date.now() - t0;

      let json: {
        error?: { code?: number; message?: string };
        choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      try {
        json = JSON.parse(raw);
      } catch {
        log(`${label} ← ${model}: unparseable response (${ms}ms)`, raw.slice(0, 300));
        continue;
      }

      if (json.error?.code === 429 || json.error?.code === 404) {
        log(`${label} ← ${model}: error ${json.error.code} (${ms}ms)`, json.error.message);
        continue;
      }
      if (json.error) {
        log(`${label} ← ${model}: fatal error (${ms}ms)`, json.error.message);
        throw new Error(json.error.message);
      }

      const finish = json.choices?.[0]?.finish_reason;
      // Strip Qwen3 thinking blocks
      const text = (json.choices?.[0]?.message?.content ?? "")
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .trim();

      if (text) {
        log(`${label} ← ${model}: ok (${ms}ms, finish=${finish}, tokens=${json.usage?.total_tokens ?? "?"}, ${text.length} chars)`, text);
        return text;
      }
      log(`${label} ← ${model}: empty content (${ms}ms, finish=${finish}, tokens=${json.usage?.total_tokens ?? "?"})`);
      // Empty content (e.g. a reasoning model truncated before answering) — next model.
    }

    // Whole list failed this round; brief backoff lets 429'd models recover.
    if (attempt < 2) {
      log(`${label}: all models failed attempt ${attempt + 1}/3, backing off 5s`);
      await sleep(5000);
    }
  }

  throw new Error("All models rate-limited or unavailable");
}

function fetchJSON(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.setTimeout(4000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// Pull the last few user/assistant turns out of the Claude Code transcript
// (JSONL, one message per line) so tag extraction has real conversational
// context instead of just the latest prompt.
function readRecentHistory(transcriptPath: string): string {
  if (!transcriptPath) return "";
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return "";
  }

  const turns: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: { message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;

    const content = entry.message?.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      // Text blocks only — skip tool calls, tool results, images, etc.
      text = content
        .filter((b): b is { type: string; text: string } =>
          !!b && (b as { type?: string }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string")
        .map((b) => b.text)
        .join(" ");
    }

    text = text.replace(/\s+/g, " ").trim();
    if (text) turns.push(`${role}: ${text.slice(0, 500)}`);
  }

  return turns.slice(-8).join("\n").slice(-4000);
}

// Ask a fast free model for HN search keywords, using conversation context.
async function extractTags(history: string, prompt: string, apiKey: string): Promise<string[]> {
  const extractionPrompt =
    `You pick search keywords to find a relevant Hacker News article for a developer, ` +
    `based on what they're currently working on. Below is the recent conversation ` +
    `followed by their latest message. Reply with ONLY 2 to 3 space-separated lowercase ` +
    `keywords capturing the main technical topic — no punctuation, no quotes, no explanation.\n\n` +
    (history ? `Conversation:\n${history}\n\n` : "") +
    `Latest message:\n${prompt.slice(0, 2000)}`;

  log("extraction → input", { historyChars: history.length, prompt, history });

  // Generous budget: the fallback is a reasoning model that spends most of its
  // tokens thinking before it emits the short keyword answer.
  const raw = await callOpenRouter(extractionPrompt, apiKey, 512, "extraction");
  const tags = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);

  log("extraction → tags", tags);
  return tags;
}

// Search HN, progressively broadening the query. A specific 3-keyword combo is
// best when it matches, but niche combos often return nothing — so fall back to
// fewer (longer, more specific) keywords rather than giving up and showing no tip.
async function searchHN(tags: string[]): Promise<HNHit | null> {
  const sorted = [...tags].sort((a, b) => b.length - a.length);
  const seen = new Set<string>();

  for (const words of [sorted.slice(0, 3), sorted.slice(0, 2), sorted.slice(0, 1)]) {
    const q = words.join(" ");
    if (!q || seen.has(q)) continue;
    seen.add(q);

    const t0 = Date.now();
    const data = (await fetchJSON(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=10`
    )) as HNResponse;
    const ms = Date.now() - t0;

    const hit = data.hits?.find((h) => h.title && (h.points ?? 0) > 5) ?? data.hits?.[0];
    log(`hn search "${q}" (${ms}ms)`, { hits: data.hits?.length ?? 0, picked: hit?.title, points: hit?.points });
    if (hit?.title) return hit;
  }

  return null;
}

async function fetchHNComments(objectID: string): Promise<string> {
  const data = (await fetchJSON(
    `https://hn.algolia.com/api/v1/search?tags=comment,story_${objectID}&hitsPerPage=10&attributesToRetrieve=comment_text`
  )) as { hits: Array<{ comment_text?: string }> };

  return data.hits
    .map((h) => h.comment_text ?? "")
    .filter(Boolean)
    .map((t) => t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300))
    .join("\n\n")
    .slice(0, 3000);
}

async function summarize(title: string, comments: string, apiKey: string): Promise<string> {
  const prompt =
    `Based on these HN comments about "${title}", write 5 bullet points that tell me ` +
    `what the article is about and why it's interesting. Each bullet under 80 chars. ` +
    `Facts and specifics only. No intro, no outro, just the bullets.\n\nComments:\n${comments}`;
  log("summary → input", { title, commentChars: comments.length, comments });
  // Wide budget: the reasoning fallback model needs room to think *and* emit all
  // five bullets — 400 tokens got fully consumed by hidden reasoning (finish=length,
  // empty content), so summaries silently failed whenever the primary was throttled.
  const bullets = await callOpenRouter(prompt, apiKey, 1200, "summary");
  log("summary → output", bullets);
  return bullets;
}

// The hook stamps _cladosGen on every prompt; a worker only writes if it's
// still the latest generation, so a slow worker can't clobber a newer prompt.
function writeTip(settingsPath: string, gen: number, tip: string): void {
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  if (settings._cladosGen !== gen) return;
  settings.spinnerTipsOverride = { tips: [tip], excludeDefault: true };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function isCurrent(settingsPath: string, gen: number): boolean {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return settings._cladosGen === gen;
  } catch {
    return false;
  }
}

async function main() {
  const dataFile = process.argv[2];
  if (!dataFile) process.exit(1);

  const data: WorkerData = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  fs.unlinkSync(dataFile);

  const cfg = readConfig();
  DEBUG = cfg.debug;
  GEN = data.gen;
  MODELS = cfg.models;
  const started = Date.now();
  rotateLog();
  log("═══ worker start ═══", { prompt: data.prompt, transcriptPath: data.transcriptPath, models: MODELS });

  if (!cfg.key) throw new Error("No OpenRouter API key found in ~/.clados/config.json");

  // Bail immediately if a newer prompt has already superseded this one.
  if (!isCurrent(data.settingsPath, data.gen)) {
    log("superseded before start — exiting");
    process.exit(0);
  }

  const history = readRecentHistory(data.transcriptPath);
  const tags = await extractTags(history, data.prompt, cfg.key);
  if (tags.length < 1) {
    log("no tags extracted — exiting");
    process.exit(0);
  }

  const hit = await searchHN(tags);
  if (!hit?.title) {
    log("no HN story matched — exiting");
    process.exit(0);
  }

  const title = hit.title;
  // HN returns url:"" (not null) for text posts — nullish coalescing wouldn't
  // catch that, leaving a bare "🔗" with no link. Fall back on empty too.
  const url = hit.url?.trim() ? hit.url : `https://news.ycombinator.com/item?id=${hit.objectID}`;

  // Show the title as soon as we have it, then enrich with a summary.
  writeTip(data.settingsPath, data.gen, `📰 ${title}\n🔗 ${url}`);
  log(`tip written (title only) at +${Date.now() - started}ms`, title);

  try {
    const comments = await fetchHNComments(hit.objectID);
    log(`hn comments fetched: ${comments.length} chars`);
    if (comments.length > 100) {
      const bullets = await summarize(title, comments, cfg.key);
      if (bullets) {
        writeTip(data.settingsPath, data.gen, `📰 ${title}\n${bullets}\n🔗 ${url}`);
        log(`tip written (with summary) at +${Date.now() - started}ms`);
      }
    } else {
      log("too few comments to summarize — leaving title-only tip");
    }
  } catch (e) {
    log("summary step failed (title tip stands)", String(e));
  }

  log(`═══ worker done in ${Date.now() - started}ms ═══`);
}

main().catch(() => process.exit(1));
