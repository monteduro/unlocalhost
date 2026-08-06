# Concepts

unlocalhost separates three jobs that are often mixed together.

## Project process

The project processes are the application itself. They may be started by Docker
Compose, by unlocalhost's generic process runner, or independently. Docker is a
provider, not an architectural requirement. A project may also combine both
providers, such as a Compose backend and a host-side development server. Each
HTTP endpoint has a stable loopback address allocated internally by
unlocalhost.

One logical project always has a primary `web` endpoint and can have named
secondary endpoints such as `api`. This models a frontend and backend in the
same repository without pretending they are separate projects:

```text
my-app/web → my-app.localhost → 127.0.0.1:12000
my-app/api → my-app-api.localhost → 127.0.0.1:12001
```

The registration is external to the project. unlocalhost does not infer a framework,
rewrite environment files, or modify the project's Compose file. When an extra
published port is necessary, a second Compose file under
`~/.unlocalhost/overrides` adds only a loopback port mapping.

For bare processes, the runner starts the saved command in the project
directory and injects a universal endpoint contract: `HOST`, `PORT`,
`VITE_PORT`, local/public/canonical URLs, and the WebSocket URL. PID files and
logs stay under `UNLOCALHOST_HOME`. For Compose, unlocalhost does not route
through the container network: it generates loopback-only host mappings in the
external override. Both paths therefore give Caddy the same predictable
host-port model.

`unlocalhost setup` detects the provider and asks for outcomes—local HTTPS,
development server/HMR, and remote access—before resolving project-specific
details. If the stack is not recognized, the same wizard asks for the command
normally used to start the application; the user still never chooses a port.
It owns topology and port decisions but never silently rewrites application
configuration.

## Proxy

One machine-level Caddy process listens on behalf of every project. The browser
sends the desired hostname in the HTTP `Host` header, so Caddy can route:

```text
app-a.localhost     → 127.0.0.1:8026
app-a-api.localhost → 127.0.0.1:8027
app-b.localhost     → 127.0.0.1:8031
```

The same machine IP and proxy ports serve both names. Separate `10.0.0.x`
addresses and `/etc/hosts` patches are unnecessary: modern reverse proxies
route by hostname, not by assigning an IP to every application.

Caddy terminates local HTTPS with its local certificate authority. The default
HTTPS port is `8443` so the service can run without root. Port `443` is an
optional host-level configuration.

## Tunnel

The optional Cloudflare Tunnel is a transport into the existing proxy, not a
proxy per application. Each machine has one supervised `cloudflared` process.
Every independently addressable public endpoint gets an exact,
machine-qualified first-level DNS record:

```text
app-studio.example.com
  → that machine's <tunnel-id>.cfargotunnel.com CNAME
  → that machine's cloudflared process
  → http://127.0.0.1:8080
  → Caddy Host routing
```

The first remote wizard asks once for the readable `studio` alias. It is stored
separately from the generated tunnel identity and reused by later projects.

A detected Vite upstream is not independently addressable in the browser.
Caddy serves its assets and HMR WebSocket through the application's hostname,
so Vite adds no DNS record and no cross-origin boundary.

This avoids sending two independent development environments through replicas
of one tunnel, where Cloudflare does not guarantee which connector receives a
request. Adding a public project creates its exact DNS route automatically. If
the tunnel stops, this remote path disappears but the local browser-to-Caddy
path is unchanged.

Development endpoints add edge-cache bypass and browser-revalidation response
headers at the final Caddy reverse proxy only on this public HTTP route. Managed
commands are development endpoints automatically; Compose or externally managed
upstreams opt in with their stored `dev_mode`. Unmarked production-like
endpoints preserve the upstream caching policy, and local `.localhost` routes
are never rewritten.

## Lifecycle ownership

- unlocalhost owns registry, generated override, Caddy, machine identity,
  tunnel, DNS routes, service, and log files in its external state directories.
- Docker Compose owns the containers described by the project's files.
- `unlocalhost setup` detects a standard Compose file or local package dev
  command, or asks for a custom start command, and configures the common path
  without framework-specific decisions.
- `unlocalhost add` can inspect a standard Compose file and turn selected
  `ports`/`expose` entries into endpoints; it never guesses which non-HTTP
  services should be exposed.
- unlocalhost owns processes started by its generic runner and stops their process
  groups on `down` or project removal.
- Caddy and `cloudflared` each have one user-level supervised service.
- The project repository owns only its team's application files.

This boundary is the reason registering and starting a project can leave its
git working tree byte-for-byte unchanged.
