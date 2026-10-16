# setup2.py: fresh RUN dir with config + N Go projects. Features via env:
#   F_OPENCODE=1  project .opencode/ (25 skills, 8 agents) + 10 KB AGENTS.md
#   F_LSP=1       "lsp": {"gopls": {...}}
#   F_PLUGINS=1   the four production plugins (pty-bridge built from source, simple-memory no-op)
#   F_PROVIDERS=1 five provider entries pointed at the stub, ~30 models each
#   F_BIG=1       add big/big50k.txt and big/big100k.txt to each project (Q7)
import json, os, random, shutil, subprocess

S, RUN = os.environ["S"], os.environ["RUN"]
N = int(os.environ.get("NPROJ", "20"))
F = lambda k: os.environ.get(k) == "1"
STUB = os.environ.get("STUB_URL", "http://127.0.0.1:4999/v1")
rnd = random.Random(42)

shutil.rmtree(RUN, ignore_errors=True)
cfgdir = f"{RUN}/home/.config/opencode"
os.makedirs(cfgdir)
os.makedirs(f"{RUN}/projects")
open(f"{RUN}/home/.gitconfig", "w").write("[user]\n name = t\n email = t@t\n[init]\n defaultBranch = main\n")


def models(prefix, n):
    return {
        f"{prefix}-{i:02d}": {
            "name": f"{prefix.title()} Model {i:02d}",
            "tool_call": True,
            "reasoning": i % 3 == 0,
            "attachment": i % 2 == 0,
            "limit": {"context": 200000, "output": 32000},
            "cost": {"input": 1 + i / 10, "output": 5 + i / 10, "cache_read": 0.1},
            "modalities": {"input": ["text", "image"], "output": ["text"]},
            "options": {"temperature": 0.2},
        }
        for i in range(n)
    }


cfg = {
    "$schema": "https://opencode.ai/config.json",
    "model": "stub/stub-coder",
    "small_model": "stub/stub-coder",
    "autoupdate": False,
    "share": "disabled",
    "permission": "allow",
    "provider": {
        "stub": {
            "npm": "@ai-sdk/openai-compatible",
            "name": "Stub",
            "options": {"baseURL": STUB, "apiKey": "x"},
            "models": {
                "stub-coder": {"name": "stub-coder", "tool_call": True, "limit": {"context": 200000, "output": 8000}},
                "gpt-5-stub": {"name": "gpt-5-stub", "tool_call": True, "limit": {"context": 200000, "output": 8000}},
            },
        }
    },
}
if F("F_PROVIDERS"):
    # Five entries as in production: claude-code (plugin-backed), two OpenAI-compatible endpoints with large
    # model lists, openai and openrouter. All point at the stub; the API keys are dummies.
    cfg["provider"]["claude-code"] = {"models": models("claude-code", 18)}
    cfg["provider"]["corp-a"] = {"npm": "@ai-sdk/openai-compatible", "name": "Corp A", "options": {"baseURL": STUB, "apiKey": "x"}, "models": models("corp-a", 40)}
    cfg["provider"]["corp-b"] = {"npm": "@ai-sdk/openai-compatible", "name": "Corp B", "options": {"baseURL": STUB, "apiKey": "x"}, "models": models("corp-b", 30)}
    cfg["provider"]["openai"] = {"options": {"baseURL": STUB, "apiKey": "x"}, "models": models("gpt-x", 25)}
    cfg["provider"]["openrouter"] = {"options": {"baseURL": STUB, "apiKey": "x"}, "models": models("or", 35)}
if F("F_LSP"):
    cfg["lsp"] = {"gopls": {"command": [f"{S}/bin/gopls"], "extensions": [".go"]}}
if F("F_PLUGINS"):
    cfg["plugin"] = [
        f"{S}/plugins-src/" + os.environ.get("PTY_BRIDGE", "opencode-pty-bridge"),
        f"{S}/plugins-src/simple-memory-noop",
        "opencode-openai-codex-auth@4.4.0",
        "@khalilgharbaoui/opencode-claude-code-plugin@0.36.4",
    ]
json.dump(cfg, open(f"{cfgdir}/opencode.json", "w"), indent=1)

words = "the of and to in is for on that with as by at from it be this are or an was which not have".split()


def prose(nbytes):
    out, size = [], 0
    while size < nbytes:
        line = " ".join(rnd.choice(words) for _ in range(14)) + "."
        if rnd.random() < 0.08:
            line = "\n## " + line[:40] + "\n"
        out.append(line)
        size += len(line) + 1
    return "\n".join(out)


def git(d, *args):
    subprocess.run(["git", "-C", d, *args], check=True, capture_output=True)


for i in range(1, N + 1):
    d = f"{RUN}/projects/p{i}"
    shutil.copytree(f"{S}/" + os.environ.get("GOTPL", "gotpl-vuln"), d)
    tpl = os.environ.get("GOTPL", "gotpl-vuln")
    files = {"gotpl": ["language/language.go", "cases/cases.go"], "gotpl-vuln": ["cmd/govulncheck/main.go", "internal/vulncheck/vulncheck.go"]}[tpl]
    open(f"{d}/SPIKE_FILES", "w").write("\n".join(files) + "\n")
    os.makedirs(f"{d}/internal/spike")
    open(f"{d}/internal/spike/doc.go", "w").write("// Package spike holds files written by the stub provider.\npackage spike\n")
    if F("F_OPENCODE"):
        oc = f"{d}/.opencode"
        for k in range(25):
            os.makedirs(f"{oc}/skills/skill-{k:02d}")
            body = prose(rnd.randint(5_000, 40_000))
            open(f"{oc}/skills/skill-{k:02d}/SKILL.md", "w").write(
                f"---\nname: skill-{k:02d}\ndescription: Spike skill {k} for project {i}. Use when the task mentions topic {k}.\n---\n\n# Skill {k}\n\n{body}\n"
            )
        os.makedirs(f"{oc}/agents")
        for k in range(8):
            open(f"{oc}/agents/agent-{k}.md", "w").write(
                f"---\ndescription: Spike agent {k} for project {i}\nmode: subagent\n---\n\n{prose(rnd.randint(1_500, 6_000))}\n"
            )
        open(f"{d}/AGENTS.md", "w").write(f"# Project {i} agent instructions\n\n{prose(10_000)}\n")
    if F("F_BIG"):
        os.makedirs(f"{d}/big")
        with open(f"{d}/big/big50k.txt", "w") as f:
            f.writelines(f"line {n:06d} of the fifty thousand line file in project {i}, padding padding padding\n" for n in range(50_000))
        with open(f"{d}/big/big100k.txt", "w") as f:
            f.writelines(f"line {n:06d} of the hundred thousand line file in project {i}, padding padding\n" for n in range(100_000))
    git(d, "init", "-q")
    git(d, "commit", "-q", "--allow-empty", "-m", f"root {i} {rnd.random()}")
    git(d, "add", "-A")
    git(d, "commit", "-q", "-m", "init")
print("setup2 done", N, {k: F(k) for k in ["F_OPENCODE", "F_LSP", "F_PLUGINS", "F_PROVIDERS", "F_BIG"]})
