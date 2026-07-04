#!/usr/bin/env node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(""); return; }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;

    const input = JSON.parse(raw) as { prompt?: string; transcript_path?: string };
    const prompt = input.prompt ?? "";
    if (!prompt.trim()) return;

    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    const gen = Date.now();

    // Stamp this generation synchronously. Everything expensive runs in a
    // detached worker, so this is the only signal an in-flight worker from an
    // earlier prompt has to know it's been superseded and should not overwrite.
    // The previous prompt's tip stays visible until this generation's worker
    // replaces it, so there's always something on screen.
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      settings._cladosGen = gen;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    } catch {
      // No settings file means nothing downstream can render a tip anyway.
      return;
    }

    // Chat-history extraction, HN search, and summarization all happen in the
    // worker so the prompt submit is never blocked on the network or an LLM.
    const dataFile = path.join(os.tmpdir(), `clados-${process.pid}-${gen}.json`);
    fs.writeFileSync(dataFile, JSON.stringify({
      prompt,
      transcriptPath: input.transcript_path ?? "",
      settingsPath,
      gen,
    }));

    const tsx = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
    const worker = path.join(__dirname, "worker.ts");
    const child = spawn(tsx, [worker, dataFile], {
      stdio: "ignore",
      detached: true,
      env: process.env,
    });
    child.unref();
  } catch {
    // Silent fail — never disrupt Claude Code.
  }
}

main();
