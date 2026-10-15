#!/bin/bash
# setup.sh : fresh RUN dir with config + 25 projects
source $(dirname $0)/env.sh
rm -rf $RUN; mkdir -p $XDG_CONFIG_HOME/opencode $RUN/projects
printf '[user]\n name = t\n email = t@t\n[init]\n defaultBranch = main\n' > $GIT_CONFIG_GLOBAL
cat > $XDG_CONFIG_HOME/opencode/opencode.json <<J
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "stub/stub",
  "small_model": "stub/stub",
  "autoupdate": false,
  "share": "disabled",
  "permission": "allow",
  "provider": {
    "stub": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Stub",
      "options": { "baseURL": "http://127.0.0.1:4999/v1", "apiKey": "x" },
      "models": { "stub": { "name": "stub", "tool_call": true, "limit": { "context": 200000, "output": 8000 } } }
    }
  }
}
J
for i in $(seq 1 25); do
  d=$RUN/projects/p$i; mkdir -p $d/src $d/lib
  cd $d; git init -q
  echo "# project $i" > README.md; for k in $(seq 1 30); do echo "line $k of readme $i" >> README.md; done
  echo '{"name":"p'$i'","version":"1.0.0","type":"module"}' > package.json
  printf 'export function main%s(a: number) {\n  return a + %s\n}\nexport const x = main%s(1)\n' $i $i $i > src/index.ts
  printf 'def util(x):\n    return x * %s\n\nfunction = util\n' $i > src/util.py
  for k in $(seq 1 200); do printf 'export function f%s() { return %s }\n' $k $k > lib/m$k.ts; done
  git add -A; git commit -qm init
done
echo setup done
