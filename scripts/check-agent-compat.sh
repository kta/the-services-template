#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(git rev-parse --show-toplevel)}"
cd "$ROOT"

fail() {
  printf 'agent-compat: %s\n' "$*" >&2
  exit 1
}

[[ -f AGENTS.md && ! -L AGENTS.md ]] || fail "AGENTS.md must be the canonical regular file"
[[ -L CLAUDE.md ]] || fail "CLAUDE.md must be a symbolic link"
[[ "$(readlink CLAUDE.md)" == "AGENTS.md" ]] || fail "CLAUDE.md must point to AGENTS.md"
[[ -r CLAUDE.md ]] || fail "CLAUDE.md link is broken"

for service in admin example_service notifier ops; do
  agents="services/$service/AGENTS.md"
  claude="services/$service/CLAUDE.md"
  [[ -f "$agents" && ! -L "$agents" ]] || fail "$agents must be the canonical regular file"
  [[ -L "$claude" ]] || fail "$claude must be a symbolic link"
  [[ "$(readlink "$claude")" == "AGENTS.md" ]] || fail "$claude must point to AGENTS.md"
  [[ -r "$claude" ]] || fail "$claude link is broken"
done

if [[ -e .agents/skills || -e .claude/skills || -L .claude/skills ]]; then
  [[ -d .agents/skills ]] || fail ".agents/skills must be the canonical skill directory"
  [[ -L .claude/skills ]] || fail ".claude/skills must be a symbolic link"
  [[ "$(readlink .claude/skills)" == "../.agents/skills" ]] ||
    fail ".claude/skills must point to ../.agents/skills"
  [[ -d .claude/skills ]] || fail ".claude/skills link is broken"

  skill_count=0
  while IFS= read -r skill_file; do
    skill_count=$((skill_count + 1))
    skill_dir="$(basename "$(dirname "$skill_file")")"
    name="$(awk '
      NR == 1 && $0 == "---" { frontmatter = 1; next }
      frontmatter && $0 == "---" { exit }
      frontmatter && /^name:[[:space:]]*/ {
        sub(/^name:[[:space:]]*/, "")
        gsub(/^["'"'"']|["'"'"']$/, "")
        print
        exit
      }
    ' "$skill_file")"
    [[ -n "$name" ]] || fail "$skill_file is missing frontmatter name"
    [[ "$name" == "$skill_dir" ]] ||
      fail "$skill_file name '$name' does not match directory '$skill_dir'"
    awk '
      NR == 1 && $0 == "---" { frontmatter = 1; next }
      frontmatter && $0 == "---" { exit }
      frontmatter && /^description:[[:space:]]*/ { found = 1 }
      END { exit(found ? 0 : 1) }
    ' "$skill_file" || fail "$skill_file is missing frontmatter description"
  done < <(find -L .agents/skills -mindepth 2 -maxdepth 2 -name SKILL.md -type f | sort)
  (( skill_count > 0 )) || fail ".agents/skills does not contain any SKILL.md"
fi

printf 'agent-compat: ok (%s)\n' "$(basename "$ROOT")"
