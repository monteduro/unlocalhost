# unlocalhost guide

This guide is the operational reference for humans and coding agents. Start
with the short [README](README.md) for the purpose and architecture.

## Contents

1. [Mental model](#mental-model)
2. [Install and dependencies](#install-and-dependencies)
3. [Migrating from the devhost alpha](#migrating-from-the-devhost-alpha)
4. [Project setup wizard](#project-setup-wizard)
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
Cloudflare Tunnel per machine. Every independently addressable public endpoint
receives an exact DNS record pointing to its machine's tunnel. A Vite upstream
shares its application's hostname and needs no second record. Projects do not
receive their own proxy, tunnel, or manually selected host port.

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
- One optional machine-specific Cloudflare Tunnel and its supervised service.
- Exact first-level DNS records for independently addressable public endpoints.
- Saved commands for non-Compose processes.
- Human-readable output and versioned JSON status for agents.

### What unlocalhost does not manage

- Application dependencies, migrations, framework configuration, or secrets.
- Per-project Cloudflare tunnels.
- Internal database or cache ports unless explicitly registered as HTTP.
- Arbitrary commands inside an already-defined Compose service.
- Production deployment or application authentication.

The CLI never patches tracked application source or configuration.
Framework-specific edits shown in this guide are deliberate changes made by a
person or agent. The only in-project runtime adjustment is Laravel's generated,
normally gitignored `public/hot` file when a managed Vite endpoint is active.

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

As a safety net, `unlocalhost setup` and `unlocalhost proxy install`
automatically stop an installed `io.devhost.caddy` user service and archive its
service file with a `.disabled-by-unlocalhost` suffix. This prevents the old and
new Caddy processes from sharing ports `8080` and `2019`. Legacy Cloudflare
tunnels are not stopped automatically because their old DNS may still be in
use.

The migration never touches registered project repositories.

## Project setup wizard

The normal entry point initializes the machine and configures the current
project in one operation:

```sh
cd ~/Sites/my-app
unlocalhost setup
```

Before inspecting service details, the wizard presents an interactive checkbox
list (arrow keys, space to toggle, enter to confirm):

```text
1) Local domain + HTTPS
2) Development server / HMR (when detected)
3) Remote access with Cloudflare Tunnel
```

It detects current and legacy Compose filenames, `package.json`, the package
manager, a `dev` script, Vite, Next.js, and static sites with an `index.html`.
When both the repository root and `public/` contain an index, `public/` is the
document root. It then selects an unambiguous HTTP service, allocates loopback
ports, creates external state, installs Caddy, starts the application, and
initializes or reuses the tunnel when selected. Ports are implementation
details and are never requested from the user.

Questions appear only when the project is genuinely ambiguous, such as two
equally plausible Compose HTTP services. Database and cache services are
filtered out. No tracked source or configuration is written. When a dev server
announces an incompatible origin, setup prints the exact endpoint and required
application change for a human or coding agent.

When no Compose file, standard package `dev` script, or static index exists,
the wizard asks:

```text
No standard application command was detected.
Start command: python manage.py runserver 127.0.0.1:{port}
```

The command is saved in external state. `{host}` and `{port}` are optional
tokens resolved internally; many servers work with the injected `HOST` and
`PORT` environment variables without either token.

Non-interactive equivalents:

```sh
unlocalhost --yes setup . --features https,dev
unlocalhost --yes setup . --features https,dev,remote --domain example.com --machine studio
```

Use `--no-start` to configure without starting. Use `--run <command...>` only
when no standard `dev` script can be detected.

The default local URL format is:

```text
https://<slug>.localhost:8443
```

The defaults use unprivileged Caddy ports: `8080` for the tunnel origin and
`8443` for local HTTPS. Standard ports `80` and `443` can be configured in
`~/.unlocalhost/config.toml`, but binding them may require additional operating
system privileges. unlocalhost disables Caddy's automatic HTTP-to-HTTPS
redirects because Cloudflare reaches the local tunnel origin over HTTP; HTTPS
certificate automation remains enabled for local hostnames. The CLI always
prints the intended local HTTPS URL.

The lower-level machine setup remains available for advanced/manual use:

```sh
unlocalhost init
unlocalhost proxy install
caddy trust
unlocalhost proxy run
```

## Remote access with Cloudflare

Remote access uses one locally managed Cloudflare Tunnel per machine and exact,
proxied DNS records per independently addressable public endpoint:

```text
app-studio.example.com → <studio-machine-tunnel>.cfargotunnel.com
api-laptop.example.com → <laptop-machine-tunnel>.cfargotunnel.com
```

The technical machine identifier is generated once. At the first remote setup,
the wizard asks for a readable alias that must be unique on the Cloudflare
domain and stores it in `config.toml`. It is reused by every later project.
This keeps two development machines independent while all names remain
first-level subdomains covered by normal Cloudflare Universal SSL.

### Development cache policy

Cloudflare edge caching is bypassed only for endpoints marked as development.
Managed `--run` commands are development endpoints automatically. The setup
wizard also marks Compose routes as development when the `dev` feature is
selected. For a manually registered Compose service or an already-running
development server, opt in explicitly:

```sh
unlocalhost add "$PWD" --slug my-app --port 3000 --dev
unlocalhost add "$PWD" --slug my-app --services web:3000 --dev
unlocalhost endpoint add my-app api --port 4000 --dev
```

On the public tunnel route, Caddy separates browser and shared-cache policy.
Cloudflare and other CDNs receive `no-store`; browsers receive `private,
no-cache` so they may keep a local copy but must revalidate it before every
reuse. An unchanged asset can therefore return `304 Not Modified` instead of
being downloaded again, without allowing a stale bundle. The local `.localhost`
route is left unchanged. Raw-port and Compose registrations without `--dev`
retain their upstream cache policy, so production-like static or release
artifacts can still be cached normally.

### Interactive authentication

Select remote access in `unlocalhost setup`. On the first machine setup,
unlocalhost asks for the public domain, creates or reuses this machine's tunnel,
and creates the project's exact DNS records. If login has not happened yet in
an interactive terminal, it opens the `cloudflared tunnel login` flow and then
continues setup.

The equivalent lower-level commands are:

```sh
cloudflared tunnel login
unlocalhost tunnel init --domain example.com --machine studio
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
  --machine studio \
  --account-id <account-id> \
  --zone-id <zone-id>
unlocalhost tunnel install
```

`tunnel init` creates or reuses this machine's named tunnel, writes protected
credentials under `~/.unlocalhost`, and creates or updates the exact CNAME for every independently addressable public endpoint. If authentication or permissions are missing,
it exits non-zero with the next required step.

`rm` deliberately does not delete Cloudflare DNS. `cloudflared` has a reliable
command for creating an exact tunnel route but no matching DNS-delete command,
so unlocalhost never pretends cleanup succeeded and never makes deletion depend
on which credentials happen to be present. It prints every exact hostname as a
manual Cloudflare-dashboard action. Caddy removes its routes immediately and
answers `404` for those retained records; recreating the same project reuses
them.

### Multiple machines and migration

Every machine gets a different persistent id and tunnel. Never copy one tunnel
credential to multiple development machines: Cloudflare treats them as
replicas and does not guarantee which connector receives a request.

When an installation using the former wildcard model enables remote access,
the wizard migrates it to a new machine-specific tunnel and exact project DNS.
It deliberately leaves the legacy wildcard and tunnel untouched, because they
may still serve another Mac. Remove those legacy Cloudflare resources manually
only after verifying that no machine uses them.

Run this at any time for the current setup checklist:

```sh
unlocalhost tunnel guide
```

### Certificate and exposure considerations

Cloudflare free Universal SSL on a full zone normally covers the apex and
first-level subdomains. `app.example.com` is covered; a nested hostname such as
`app.dev.example.com` requires suitable Advanced or custom certificate
coverage, such as Advanced Certificate Manager with Total TLS. The generated
machine-qualified hostnames deliberately remain first-level.

Every configured public hostname is internet-reachable. Add
Cloudflare Access before exposing sensitive development data, and treat the
applications as untrusted.

## Register a Compose project

The recommended flow is:

```sh
cd ~/Sites/my-app
unlocalhost setup
```

If the application service is unambiguous, no Compose question is asked. The
lower-level registration command remains available for advanced automation:

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

For Next.js, Nuxt, Astro, Express, or another Docker-free project with a `dev`
script, use the same wizard:

```sh
cd ~/Sites/my-next-app
unlocalhost setup
```

The process becomes the primary HTTP endpoint. unlocalhost starts it in the
background, captures logs, assigns its port, and puts Caddy and the optional
tunnel in front of it. Next.js application traffic and HMR share one endpoint;
there is no secondary Vite endpoint.

For a plain HTML/CSS/JavaScript project, setup detects `public/index.html` (or
root `index.html` when no public index exists) and starts unlocalhost's built-in
static server automatically:

```sh
cd ~/Sites/my-static-site
unlocalhost setup
```

Only the selected document root is exposed. The repository root, source files,
and sibling directories remain inaccessible, and no Python or npm server
package is required.

For a custom command, interactive setup asks for it automatically. `--run` is
the non-interactive or lower-level equivalent:

```sh
unlocalhost setup --features https --run npm run custom-dev

# Advanced equivalent
unlocalhost add "$PWD" --slug my-app --run npm run custom-dev
unlocalhost up my-app
```

unlocalhost injects:

- `HOST`
- `PORT`
- `VITE_PORT`
- `UNLOCALHOST_PROJECT`
- `UNLOCALHOST_ENDPOINT`
- `UNLOCALHOST_PORT`
- `UNLOCALHOST_LOCAL_URL`
- `UNLOCALHOST_PUBLIC_URL` when enabled
- `UNLOCALHOST_URL`
- `UNLOCALHOST_WS_URL`

`UNLOCALHOST_URL` is the canonical public URL when remote access is enabled,
otherwise the local HTTPS URL. Saved advanced commands may use `{host}` and
`{port}` tokens; unlocalhost resolves them without exposing the chosen port to
the user.

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
path routing. The detected `vite` endpoint is the deliberate exception: it
shares the primary application's browser origin.

## Vite and other Node development servers

An HTTPS application cannot safely load development assets from
`http://[::1]:5173`: loopback refers to the browser's machine, and HTTPS pages
need an HTTPS/WSS route. Select “Development server / HMR” in `unlocalhost
setup`. For a standalone Vite application it becomes the primary endpoint. For
a Compose application with a separate Vite server, setup creates a secondary
`vite` upstream but exposes it through the same application hostname. Caddy
routes Vite asset paths and tokenized HMR WebSockets internally before falling
back to the application. Vite's absolute project-file update paths are routed
to the same upstream as well. No second public DNS record or cross-origin CORS
policy is involved.

Host-side Vite is started with an automatically assigned strict port. The
command receives `VITE_PORT`, `UNLOCALHOST_URL`, and `UNLOCALHOST_WS_URL`; no
port should be copied into `vite.config.*`. If the existing configuration still
announces `localhost`, setup prints an explicit action to update the origin,
exact allowed hosts, and WebSocket origin. The repository is not modified
automatically.

For Laravel with a separate Vite endpoint, no configuration edit is normally
needed: unlocalhost starts Vite through a generated wrapper under
`~/.unlocalhost/run/vite-configs`. The wrapper imports the project's existing
configuration and enforces only the proxied origin and HMR connection, including
after Vite reloads its configuration. Laravel's ephemeral, gitignored
`public/hot` file therefore stays on the application's HTTPS origin. The source
Vite configuration is left untouched.

For a Compose application, setup prefers a host-side dev process only when the
matching package binary already exists in host `node_modules` and the package
manager is available. Otherwise it maps the declared Compose dev-server port.
This avoids bind-mounting host-native Node binaries into Linux containers while
still supporting projects whose dependencies intentionally live in Compose.

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
unlocalhost setup --features https,dev
```

The allocated port is intentionally hidden. For advanced registrations,
`unlocalhost endpoint add` and `unlocalhost port` remain available.

### Vite public HTTPS and HMR configuration

Laravel projects detected by setup receive this configuration through the
external wrapper automatically. For another stack that requires an explicit
Vite edit, derive every value from the environment supplied by unlocalhost:

```ts
const endpoint = new URL(process.env.UNLOCALHOST_URL);

export default defineConfig({
  server: {
    host: "0.0.0.0", // use 127.0.0.1 for host-side Vite
    port: Number(process.env.VITE_PORT),
    strictPort: true,
    origin: endpoint.origin,
    allowedHosts: [endpoint.hostname],
    hmr: {
      protocol: endpoint.protocol === "https:" ? "wss" : "ws",
      host: endpoint.hostname,
      clientPort: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
    },
  },
});
```

Keep `allowedHosts` explicit; never use `allowedHosts: true` for an
internet-reachable development server. No Vite CORS wildcard is required: the
browser loads development assets and HMR from the application's own origin.

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
file plus the generated external override. On projects with saved commands,
unlocalhost owns their process lifecycle and logs. Both managers may coexist:
for example an application can run in Compose while Vite runs as a supervised
host process. Docker is never required for a Docker-free project.

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

Host development commands registered by setup are restarted by `unlocalhost
up`. A dev server that must run interactively inside an existing Compose
service remains owned by that Compose project and may need its normal command
after a reboot.

## Agent and automation workflow

An agent should delegate topology, ports, Caddy, and tunnel decisions to setup
instead of rebuilding that logic itself.

### Copy-paste prompt

From the project directory, give a coding agent this prompt:

```text
Run unlocalhost setup in this project. Enable local HTTPS, the detected
development server when present, and remote access. Follow only the explicit
actions printed by the CLI, do not invent ports or tunnels, and do not modify
project files unless setup says an application change is required. Verify the
result with unlocalhost --json status and return the URLs.
```

### 1. Run deterministic setup

- Read project instructions such as `AGENTS.md`.
- Run `unlocalhost --yes setup . --features https,dev,remote --domain <domain> --machine <alias>` on first use; omit `--machine` after the alias is stored.
- Omit `dev` only when the project has no development server.
- Do not use lower-level endpoint or tunnel commands unless setup reports an
  unsupported ambiguity.

### 2. Follow explicit actions only

- setup owns detection, ports, external Compose overrides, Caddy, the
  machine-specific tunnel, and exact DNS records. The agent must not redo those decisions.
- When setup returns an `ACTION`, apply only that application-level change and
  preserve the existing configuration style.
- Never hardcode the allocated host port; consume the emitted environment
  variables.
- Never create a per-project tunnel or a wildcard shared by independent machines.

### 3. Verify

```sh
unlocalhost up <slug>
unlocalhost --json status <slug>
unlocalhost url <slug>
unlocalhost url <slug> --public
```

Verify the application response, same-origin asset URLs, and HMR WebSocket when
applicable. A successful WebSocket upgrade returns HTTP `101`.

Commands do not prompt when all required flags are supplied. Global `--json`
returns machine-readable errors and versioned status data; failures use a
non-zero exit code.

## Troubleshooting

### Public URL redirects too many times

Rebuild and reload routes with `unlocalhost caddy rebuild`. unlocalhost keeps
the Cloudflare-to-Caddy hop on HTTP and forwards the original public HTTPS
scheme to the application. Older generated Caddyfiles may automatically
redirect that origin back to the same public HTTPS hostname, causing a loop.
Deleting browser cookies does not fix this infrastructure redirect.

After migrating from `devhost`, also make sure only one Caddy owns the origin
port. Current versions disable and archive the legacy `io.devhost.caddy`
service automatically during proxy installation. On macOS, inspect unusual
cases with `lsof -nP -iTCP:8080 -sTCP:LISTEN`; there should be one Caddy process.

### `Bootstrap failed: 5: Input/output error`

This is a macOS `launchctl` error while replacing a user LaunchAgent, not a
Docker or application failure. unlocalhost treats an already-correct service as
a no-op and waits/retries when a changed service must be reloaded. Do not rerun
the wizard with `sudo`: Caddy and cloudflared are intentionally user services.
Retry `unlocalhost setup`; if it still fails, inspect `unlocalhost status` and
`~/.unlocalhost/logs/cloudflared.err.log`.

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
above. Browser loopback is not the development host for a remote client. For a
Laravel project managed by the current wizard, run `unlocalhost up <slug>`:
the CLI starts Vite through its external wrapper, realigns the ephemeral
`public/hot` file with the application origin, and sends assets and HMR through
the generated same-host Caddy route.

### Vite HMR requests `/Users/...` or another absolute project path and gets `404`

Vite may identify an updated module with its absolute filesystem path. Current
unlocalhost Caddy routes include only the registered project's absolute path
and forward those update requests to its Vite upstream. Run `unlocalhost caddy
rebuild` after upgrading an older installation; do not expose a broad `/Users`
or filesystem-wide route manually.

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
unlocalhost setup [path] [--features https,dev,remote] [--domain <domain>] [--machine <alias>]
unlocalhost init
unlocalhost doctor

unlocalhost add <path> --slug <slug> [--port <host-port>] [--dev]
unlocalhost add <path> --slug <slug> [--run <command...>]
unlocalhost add <path> --slug <slug> --services <service:container-port,...> [--dev]
unlocalhost rm <id>
unlocalhost list
unlocalhost show <id>

unlocalhost endpoint add <id> <name> [--port <host-port>] [--dev]
unlocalhost endpoint add <id> <name> [--run <command...>]
unlocalhost endpoint add <id> <name> --service <service> --container-port <port> [--dev]
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

unlocalhost tunnel guide
unlocalhost tunnel init --domain <domain> --machine <alias>
unlocalhost tunnel install|uninstall|start|stop|status|open-dashboard
```

Place global flags before the command:

```sh
unlocalhost --home /srv/unlocalhost --json status my-app
```

`unlocalhost url` and `unlocalhost port` print one capture-friendly value. Status JSON
uses a top-level `schema_version`; consumers should ignore additional fields
they do not yet use.
