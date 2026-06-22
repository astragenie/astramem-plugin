#!/usr/bin/env bash
# Shared env loader for memory hooks.
#
# Resolution order for legacy MEMORY_* plugin-file env vars (first match wins):
#   1. $MEMORY_ENV explicitly set in the shell  -> $CLAUDE_PLUGIN_ROOT/.env.$MEMORY_ENV
#   2. $CLAUDE_PLUGIN_ROOT/.env                 -> gitignored user override
#   3. defaultEnv from plugin.json              -> $CLAUDE_PLUGIN_ROOT/.env.<defaultEnv>
#   4. $CLAUDE_PLUGIN_ROOT/.env.local           -> hard fallback
#
# Resolution order for ASTRAMEMORY_API_URL + ASTRAMEMORY_API_KEY (highest precedence first):
#   1. $ASTRAMEMORY_API_URL / $ASTRAMEMORY_API_KEY explicit env vars (legacy override — AC16,
#      deprecated at v1.7)
#   2. ~/.astramemory/profiles.json[$ASTRAMEMORY_ENV].apiUrl
#      + ~/.astramemory/tokens.$ASTRAMEMORY_ENV.json[<workspace>].apiKey
#   3. Default ASTRAMEMORY_ENV=prod
#   4. Default workspace = basename of cwd (repo name; same as existing project_id)
#
# When ASTRAMEMORY_HOOK_DEBUG=1, one line is written to stderr per sourcing:
#   [astramemory-hook] script=<name> env=<env> workspace=<w> url=<u>
#                      key_source=<env|profile|legacy_default> outcome=<ok|skipped:<reason>>
# The key value is NEVER logged.

set +e
set -u

_memory_load_env() {
  local plugin_root="${CLAUDE_PLUGIN_ROOT:-}"
  if [ -z "$plugin_root" ]; then
    plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  fi

  local candidate=""

  if [ -n "${MEMORY_ENV:-}" ]; then
    candidate="$plugin_root/.env.$MEMORY_ENV"
  fi

  if [ -z "$candidate" ] || [ ! -f "$candidate" ]; then
    if [ -f "$plugin_root/.env" ]; then
      candidate="$plugin_root/.env"
    fi
  fi

  if [ -z "$candidate" ] || [ ! -f "$candidate" ]; then
    if command -v jq >/dev/null 2>&1 && [ -f "$plugin_root/.claude-plugin/plugin.json" ]; then
      local default_env
      default_env="$(jq -r '.defaultEnv // empty' "$plugin_root/.claude-plugin/plugin.json" 2>/dev/null)"
      if [ -n "$default_env" ] && [ -f "$plugin_root/.env.$default_env" ]; then
        candidate="$plugin_root/.env.$default_env"
      fi
    fi
  fi

  if [ -z "$candidate" ] || [ ! -f "$candidate" ]; then
    candidate="$plugin_root/.env.local"
  fi

  if [ -f "$candidate" ]; then
    # shellcheck disable=SC1090
    set -a
    . "$candidate"
    set +a
  fi
}

_astramemory_resolve_profile() {
  # Resolve ASTRAMEMORY_API_URL + ASTRAMEMORY_API_KEY from profile files.
  # Caller scripts export ASTRAMEMORY_HOOK_SCRIPT_NAME before sourcing to get
  # a useful debug line; defaults to "_load-env" if not set.

  local script_name="${ASTRAMEMORY_HOOK_SCRIPT_NAME:-_load-env}"
  local am_env="${ASTRAMEMORY_ENV:-prod}"
  local profiles="$HOME/.astramemory/profiles.json"
  local tokens="$HOME/.astramemory/tokens.${am_env}.json"
  # cwd may be set by the hook payload later, but at load time we use PWD.
  local workspace_id
  workspace_id="$(basename "${cwd:-$PWD}")"

  local resolved_url=""
  local resolved_key=""
  local url_source="legacy_default"
  local key_source="legacy_default"

  # Profile file lookup (requires jq)
  if command -v jq >/dev/null 2>&1; then
    if [ -f "$profiles" ]; then
      resolved_url="$(jq -r --arg e "$am_env" '.[$e].apiUrl // empty' "$profiles" 2>/dev/null)"
    fi
    if [ -f "$tokens" ]; then
      resolved_key="$(jq -r --arg w "$workspace_id" '.[$w].apiKey // empty' "$tokens" 2>/dev/null)"
    fi
  fi

  # Mark sources before env-var override wins
  [ -n "$resolved_url" ] && url_source="profile"
  [ -n "$resolved_key" ] && key_source="profile"

  # Legacy env-var wins on conflict (AC16 one-release fallback through v1.6)
  if [ -n "${ASTRAMEMORY_API_URL:-}" ]; then
    url_source="env"
  fi
  if [ -n "${ASTRAMEMORY_API_KEY:-}" ]; then
    key_source="env"
  fi

  # Final resolution with explicit fallback chain (avoids nested :-default quirks
  # under set -u when intermediate vars are local-scoped empty strings).
  local final_url=""
  if [ -n "${ASTRAMEMORY_API_URL:-}" ]; then
    final_url="$ASTRAMEMORY_API_URL"
  elif [ -n "$resolved_url" ]; then
    final_url="$resolved_url"
  elif [ -n "${CORTEX_API_URL:-}" ]; then
    final_url="$CORTEX_API_URL"
  else
    final_url="http://localhost:5201"
  fi
  ASTRAMEMORY_API_URL="$final_url"

  local final_key=""
  if [ -n "${ASTRAMEMORY_API_KEY:-}" ]; then
    final_key="$ASTRAMEMORY_API_KEY"
  elif [ -n "$resolved_key" ]; then
    final_key="$resolved_key"
  elif [ -n "${CORTEX_API_KEY:-}" ]; then
    final_key="$CORTEX_API_KEY"
  else
    final_key="dev-bootstrap-local"
  fi
  ASTRAMEMORY_API_KEY="$final_key"

  export ASTRAMEMORY_API_URL ASTRAMEMORY_API_KEY

  # Export resolution metadata for _ingest-transcript.sh debug line
  export _AM_ENV="$am_env"
  export _AM_WORKSPACE="$workspace_id"
  export _AM_URL_SOURCE="$url_source"
  export _AM_KEY_SOURCE="$key_source"

  # AC13: emit one stderr debug line per sourcing when ASTRAMEMORY_HOOK_DEBUG=1.
  # NEVER include the key value — only url + source flags.
  if [ "${ASTRAMEMORY_HOOK_DEBUG:-}" = "1" ]; then
    printf '[astramemory-hook] script=%s env=%s workspace=%s url=%s url_source=%s key_source=%s\n' \
      "$script_name" "$am_env" "$workspace_id" "$ASTRAMEMORY_API_URL" "$url_source" "$key_source" >&2
  fi
}

_memory_load_env
_astramemory_resolve_profile
