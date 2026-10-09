#!/usr/bin/env bash
# ollama-load.sh — Load all 14 fabric-sdk vLLM Modelfiles into Ollama
#
# Usage:
#   bash scripts/ollama-load.sh                  # load all models
#   bash scripts/ollama-load.sh k3s-ops          # load one specific model
#   bash scripts/ollama-load.sh --dry-run        # print commands without executing
#   bash scripts/ollama-load.sh --check          # verify which models are already loaded
#
# Prerequisites:
#   - Ollama running (ollama serve or systemctl start ollama)
#   - .env.fabric sourced or exported in current shell
#   - git CLI available (to clone repos)
#   - Each vLLM repo cloned under REPOS_DIR (default: ~/fabric-vllm)
#
# Repo naming convention: git-fabric/<name>-vllm
#   e.g. git-fabric/k3s-ops-vllm → model name: k3s-ops

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────
OLLAMA_ENDPOINT="${OLLAMA_ENDPOINT:-http://localhost:11434}"
REPOS_DIR="${FABRIC_VLLM_DIR:-$HOME/fabric-vllm}"
GH_ORG="${FABRIC_VLLM_ORG:-git-fabric}"
DRY_RUN=false
CHECK_ONLY=false
TARGET_MODEL=""

# ─── Color output ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()    { echo -e "${BLUE}[fabric]${RESET} $*"; }
ok()     { echo -e "${GREEN}[  ok  ]${RESET} $*"; }
warn()   { echo -e "${YELLOW}[ warn ]${RESET} $*"; }
err()    { echo -e "${RED}[ fail ]${RESET} $*" >&2; }
header() { echo -e "\n${BOLD}${CYAN}$*${RESET}"; }

# ─── Model registry ───────────────────────────────────────────────────────────
# Format: "model-name:repo-name"
# repo-name is the GitHub repo under $GH_ORG
declare -a MODELS=(
  "fabric-router:fabric-router-vllm"
  "fabric-invoke-ops:fabric-invoke-vllm"
  "unifi-ops:unifi-vllm"
  "proxmox-ops:proxmox-vllm"
  "k3s-ops:k3s-vllm"
  "tailscale-ops:tailscale-vllm"
  "sandfly-ops:sandfly-vllm"
  "cloudflare-ops:cloudflare-vllm"
  "n8n-ops:n8n-vllm"
  "github-ops:github-vllm"
  "cve-ops:cve-vllm"
  "git-steer-ops:git-steer-vllm"
  "aiana-ops:aiana-vllm"
  "qdrant-fabric-ops:qdrant-vllm"
)

# ─── Placeholder tokens to resolve from env ───────────────────────────────────
# Each entry: "PLACEHOLDER:ENV_VAR"
# If ENV_VAR is empty, placeholder is left as-is (non-blocking for Tier 2+)
declare -a TOKENS=(
  # Tier 1 — block all invocations if missing
  "{{OLLAMA_ENDPOINT}}:OLLAMA_ENDPOINT"
  "{{AIANA_MCP_URL}}:AIANA_MCP_URL"
  "{{GATEWAY_URL}}:GATEWAY_URL"
  # Tier 2 — block individual specialist
  "{{QDRANT_URL}}:QDRANT_URL"
  "{{QDRANT_API_KEY}}:QDRANT_API_KEY"
  "{{NVD_API_KEY}}:NVD_API_KEY"
  "{{CF_API_TOKEN}}:CF_API_TOKEN"
  "{{CF_ACCOUNT_ID}}:CF_ACCOUNT_ID"
  "{{CF_ZONE_ID}}:CF_ZONE_ID"
  "{{GH_APP_INSTALLATION_TOKEN}}:GH_APP_INSTALLATION_TOKEN"
  "{{SANDFLY_URL}}:SANDFLY_URL"
  "{{SANDFLY_USER}}:SANDFLY_USER"
  "{{SANDFLY_PASS}}:SANDFLY_PASS"
  "{{PROXMOX_HOST}}:PROXMOX_HOST"
  "{{PROXMOX_TOKEN_ID}}:PROXMOX_TOKEN_ID"
  "{{PROXMOX_TOKEN_SECRET}}:PROXMOX_TOKEN_SECRET"
  "{{UNIFI_API_KEY}}:UNIFI_API_KEY"
  "{{UNIFI_LOCAL_HOST}}:UNIFI_LOCAL_HOST"
  "{{TAILSCALE_API_KEY}}:TAILSCALE_API_KEY"
  "{{TAILSCALE_TAILNET}}:TAILSCALE_TAILNET"
  "{{N8N_API_KEY}}:N8N_API_KEY"
  "{{N8N_BASE_URL}}:N8N_BASE_URL"
)

# ─── Parse args ───────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=true ;;
    --check)      CHECK_ONLY=true ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] [--check] [model-name]"
      echo "  --dry-run   Print ollama create commands without executing"
      echo "  --check     Show which models are loaded vs missing"
      echo "  model-name  Load only this one model (e.g. k3s-ops)"
      exit 0 ;;
    -*)
      err "Unknown flag: $arg"; exit 1 ;;
    *)
      TARGET_MODEL="$arg" ;;
  esac
done

# ─── Helpers ──────────────────────────────────────────────────────────────────
ollama_loaded() {
  local model="$1"
  curl -sf "${OLLAMA_ENDPOINT}/api/tags" 2>/dev/null \
    | grep -q "\"name\":\"${model}" && return 0 || return 1
}

resolve_tokens() {
  local content="$1"
  for token_entry in "${TOKENS[@]}"; do
    local placeholder="${token_entry%%:*}"
    local env_var="${token_entry##*:}"
    local value="${!env_var:-}"
    if [[ -n "$value" ]]; then
      content="${content//${placeholder}/${value}}"
    fi
    # If value is empty, leave placeholder as-is (Ollama will load but agent will
    # fail at runtime when calling that credential — acceptable for non-Tier-1)
  done
  echo "$content"
}

ensure_repo() {
  local repo="$1"
  local dir="${REPOS_DIR}/${repo}"
  if [[ ! -d "$dir" ]]; then
    log "Cloning ${GH_ORG}/${repo} → ${dir}"
    if $DRY_RUN; then
      echo "  [dry-run] git clone https://github.com/${GH_ORG}/${repo} ${dir}"
    else
      git clone --depth=1 "https://github.com/${GH_ORG}/${repo}" "${dir}" 2>&1 \
        | sed 's/^/  /'
    fi
  else
    log "Repo ${repo} already at ${dir}, pulling latest"
    if ! $DRY_RUN; then
      git -C "${dir}" pull --quiet 2>/dev/null || true
    fi
  fi
}

load_model() {
  local model_name="$1"
  local repo_name="$2"
  local repo_dir="${REPOS_DIR}/${repo_name}"
  local modelfile="${repo_dir}/Modelfile"

  log "Processing: ${BOLD}${model_name}${RESET} (${repo_name})"

  ensure_repo "$repo_name"

  if [[ ! -f "$modelfile" ]]; then
    err "  Modelfile not found: ${modelfile}"
    return 1
  fi

  # Resolve placeholder tokens into a temp Modelfile
  local tmp_modelfile
  tmp_modelfile="$(mktemp /tmp/Modelfile.XXXXXX)"
  local raw_content
  raw_content="$(cat "$modelfile")"
  local resolved_content
  resolved_content="$(resolve_tokens "$raw_content")"
  echo "$resolved_content" > "$tmp_modelfile"

  # Warn about unresolved placeholders
  local unresolved
  unresolved="$(grep -oE '\{\{[A-Z_]+\}\}' "$tmp_modelfile" | sort -u || true)"
  if [[ -n "$unresolved" ]]; then
    warn "  Unresolved placeholders in ${model_name}:"
    echo "$unresolved" | sed 's/^/    /'
    warn "  Model will load but affected tools will fail at runtime until env vars are set."
  fi

  if $DRY_RUN; then
    echo "  [dry-run] ollama create ${model_name} -f ${tmp_modelfile}"
    rm -f "$tmp_modelfile"
    return 0
  fi

  if ollama_loaded "$model_name"; then
    warn "  ${model_name} already loaded — skipping (use 'ollama rm ${model_name}' to force reload)"
    rm -f "$tmp_modelfile"
    return 0
  fi

  log "  Creating ${model_name}..."
  if ollama create "${model_name}" -f "${tmp_modelfile}" 2>&1 | sed 's/^/  /'; then
    ok "  ${model_name} loaded ✓"
  else
    err "  Failed to create ${model_name}"
    rm -f "$tmp_modelfile"
    return 1
  fi

  rm -f "$tmp_modelfile"
}

check_models() {
  header "fabric-sdk Ollama Model Status"
  echo ""
  local loaded=0 missing=0
  for entry in "${MODELS[@]}"; do
    local model="${entry%%:*}"
    if ollama_loaded "$model"; then
      ok "  ${model}"
      ((loaded++))
    else
      warn "  ${model}  ← not loaded"
      ((missing++))
    fi
  done
  echo ""
  log "Loaded: ${loaded}/${#MODELS[@]}   Missing: ${missing}/${#MODELS[@]}"
  if [[ $missing -gt 0 ]]; then
    echo ""
    log "Run 'bash scripts/ollama-load.sh' to load all missing models."
  fi
}

# ─── Tier 1 env var check ─────────────────────────────────────────────────────
check_tier1() {
  local tier1_missing=false
  for var in OLLAMA_ENDPOINT AIANA_MCP_URL GATEWAY_URL; do
    if [[ -z "${!var:-}" ]]; then
      warn "Tier 1 env var not set: ${var}"
      tier1_missing=true
    fi
  done
  if $tier1_missing && ! $DRY_RUN; then
    warn "Tier 1 vars missing — models will load but fabric_invoke will fail at runtime."
    warn "Source .env.fabric before invoking: source .env.fabric"
  fi
}

# ─── Main ─────────────────────────────────────────────────────────────────────
header "fabric-sdk Ollama Loader"
log "Ollama endpoint: ${OLLAMA_ENDPOINT}"
log "Repos dir:       ${REPOS_DIR}"
log "GitHub org:      ${GH_ORG}"
$DRY_RUN   && log "Mode: DRY RUN (no changes will be made)"
$CHECK_ONLY && { check_models; exit 0; }

mkdir -p "${REPOS_DIR}"
check_tier1

echo ""
LOADED=0; FAILED=0; SKIPPED=0

for entry in "${MODELS[@]}"; do
  model="${entry%%:*}"
  repo="${entry##*:}"

  # Filter to single model if specified
  if [[ -n "$TARGET_MODEL" && "$model" != "$TARGET_MODEL" ]]; then
    continue
  fi

  if load_model "$model" "$repo"; then
    ((LOADED++))
  else
    ((FAILED++))
  fi
  echo ""
done

# ─── Summary ─────────────────────────────────────────────────────────────────
header "Summary"
ok  "Loaded:  ${LOADED}"
[[ $FAILED  -gt 0 ]] && err  "Failed:  ${FAILED}"
echo ""

if ! $DRY_RUN && [[ $FAILED -eq 0 ]]; then
  log "All models ready. Verify with:"
  echo "  bash scripts/ollama-load.sh --check"
  echo "  curl -s ${OLLAMA_ENDPOINT}/api/tags | jq '.models[].name'"
  echo ""
  log "Test routing:"
  echo "  curl -s -X POST http://localhost:8080/invoke \\"
  echo "    -H 'Content-Type: application/json' \\"
  echo "    -d '{\"query\": \"Is my k3s cluster healthy?\", \"dry_run\": true}'"
fi
