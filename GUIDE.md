# unlocalhost guide

This guide is the operational reference for humans and coding agents. Start
with the short [README](README.md) for the purpose and architecture.

## Contents

1. [Mental model](#mental-model)
2. [Install and dependencies](#install-and-dependencies)
3. [Migrating from the devhost alpha](#migrating-from-the-devhost-alpha)
4. [First local setup](#first-local-setup)
5. [Remote access with Cloudflare](#remote-access-with-cloudflare)
6. [Register a Compose project](#register-a-compose-project)
7. [Register a non-Compose project](#register-a-non-compose-project)
8. [Multiple HTTP endpoints](#multiple-http-endpoints)
9. [Vite and other Node development servers](#vite-and-other-node-development-servers)
10. [Laravel behind the proxy](#laravel-behind-the-proxy)
11. [Lifecycle and restarts](#lifecycle-and-restarts)
12. [Agent and automation workflow](#agent-and-automation-workflow)
13. [Troubleshooting](#troubleshooting)
14. [Command reference](#command-reference)

## Mental model

unlocalhost keeps the complete development environment on its original machine
and makes its HTTP endpoints reachable through stable HTTPS hostnames. It does
not upload, rebuild, or deploy the project elsewhere:

```text
Local browser
    └─ HTTPS ─→ Caddy ─→ 127.0.0.1:<allocated-port> ─→ application

Remote browser
    └─ HTTPS ─→ Cloudflare Tunnel ─→ Caddy ─→ application
```

There is one machine-wide Caddy proxy and, when remote access is enabled, one
machine-wide Cloudflare Tunnel with one wildcard DNS record. Projects do not
receive their own proxy, tunnel, DNS record, or manually selected host port.

unlocalhost stores its registry and generated files under `~/.unlocalhost` by default:

```text
~/.unlocalhost/
  config.toml
  projects/<id>.toml
  overrides/<id>.yml
  caddy/Caddyfile
  cloudflared/config.yml
  logs/
```

Set `UNLOCALHOST_HOME` or pass global `--home <path>` to use another location.

### What unlocalhost manages

- Stable project and endpoint hostnames.
- Automatic, loopback-only host port allocation.
- External Compose overrides that replace conflicting published ports.
- Generated Caddy routes and supervised Caddy service.
- One optional wildcard Cloudflare Tunnel and its supervised service.
- Saved commands for non-Compose processes.
- Human-readable output and versioned JSON status for agents.

### What unlocalhost does not manage

- Application dependencies, migrations, framework configuration, or secrets.
- Per-project Cloudflare tunnels or DNS records.
- Internal database or cache ports unless explicitly registered as HTTP.
- Arbitrary commands inside an already-defined Compose service.
- Production deployment or application authentication.

The CLI never patches a registered repository. Framework-specific edits shown
in this guide are deliberate application changes made by a person or agent, not
automatic unlocalhost behavior.

## Install and dependencies

unlocalhost requires Node.js 22 or newer. Other dependencies are conditional:

- Caddy is required for local HTTPS and routing.
- Docker Compose 2.24.4 or newer is required only for Compose projects.
- cloudflared is required only for public tunnel access.

On macOS:

```sh
brew install caddy
brew install cloudflared # only for public access
```

Install Docker Desktop only when Compose projects are used. On Linux and
Windows, run `unlocalhost doctor`; missing dependency errors include the appropriate
installation instructions and official links.

Choose one installation method. For normal use, install the published alpha:

```sh
npm install --global unlocalhost-cli@alpha
```

That command installs the `unlocalhost` executable. Continue to the first local
setup below; do not also run the source-build commands.

Only contributors developing unlocalhost itself should clone this repository
and use this alternative:

```sh
npm install
npm run build
npm link
unlocalhost --help
```

Use `npm run dev -- <arguments>` to run the TypeScript entry point without a
global link.

The npm package is named `unlocalhost-cli`; the installed command and product
name are both `unlocalhost`. Use the explicit `@alpha` tag until a stable
release is published. npm requires every package to retain a `latest` tag, so
the first alpha may also resolve without a tag; `@alpha` remains the supported
prerelease channel.

## Migrating from the devhost alpha

The rename changes the command, state directory, environment variables, and
supervised service labels. Preserve existing registrations with this one-time
migration before installing the new services:

```sh
devhost proxy uninstall
devhost tunnel uninstall # skip when no tunnel was installed
mv ~/.devhost ~/.unlocalhost
npm uninstall --global devhost-cli
npm install --global unlocalhost-cli@alpha
unlocalhost proxy install
unlocalhost tunnel install # only when the tunnel is configured
unlocalhost doctor
```

If the old CLI was linked from this repository, run `npm unlink --global
devhost-cli` instead of uninstalling it, then build and link the renamed
package. Custom installations should move the directory selected by
`DEVHOST_HOME` to the new `UNLOCALHOST_HOME` value.

The migration never touches registered project repositories.

## First local setup

Initialize external state, install the supervised proxy, and trust Caddy's local
certificate authority once:

```sh
unlocalhost init
unlocalhost proxy install
caddy trust
unlocalhost doctor
```

The default local URL format is:

```text
https://<slug>.localhost:8443
```

The defaults use unprivileged Caddy ports: `8080` for the tunnel origin and
`8443` for local HTTPS. Standard ports `80` and `443` can be configured in
`~/.unlocalhost/config.toml`, but binding them may require additional operating
system privileges.

For temporary foreground use instead of a service:

```sh
unlocalhost proxy run
```

## Remote access with Cloudflare

Remote access uses one locally managed Cloudflare Tunnel and one proxied
wildcard record:

```text
*.example.com → <tunnel-id>.cfargotunnel.com
```

Adding a project later does not create or modify Cloudflare resources.

### Interactive authentication

```sh
cloudflared tunnel login
unlocalhost tunnel init --domain example.com --name unlocalhost
unlocalhost tunnel install
unlocalhost proxy install
unlocalhost tunnel status
```

### Token-based automation

Set `CLOUDFLARE_API_TOKEN` or point `CLOUDFLARE_API_TOKEN_FILE` at a protected
file. The token needs Cloudflare Tunnel Edit at account scope and DNS Edit at
zone scope.

```sh
export CLOUDFLARE_API_TOKEN='...'
unlocalhost tunnel init \
  --domain example.com \
  --name unlocalhost \
  --account-id <account-id> \
  --zone-id <zone-id>
unlocalhost tunnel install
```

`tunnel init` creates or reuses one named tunnel, writes protected credentials
under `~/.unlocalhost`, and creates or updates only the wildcard CNAME. If
authentication or permissions are missing, it exits non-zero with the next
required step.

Run this at any time for the current setup checklist:

```sh
unlocalhost tunnel guide
```

### Certificate and exposure considerations

Cloudflare free Universal SSL on a full zone normally covers the apex and
first-level subdomains. `app.example.com` is covered; a nested hostname such as
`app.dev.example.com` may require Total TLS, an Advanced Certificate, or custom
certificate coverage.

A wildcard tunnel makes matching applications internet-reachable. Add
Cloudflare Access before exposing sensitive development data, and treat the
applications as untrusted.

## Register a Compose project

From any directory:

```sh
unlocalhost add ~/Sites/my-app --slug my-app
```

unlocalhost detects all common current and legacy filenames:

- `compose.yml`
- `compose.yaml`
- `docker-compose.yml`
- `docker-compose.yaml`

It asks Docker Compose for ports declared through `ports` or `expose`. If
several candidates exist, select only HTTP services. MySQL `3306`, Redis `6379`,
and similar internal TCP services must not be selected.

For a non-interactive agent or script:

```sh
unlocalhost --yes add "$PWD" --slug my-app --services web:80
```

Multiple HTTP services can be selected:

```sh
unlocalhost --yes add "$PWD" --slug my-app \
  --services frontend:3000,api:4000
```

The first selection becomes the primary `web` endpoint. When a port is
unambiguous, `--services frontend,api` is sufficient.

Start and inspect the project:

```sh
unlocalhost up my-app
unlocalhost status my-app
unlocalhost url my-app
unlocalhost url my-app --public
```

### How Compose port conflicts are prevented

unlocalhost writes an override outside the project:

```text
~/.unlocalhost/overrides/my-app.yml
```

It uses Compose's `!override` merge tag to replace all original host `ports`
entries. Selected HTTP endpoints receive automatically allocated loopback
mappings:

```text
127.0.0.1:12000 → container:80
```

Unselected services keep their internal container ports but are not published
on the host. Therefore ten MySQL containers may all listen on `3306` inside
their separate Compose networks without a host conflict. Compose 2.24.4 or
newer is required for this replacement behavior.

For unusual files without declared ports, use explicit flags:

```sh
unlocalhost add "$PWD" --slug my-app \
  --compose compose.yaml \
  --service web \
  --container-port 80
```

## Register a non-Compose project

Save a command that honors the injected `HOST` and `PORT` values:

```sh
unlocalhost add "$PWD" --slug my-app \
  --run 'npm run dev -- --host "$HOST" --port "$PORT"'
unlocalhost up my-app
```

unlocalhost injects:

- `HOST`
- `PORT`
- `UNLOCALHOST_PROJECT`
- `UNLOCALHOST_ENDPOINT`
- `UNLOCALHOST_URL`

If an existing server is already listening on a stable loopback port, register
it without a saved command:

```sh
unlocalhost add "$PWD" --slug my-app --port 3000
```

In that case unlocalhost manages the route, not the external process.

## Multiple HTTP endpoints

One logical project can contain a frontend, API, admin application, Vite server,
or any other HTTP endpoint:

```sh
unlocalhost endpoint add my-app api --run 'npm run api'
unlocalhost endpoint list my-app
```

The primary endpoint is always named `web`. Secondary slugs default to
`<project>-<endpoint>`:

```text
web → https://my-app.localhost:8443
api → https://my-app-api.localhost:8443
```

Useful capture-friendly commands:

```sh
unlocalhost port my-app --endpoint api
unlocalhost url my-app --endpoint api
unlocalhost logs my-app --endpoint api
```

Frontend and API endpoints are separate browser origins. Configure application
API URLs and backend CORS explicitly. unlocalhost does not infer same-host `/api`
path routing.

## Vite and other Node development servers

An HTTPS application cannot safely load development assets from
`http://[::1]:5173`: loopback refers to the browser's machine, and HTTPS pages
need an HTTPS/WSS route. Register Vite as a named endpoint so Caddy and the
tunnel proxy both assets and HMR WebSockets.

### Vite inside Compose

Keep the normal internal port in every container and let unlocalhost allocate only
the host port:

```sh
unlocalhost endpoint add my-app vite \
  --service web \
  --container-port 5173
unlocalhost up my-app
unlocalhost endpoint list my-app
```

The resulting mapping may be:

```text
127.0.0.1:12003 → web container:5173
```

Every project can still use internal port `5173`; the generated host ports are
different.

`unlocalhost up` starts the Compose stack. It does not invent an additional command
inside an existing service. If Compose itself does not start Vite, run the
project's normal command exactly once:

```sh
# From the host with Laravel Sail
vendor/bin/sail npm run dev

# Or from a shell already inside that same container
npm run dev
```

Do not run both. If Vite reports `Port 5173 is already in use`, a Vite process
is normally already running in that container. Stop that process or restart the
service; do not allocate another endpoint or change its internal port.

### Vite directly on the host

```sh
unlocalhost endpoint add my-app vite
unlocalhost port my-app --endpoint vite
```

Use the returned port as Vite's host listening port. If the endpoint has a saved
`--run` command, `unlocalhost up` starts it. Otherwise start it manually once.

### Vite public HTTPS and HMR configuration

For Vite 8:

```ts
const viteHost = "my-app-vite.example.com";

export default defineConfig({
  server: {
    host: "0.0.0.0", // use 127.0.0.1 for host-side Vite
    port: 5173,       // use the allocated port for host-side Vite
    strictPort: true,
    origin: `https://${viteHost}`,
    allowedHosts: ["my-app-vite.localhost", viteHost],
    cors: {
      origin: [
        "https://my-app.localhost:8443",
        "https://my-app.example.com",
      ],
    },
    ws: {
      protocol: "wss",
      host: viteHost,
      clientPort: 443,
    },
  },
});
```

Vite 7 and earlier use the same WebSocket values under `server.hmr` instead of
`server.ws`. Keep `allowedHosts` and CORS origins explicit; never use
`allowedHosts: true` or `cors: true` for an internet-reachable development
server.

The same process and port rules apply to Next.js, Webpack dev server, and other
Node HTTP development servers.

## Laravel behind the proxy

Caddy provides HTTPS and forwards the original scheme. Laravel must trust the
immediate proxy address before it uses forwarded scheme information; otherwise
it may generate `http://` manifests, icons, or redirects from an HTTPS page and
the browser will reject them.

In current Laravel middleware configuration:

```php
$middleware->trustProxies(at: ['REMOTE_ADDR']);
```

This trusts the actual immediate peer rather than every address. `APP_URL`
contains a URL, not an IP or CIDR, so it is not a valid replacement for the
trusted proxy address list.

Set `APP_URL` to the application URL appropriate for the current workflow, then
clear cached configuration when it changes. This is application configuration;
unlocalhost does not edit it automatically.

## Lifecycle and restarts

Project commands:

```sh
unlocalhost up my-app
unlocalhost down my-app
unlocalhost restart my-app
unlocalhost up --all
unlocalhost down --all
unlocalhost status
```

On Compose projects, `up` and `down` invoke Docker Compose with the original
file plus the generated external override. On non-Compose projects with saved
commands, unlocalhost owns their process lifecycle and logs.

Caddy and cloudflared are installed as restart-supervised user services:

```sh
unlocalhost proxy install
unlocalhost tunnel install
```

After a machine restart, those two services return automatically. Project
Compose stacks follow their own Docker restart behavior; normally run:

```sh
unlocalhost up my-app
```

Additional development commands not declared by Compose, such as an interactive
`npm run dev` inside a service, must be started once again.

## Agent and automation workflow

An agent asked to “use unlocalhost and expose this project remotely” should follow
this order.

### Copy-paste prompt

From the project directory, give a coding agent this prompt:

```text
Use the installed unlocalhost CLI to configure this project for local HTTPS and
remote development. Read the project instructions, inspect the repository and
any Compose configuration, and do not modify project files unless the framework
strictly requires it.

Run unlocalhost doctor first. Initialize the machine state, Caddy proxy, and
certificate trust only if needed. Detect and register the project's HTTP
endpoints, including its app, API, admin, or Vite server when present. Do not
register databases or caches. Reuse the existing machine-wide Cloudflare tunnel;
if remote access is not configured yet, ask me for the domain before creating it.

Start the project, verify it with unlocalhost --json status, and return every
local and public URL. Pause only when I must approve a password or browser login.
```

### 1. Inspect without mutating

- Read project instructions such as `AGENTS.md`.
- Detect Compose and identify HTTP services and their container ports.
- Identify extra HTTP development servers such as Vite.
- Run `unlocalhost doctor`.
- Check existing machine services with `unlocalhost --json status` and
  `unlocalhost --json tunnel status`.

### 2. Configure machine infrastructure only when missing

- Run `unlocalhost init` if state is not initialized.
- Install the Caddy service if missing.
- Configure the single tunnel only if no tunnel is already configured.
- Never create a per-project tunnel or DNS record.

### 3. Register non-interactively

Compose:

```sh
unlocalhost --yes add "$PWD" --slug <slug> \
  --services <http-service>:<container-port>
```

Non-Compose:

```sh
unlocalhost add "$PWD" --slug <slug> \
  --run '<command that honors $HOST and $PORT>'
```

Add secondary endpoints explicitly. Do not register databases as HTTP.

### 4. Make only required application changes

unlocalhost itself keeps repositories clean. Proxy-aware framework settings or
Vite's public origin/HMR configuration may require an intentional project edit.
Preserve existing project conventions and report exactly which files changed.

### 5. Start and verify

```sh
unlocalhost up <slug>
unlocalhost --json status <slug>
unlocalhost url <slug>
unlocalhost url <slug> --public
```

Verify the application response, asset URLs, exact CORS origin, and HMR
WebSocket when applicable. A successful WebSocket upgrade returns HTTP `101`.

Commands do not prompt when all required flags are supplied. Global `--json`
returns machine-readable errors and versioned status data; failures use a
non-zero exit code.

## Troubleshooting

### `Bind for 0.0.0.0:80 failed: port is already allocated`

The project was started without unlocalhost's external replacement override, or its
registration predates the current managed mapping. Run `unlocalhost up <slug>` and
inspect the generated override. Do not publish every project's container port
`80` directly on the host.

### Can two MySQL containers both use `3306`?

Yes, when `3306` is internal to separate Compose networks. They conflict only
when both try to publish the same host address and port. unlocalhost removes
unselected database host publications.

### Browser receives `400 Bad Request` through HTTPS

Check that the application trusts the immediate reverse proxy and recognizes
the forwarded HTTPS scheme. For Laravel, see
[Laravel behind the proxy](#laravel-behind-the-proxy).

### Manifest, icon, or asset URL starts with `http://`

The application still believes the request scheme is HTTP or contains a
hard-coded HTTP URL. Correct proxy trust and application URL generation. Caddy
already terminates local HTTPS and the tunnel already terminates public HTTPS.

### Vite assets point to `[::1]:5173`

Register a Vite endpoint and configure `server.origin` plus WSS as described
above. Browser loopback is not the development host for a remote client.

### `Port 5173 is already in use`

Do not start a second Vite process in the same container. Check whether the
first process is already running, stop it if necessary, and retry once.

### Vite endpoint is registered but `status` says unreachable

The proxy route and Compose mapping exist, but the Vite process is not running.
Start the project's normal development command once in the correct environment.

### A dependency is missing

Run:

```sh
unlocalhost doctor
```

The CLI identifies the required dependency and provides platform-appropriate
installation guidance. Docker and cloudflared remain optional until a command
actually needs them.

## Command reference

```text
unlocalhost init
unlocalhost doctor

unlocalhost add <path> --slug <slug> [--port <host-port>]
unlocalhost add <path> --slug <slug> [--run <command...>]
unlocalhost add <path> --slug <slug> --services <service:container-port,...>
unlocalhost rm <id>
unlocalhost list
unlocalhost show <id>

unlocalhost endpoint add <id> <name> [--port <host-port>]
unlocalhost endpoint add <id> <name> [--run <command...>]
unlocalhost endpoint add <id> <name> --service <service> --container-port <port>
unlocalhost endpoint set-command <id> <name> <command...>
unlocalhost endpoint list <id>
unlocalhost endpoint rm <id> <name>

unlocalhost up <id|--all>
unlocalhost down <id|--all>
unlocalhost restart <id>
unlocalhost status [id]
unlocalhost url <id> [--endpoint <name>] [--local|--public]
unlocalhost port <id> [--endpoint <name>]
unlocalhost logs <id> [--endpoint <name>] [--stderr]

unlocalhost caddy rebuild
unlocalhost proxy install|uninstall|start|stop|status|reload|run

unlocalhost tunnel guide|init|install|uninstall|start|stop|status|open-dashboard
```

Place global flags before the command:

```sh
unlocalhost --home /srv/unlocalhost --json status my-app
```

`unlocalhost url` and `unlocalhost port` print one capture-friendly value. Status JSON
uses a top-level `schema_version`; consumers should ignore additional fields
they do not yet use.
