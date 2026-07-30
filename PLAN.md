# unlocalhost — Implementation Plan (agent handoff)

## Goal

Build a **CLI-first** tool to run **many HTTP projects in parallel** on one machine (typically a Mac always-on host), with:

- **One local reverse proxy (Caddy)** terminating **HTTPS** and routing by hostname
- **Optional one Cloudflare Tunnel** (always-on), wildcard DNS only
- **Zero modifications inside team project repos** (no committed config, no compose patches in the project tree)
- **Agent-friendly** commands (non-interactive defaults, stable output, optional `--json`)

Product name: **`unlocalhost`**. The npm package is `unlocalhost-cli`; the
installed command is `unlocalhost`.

This replaces the mental model of “one IP per project + `/etc/hosts`” with “hostname → proxy → container/port”.

---

## Non-goals (v1)

- Web UI / dashboard (maybe later; same library as CLI)
- Framework-specific logic (Laravel, Next, etc.) — **fully agnostic**
- Patching `/etc/hosts` or allocating `10.0.0.x` as the core design
- Per-project Cloudflare tunnels or per-project DNS records
- Replacing Docker Compose features
- Production PaaS / multi-tenant hosting
- Coupling to T3 Code (may be used *by* agents, not built into T3)

---

## Problem statement (why this exists)

Running many compose stacks at once fights over host ports (everyone wants `:80`).  
The old approach (unique host IPs + hosts file) works but is Mac-centric, team-hostile if baked into repos, and awkward for HTTPS / remote clients.

Target model:

```text
Browser (local or remote)
    → Caddy (HTTPS, Host-based routing)   [always one]
        → project A upstream
        → project B upstream
    ↑
cloudflared (optional, one named tunnel, wildcard DNS)
```

Local fallback when tunnel is down: still use Caddy on localhost (e.g. `https://name.localhost` or local hostnames), no Cloudflare required for Studio-only work.

---

## Design principles

1. **Project repos stay clean** — all tool state under `~/.unlocalhost/` (configurable base dir).
2. **One Caddy, one tunnel** — not one process per project.
3. **Wildcard DNS forever** — e.g. `*.dev.example.com` → tunnel; adding a project never touches Cloudflare DNS again.
4. **CLI is the product** — agents run the same commands as humans.
5. **Docker Compose is optional** — a project can be “compose path + service” or “bare upstream URL/port”.
6. **Do not rewrite team compose files** — if host publish ports are needed beyond what the team file exposes, use an **external** override file under `~/.unlocalhost/overrides/`, passed via `docker compose -f … -f …`, never written into the project repo.

---

## Architecture

### Processes (machine-level)

| Process | Role | Lifecycle |
|---------|------|-----------|
| `caddy` | HTTPS + reverse proxy by hostname | Always-on via launchd (macOS) / systemd (Linux) or supervised by `unlocalhost doctor` |
| `cloudflared` | Named tunnel → `https://127.0.0.1:<caddy-https-port>` or HTTP port Caddy listens on for tunnel | Always-on, optional |
| Project stacks | `docker compose up/down` per registered project | On demand |

### Config layout

```text
~/.unlocalhost/
  config.toml                 # global settings
  projects/
    <id>.toml                 # one file per project (external registry)
  overrides/
    <id>.yml                  # optional compose override, never in team repo
  caddy/
    Caddyfile                 # generated — do not hand-edit as source of truth
  cloudflared/
    config.yml                # generated
  logs/                       # optional
```

Base dir override: `UNLOCALHOST_HOME` or `--home`.

### Global config (`config.toml`) — suggested keys

```toml
# ~/.unlocalhost/config.toml
default_projects_root = "~/Sites"     # only a hint for `add` / discovery
caddy_http_port = 80                  # optional; prefer not fighting system
caddy_https_port = 443                # or 8443 if no root
# For local HTTPS without real DNS, use *.localhost (Caddy/local)
local_domain_suffix = "localhost"     # names become <slug>.localhost
# Public wildcard zone (Cloudflare)
public_domain = "dev.stemonte.io"     # hostnames: <slug>.dev.stemonte.io
tunnel_enabled = true
tunnel_name = "unlocalhost"
# cloudflare api token path or env CLOUDFLARE_API_TOKEN
```

Exact ports: prefer a design that **does not require root** if possible (e.g. Caddy on `127.0.0.1:8443` / `:8080`, tunnel points there). Document root ports as optional advanced.

### Project registration (`projects/<id>.toml`) — suggested schema

```toml
id = "dailygram"
name = "dailygram"
path = "/Users/…/Sites/dailygram"
# Public and/or local hostnames (tool can derive both from slug)
slug = "dailygram"
# hostname_public = "dailygram.dev.stemonte.io"  # derived: <slug>.<public_domain>
# hostname_local  = "dailygram.localhost"        # derived

# How to start (optional)
compose_file = "docker-compose.yml"   # relative to path; if set, up/down use compose
compose_override = ""                 # optional path under ~/.unlocalhost/overrides/

# Where HTTP actually is after start (required for routing)
# Prefer explicit so we never invent framework magic:
[upstream]
# One of:
# mode = "host_port"  + host = "127.0.0.1" + port = 8026
# mode = "compose_service" + service = "web" + port = 80
#   (resolve published port or join docker network — implement one solid approach and document it)
mode = "host_port"
host = "127.0.0.1"
port = 8026
```

**Critical implementation choice (pick one for v1 and stick to it):**

**Recommended for v1 (simplest, team-safe):**  
`upstream.mode = host_port` only.  
User (or `unlocalhost add` interactive once / flags) sets which localhost port the stack already publishes.  
If the team compose does not publish a stable port, create **`~/.unlocalhost/overrides/<id>.yml`** that only adds a `ports:` mapping like `127.0.0.1:8026:80`, applied with extra `-f`, **not** committed to the team repo.

Defer “auto join docker network + route to service name” to v2 if needed.

### Caddy

- Generate Caddyfile from all **enabled/up** projects (or all registered — document behavior).
- Each site: hostname(s) → `reverse_proxy host:port`.
- Local HTTPS: `https://<slug>.localhost` (Caddy local CA / automatic HTTPS for localhost).
- Public: `<slug>.<public_domain>` may only work when tunnel + CF DNS wildcard exist; Caddy still routes them when requests arrive (from tunnel).

Regenerate + `caddy reload` on add/rm/up/down that changes routes.

### Cloudflare Tunnel

- **One named tunnel**, config in `~/.unlocalhost/cloudflared/config.yml`.
- Ingress: all traffic for `*.public_domain` (and maybe catch-all 404) → Caddy HTTP or HTTPS endpoint.
- Prefer pointing tunnel at Caddy’s **HTTP** listener on loopback if TLS is terminated at Cloudflare (orange cloud), **or** at HTTPS if you want end-to-end — document one choice. Simplest: CF terminates TLS, tunnel → `http://127.0.0.1:8080`, Caddy does Host routing on HTTP for that entrypoint **or** Caddy only HTTP on loopback for tunnel and HTTPS for local `.localhost`.  
  Clean approach:
  - Caddy `:8080` HTTP (Host routing) — used by cloudflared
  - Caddy `:8443` HTTPS — used by local browser with `.localhost` or local domain
  - Same route blocks for both

- DNS: **only** wildcard `*.dev.example.com` CNAME to `<tunnel-id>.cfargotunnel.com` (proxied). Never per-app DNS in v1.
- Install as user LaunchAgent (macOS) / systemd user unit (Linux) with restart.
- “Tunnels die after a while” is solved by **service supervision**, not by more tunnels.

### CLI surface (v1)

```text
unlocalhost init                     # create ~/.unlocalhost, default config
unlocalhost doctor                   # caddy/cloudflared/docker present, ports, tunnel health

unlocalhost add <path> --slug <s> [--port <hostPort>] [--compose <file>]
unlocalhost rm <id>
unlocalhost list
unlocalhost show <id>

unlocalhost up <id|--all>
unlocalhost down <id|--all>
unlocalhost restart <id>
unlocalhost status [<id>] [--json]
unlocalhost url <id> [--local|--public]

unlocalhost proxy install|uninstall|start|stop|status|reload   # Caddy service
unlocalhost caddy rebuild                                      # regenerate Caddyfile + reload

unlocalhost tunnel guide
unlocalhost tunnel init          # create named tunnel if needed, write config, ensure wildcard DNS if token available
unlocalhost tunnel install|uninstall|start|stop|status
unlocalhost tunnel open-dashboard   # optional convenience
```

Global flags: `--home`, `--json` where useful, `--yes` for non-interactive.

Exit codes: 0 ok, non-zero failure; agents depend on this.

### Agent ergonomics

- No prompts if all required flags/config present.
- `status --json` schema documented in README.
- `url` prints single URL on stdout (easy to capture).
- Logs of long operations on stderr.

---

## Cloudflare setup flow (wildcard-only)

### Documented manual path (`tunnel guide`)

1. Domain on Cloudflare.
2. Create API token (Account: Cloudflare Tunnel; Zone: DNS Edit) **or** use `cloudflared tunnel login`.
3. `unlocalhost tunnel init`.
4. Ensure wildcard DNS once.
5. `unlocalhost tunnel install` + `unlocalhost proxy install`.

### Automated path (`tunnel init`)

Prefer wrapping:

- `cloudflared tunnel create unlocalhost` (if missing)
- `cloudflared tunnel token` / credentials file in `~/.unlocalhost/cloudflared/`
- DNS: Cloudflare API `PUT`/`POST` CNAME `*.dev` → `<id>.cfargotunnel.com` proxied  
  **or** `cloudflared tunnel route dns` if it supports wildcard cleanly — verify and pick one.

If token missing: print exact guide + `open-dashboard` links; do not fake success.

**Browser pre-fill of full tunnel config is not reliable** — do not depend on it.

---

## Implementation phases (for the coding agent)

### Phase 0 — Repo skeleton

- Init git repo (user will open-source later).
- Language recommendation: **Go** (single binary, easy LaunchAgent) **or** **TypeScript (Node 22+)** if faster for the implementer — pick one, don’t mix.
- `README.md` with architecture diagram (text), install, quickstart.
- License MIT.
- `examples/README.md` only (no framework lock-in); optional fake upstream containers for tests.

### Phase 1 — Core registry + Caddy generate

- `init`, `add`, `rm`, `list`, `show`
- Caddyfile generation from projects with `upstream.host_port`
- `caddy rebuild` + run Caddy in foreground for dev; `proxy install` LaunchAgent
- Local HTTPS via `https://<slug>.localhost` (validate on macOS)
- Acceptance: two dummy listeners on different ports, two hostnames via Caddy HTTPS

### Phase 2 — Docker compose up/down

- `up`/`down` using project `path` + `compose_file` + optional external override `-f`
- Do not modify project directory files
- `status` shows compose running + proxy route present + optional HTTP health check to upstream
- Acceptance: register two real local apps (or examples) without changing their git trees

### Phase 3 — Cloudflare tunnel + wildcard

- Generated cloudflared config → single origin Caddy
- `tunnel init/install/status`
- Wildcard DNS ensure
- Acceptance: public `https://slug.public_domain` hits same app as local URL while tunnel service runs; kill tunnel service → local URL still works

### Phase 4 — Polish

- `doctor`
- `--json` on status/list
- Good error messages (port in use, docker down, caddy validation fail)
- Unit tests for config/Caddyfile generation; minimal integration test if feasible

---

## Acceptance criteria (v1 done)

1. Two projects registered **outside** their repos; `git status` clean inside both project repos after `add`/`up`.
2. Both up in parallel; `https://a.localhost` and `https://b.localhost` (or chosen local scheme) route correctly.
3. Optional: both reachable via `https://a.<public_domain>` and `https://b.<public_domain>` with **only wildcard DNS**, one tunnel process.
4. Tunnel process supervised (restart on crash); documented.
5. `unlocalhost status --json` usable by an agent.
6. README explains local fallback when Cloudflare is down.
7. No Laravel/PHP-specific code paths.

---

## Dogfood (optional)

Use any two local HTTP apps or the repo’s example containers.  
For dogfood without dirtying team compose: prefer **external override** mapping `127.0.0.1:<uniquePort>:80`.

---

## Security notes (document in README)

- Tunnel + orange cloud exposes apps to the internet on that hostname — recommend Cloudflare Access later; v1 at least warn.
- API tokens stored with user-only permissions in `~/.unlocalhost`.
- Bind upstream ports to `127.0.0.1` only when generating overrides.

---

## Suggested first PR sequence (if stacking)

1. Skeleton + config types + `init`/`add`/`list`
2. Caddyfile generate + proxy run/reload + local HTTPS
3. Compose up/down + overrides path
4. Tunnel service + wildcard DNS
5. Doctor + JSON + docs polish

---

## Out of scope reminders for the agent

- Do not add a web UI in v1.
- Do not require files inside project repositories.
- Do not create per-project tunnels or per-project DNS.
- Do not implement framework env patching (`APP_URL`) automatically unless behind an explicit optional flag later — v1 prints the public/local URL and lets the user/agent set env themselves.

---

## Definition of “pass to next human”

Ship a binary or `go run`/`npx` path, README quickstart with **wildcard** CF section, and a short `docs/concepts.md` explaining: compose vs proxy vs tunnel, and why IPs are unnecessary when Caddy routes by Host.

---

## One-paragraph pitch (for README)

> unlocalhost runs many local HTTP apps at once without port chaos: an external project registry, one Caddy for HTTPS hostname routing, and one optional Cloudflare tunnel with a single wildcard DNS record. Project git repos stay untouched so teams are not forced into personal tooling.

---

*Plan derived from product discussion: multi-machine host (e.g. Mac Studio), CLI for humans and coding agents, Caddy OK, wildcard CF only, no UI required for MVP.*
