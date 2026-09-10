#!/usr/bin/env bash
# Keep Biome's enabled diagnostics fail-closed at error severity.
#
# --error-on-warnings does not reject informational diagnostics, and a
# recommended rule inherits its own default severity unless the rule is set
# explicitly. This contract checks the JSONC structure, inventories the rules
# enabled by the installed Biome, and requires every recommended warn/info rule
# to have an explicit error setting.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${BIOME_CONFIG_PATH:-$ROOT/biome.jsonc}"
BIOME="$ROOT/node_modules/.bin/biome"

check_config() {
  local config_path="$1"
  if [[ ! -e "$config_path" ]]; then
    echo "✗ Biome policy config not found: $config_path" >&2
    return 1
  fi
  if [[ ! -f "$config_path" ]]; then
    echo "✗ Biome policy config is not a regular file: $config_path" >&2
    return 1
  fi

  node - "$config_path" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const { parse, printParseErrorCode } = require('jsonc-parser');

let source;
try {
  source = fs.readFileSync(path, 'utf8');
} catch (error) {
  console.error(`✗ Could not read Biome policy config ${path}: ${error.message}`);
  process.exit(1);
}

const errors = [];
const config = parse(source, errors, { allowTrailingComma: true });
if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) {
  const details = errors.length
    ? errors.map(error => printParseErrorCode(error.error)).join(', ')
    : 'configuration must be an object';
  console.error(`✗ Biome policy config is not valid JSONC: ${path} (${details})`);
  process.exit(1);
}

const failures = [];
if (Object.hasOwn(config, 'extends')) {
  failures.push('extends is unsupported; inherited rule severities cannot be audited');
}

function severityOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'level')) {
    return value.level;
  }
  return undefined;
}

function inspectRules(rules, scope) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
    return;
  }

  for (const [group, groupValue] of Object.entries(rules)) {
    if (group === 'preset') {
      if (!['recommended', 'all', 'none'].includes(groupValue)) {
        failures.push(`${scope}.${group} must be recommended, all, or none`);
      }
      continue;
    }
    if (group === 'recommended') {
      if (groupValue !== true && groupValue !== false) {
        failures.push(`${scope}.${group} must be true or false`);
      }
      continue;
    }

    if (typeof groupValue === 'string') {
      if (groupValue !== 'off') {
        failures.push(`${scope}.${group} uses broad ${JSON.stringify(groupValue)}; set each rule explicitly`);
      }
      continue;
    }
    if (groupValue === null) {
      continue;
    }
    if (typeof groupValue !== 'object' || Array.isArray(groupValue)) {
      failures.push(`${scope}.${group} has an unsupported configuration`);
      continue;
    }

    for (const [rule, value] of Object.entries(groupValue)) {
      const severity = severityOf(value);
      if (severity !== 'error' && severity !== 'off') {
        const suffix = severity === undefined ? 'has no explicit level' : `uses ${JSON.stringify(severity)}`;
        failures.push(`${scope}.${group}.${rule} ${suffix}`);
      }
    }
  }
}

function inspectScope(scope, label) {
  inspectRules(scope?.linter?.rules, label);
}

inspectScope(config, 'linter.rules');
if (Array.isArray(config.overrides)) {
  config.overrides.forEach((override, index) => inspectScope(override, `overrides[${index}].linter.rules`));
}

if (failures.length > 0) {
  console.error('✗ Biome policy contains an enabled severity other than error:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
NODE
}

if [[ "${1:-}" == "--check-config" ]]; then
  if [[ "$#" -ne 2 ]]; then
    echo "usage: $0 [--check-config PATH]" >&2
    exit 2
  fi
  check_config "$2"
  exit $?
fi

if [[ "$#" -ne 0 ]]; then
  echo "usage: $0 [--check-config PATH]" >&2
  exit 2
fi

if [[ ! -x "$BIOME" ]]; then
  echo "✗ Biome executable not found at $BIOME — run 'npm ci'" >&2
  exit 1
fi
check_config "$CONFIG"

node - "$CONFIG" "$BIOME" "$ROOT" <<'NODE'
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const configPath = process.argv[2];
const biome = process.argv[3];
const root = process.argv[4];

const rage = spawnSync(biome, ['rage', '--linter', `--config-path=${configPath}`], {
  cwd: root,
  encoding: 'utf8',
});
if (rage.error || rage.status !== 0) {
  console.error(`✗ Could not inventory Biome rules (status ${rage.status ?? 'unknown'}): ${rage.error?.message ?? rage.stderr.trim()}`);
  process.exit(1);
}

const rules = [];
let inRules = false;
for (const line of rage.stdout.split('\n')) {
  if (line === '  Enabled rules:') {
    inRules = true;
    continue;
  }
  if (inRules && /^    [a-z0-9]+\/[A-Za-z0-9]+$/.test(line)) {
    rules.push(line.trim());
  }
}
if (rules.length === 0) {
  console.error('✗ Biome reported no enabled rules; refusing to treat an incomplete inventory as safe');
  process.exit(1);
}

const configSource = fs.readFileSync(configPath, 'utf8');
const { parse } = require('jsonc-parser');
const errors = [];
const config = parse(configSource, errors, { allowTrailingComma: true });
if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) {
  console.error(`✗ Biome policy config could not be parsed: ${configPath}`);
  process.exit(1);
}
function isExplicitError(group, rule) {
  const value = config?.linter?.rules?.[group]?.[rule];
  return value === 'error' || (value && typeof value === 'object' && value.level === 'error');
}

let nonErrorDefaults = 0;
for (const qualifiedName of rules) {
  const [group, rule] = qualifiedName.split('/');
  const explained = spawnSync(biome, ['explain', rule], { cwd: root, encoding: 'utf8' });
  if (explained.error || explained.status !== 0) {
    console.error(`✗ Could not inspect Biome default severity for ${qualifiedName}: ${explained.error?.message ?? explained.stderr.trim()}`);
    process.exit(1);
  }
  const match = explained.stdout.match(/^- Default severity: (error|warn|info)$/m);
  if (!match) {
    console.error(`✗ Biome did not report a recognized default severity for ${qualifiedName}`);
    process.exit(1);
  }
  if (match[1] !== 'error') {
    nonErrorDefaults += 1;
    if (!isExplicitError(group, rule)) {
      console.error(`✗ Recommended ${qualifiedName} defaults to ${match[1]} but has no explicit error setting`);
      process.exit(1);
    }
  }
}
console.log(`✓ Biome policy audited ${rules.length} enabled rules; ${nonErrorDefaults} non-error defaults are explicit errors.`);
NODE

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/georoids-lint-policy.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

bad_warn="$tmp_dir/biome-warn.jsonc"
bad_info="$tmp_dir/biome-info.jsonc"
bad_on="$tmp_dir/biome-on.jsonc"
malformed="$tmp_dir/biome-malformed.jsonc"
read_error="$tmp_dir/read-error"
warning_config="$tmp_dir/biome-warning.jsonc"
warning_source="$tmp_dir/warning.ts"
sed 's/"noUnusedVariables": "error"/"noUnusedVariables": "warn"/' "$CONFIG" >"$bad_warn"
sed 's/"useTemplate": "error"/"useTemplate": "info"/' "$CONFIG" >"$bad_info"
printf '{ "linter": { "rules": { "correctness": "on" } } }\n' >"$bad_on"
printf '{ "linter": {' >"$malformed"
mkdir "$read_error"
cat >"$warning_config" <<'EOF'
{
  "files": { "includes": ["**/*.ts"] },
  "linter": {
    "enabled": true,
    "rules": { "preset": "none", "correctness": { "noUnusedVariables": "warn" } }
  },
  "formatter": { "enabled": false }
}
EOF
printf 'const lintPolicyUnusedFixture = 1;\n' >"$warning_source"

for fixture in "$bad_warn" "$bad_info" "$bad_on" "$malformed" "$read_error" "$warning_config"; do
  if check_config "$fixture" >/dev/null 2>&1; then
    echo "✗ Biome policy accepted invalid fixture: $fixture" >&2
    exit 1
  fi
done

warning_output="$tmp_dir/warning-output.txt"
if "$BIOME" lint --error-on-warnings --config-path "$warning_config" "$warning_source" >"$warning_output" 2>&1; then
  echo "✗ Biome accepted the warning fixture; --error-on-warnings is not enforcing the policy" >&2
  exit 1
fi
if ! grep -Eq 'warning|error' "$warning_output"; then
  echo "✗ Biome rejected the warning fixture without an actionable diagnostic" >&2
  cat "$warning_output" >&2
  exit 1
fi

echo "✓ Biome policy rejects warn/info/on, malformed/unreadable configs, and a real lint warning."
