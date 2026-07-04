#!/usr/bin/env python3
"""Add/replace the Clados UserPromptSubmit hook in ~/.claude/settings.json"""
import json, sys, os

settings_path = os.path.expanduser("~/.claude/settings.json")
command = sys.argv[1]

try:
    with open(settings_path) as f:
        settings = json.load(f)
except FileNotFoundError:
    settings = {}

# Append the Clados hook without clobbering any other UserPromptSubmit hooks the
# user already has (e.g. their own tooling). Idempotent: drop a prior Clados entry
# first, identified by the hook.ts entrypoint, then re-add.
hooks = settings.setdefault("hooks", {}).setdefault("UserPromptSubmit", [])


def is_clados(block):
    return any("/src/hook.ts" in h.get("command", "") for h in block.get("hooks", []))


hooks[:] = [b for b in hooks if not is_clados(b)]
hooks.append(
    {
        "matcher": "",
        "hooks": [{"type": "command", "command": command, "timeout": 10}],
    }
)

with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")

print(f"Hook registered in {settings_path}")
