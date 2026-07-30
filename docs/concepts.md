# Concepts

unlocalhost separates three jobs that are often mixed together.

## Project process

The project processes are the application itself. They may be started by Docker
Compose through `unlocalhost up`, by unlocalhost's generic process runner, or
independently. Each HTTP endpoint has a stable loopback address. unlocalhost
allocates one from its configured range unless the user supplies an existing
port.

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
directory and injects `HOST`, `PORT`, and unlocalhost metadata. PID files and logs
stay under `UNLOCALHOST_HOME`. For Compose, unlocalhost does not route through the
container network: it generates loopback-only host mappings in the external
override. Both paths therefore give Caddy the same predictable host-port model.

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
proxy per application. One supervised `cloudflared` process receives the whole
public wildcard and forwards it to Caddy's loopback HTTP listener:

```text
*.example.com
  → one <tunnel-id>.cfargotunnel.com CNAME
  → one cloudflared process
  → http://127.0.0.1:8080
  → Caddy Host routing
```

Adding or removing a project changes only unlocalhost's registry and generated
Caddyfile. It does not create Cloudflare resources. If the tunnel stops, this
remote path disappears but the local browser-to-Caddy path is unchanged.

## Lifecycle ownership

- unlocalhost owns registry, generated override, Caddy, tunnel, service, and log
  files in its external state directories.
- Docker Compose owns the containers described by the project's files.
- `unlocalhost add` can inspect a standard Compose file and turn selected
  `ports`/`expose` entries into endpoints; it never guesses which non-HTTP
  services should be exposed.
- unlocalhost owns processes started by its generic runner and stops their process
  groups on `down` or project removal.
- Caddy and `cloudflared` each have one user-level supervised service.
- The project repository owns only its team's application files.

This boundary is the reason registering and starting a project can leave its
git working tree byte-for-byte unchanged.
