# unlocalhost

**Develop locally. Work from anywhere.**

unlocalhost makes the development environment running on your own machine
reachable through stable HTTPS URLs. Your code, Docker containers, databases,
volumes, and development servers stay where they are. Nothing is deployed.

> Alpha software. Expect sharp edges and interface changes.

```text
Remote browser or coding agent
                │
                │ HTTPS
                ▼
       one Cloudflare Tunnel (optional)
                │
                ▼
          one Caddy proxy
        ┌───────┼────────┐
        ▼       ▼        ▼
      app A   app B    Vite/HMR
          on your machine
```

## The problem it solves

`localhost` assumes you are sitting in front of the computer running the
project. Remote work gets harder when the real environment includes Compose,
stateful databases, Vite, several HTTP services, and ten projects that all want
the same host ports.

unlocalhost gives each HTTP endpoint a stable hostname, allocates loopback ports
automatically, and routes everything through one machine-level proxy. An
optional machine-level tunnel makes the same environment reachable remotely.

- The real development stack stays on your machine.
- Compose projects can run simultaneously without host-port collisions.
- Frontend, API, admin, and Vite can be endpoints of one project.
- Generated overrides and state stay outside project repositories.
- One Caddy instance and one optional wildcard tunnel serve every project.
- Humans and coding agents use the same non-interactive CLI and JSON status.

## Installation

Requirements:

- Node.js 22 or newer.
- Caddy for HTTPS and hostname routing.
- Docker Compose 2.24.4 or newer only for Compose projects.
- cloudflared only for remote access.

### Global installation

```sh
npm install --global unlocalhost-cli@alpha
```

This installs the `unlocalhost` command. Use the explicit `@alpha` tag until the
first stable release.

### From source

```sh
git clone https://github.com/monteduro/unlocalhost.git
cd unlocalhost
npm install
npm run build
npm link
```

Missing optional dependencies fail with platform-specific installation
instructions. Run `unlocalhost doctor` at any time.

## Quick start with a coding agent

Enter the project you want to work on:

```sh
cd ~/Sites/my-app
```

Then paste this prompt into your coding agent:

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

If the project uses Vite, registering its endpoint is not enough: read
unlocalhost endpoint add --help, then update the existing Vite configuration for
the generated local and public hosts. Set the correct bind host and port,
server.origin, exact allowedHosts and CORS origins, and WSS on the public host
with client port 443 (server.ws on Vite 8; server.hmr on older versions). Start
Vite exactly once. Treat this as a required project change and preserve the
project's existing configuration style.

Start the project, verify it with unlocalhost --json status, and return every
local and public URL. Verify that assets use the proxied HTTPS Vite URL and that
HMR connects over WSS, with no localhost, 127.0.0.1, or [::1] browser URLs.
Pause only when I must approve a password or browser login.
```

For manual setup and the complete agent procedure, see [GUIDE.md](GUIDE.md).

## What it is not

unlocalhost is not a deployment platform, a preview hosting service, or a
replacement for Docker Compose. It does not upload your code, rebuild the
project on a remote server, or flatten a multi-service environment into one
container.

Public development URLs are internet-reachable. Add Cloudflare Access before
exposing sensitive applications, and never use production data or secrets.

## Documentation

[GUIDE.md](GUIDE.md) is the complete operational and agent reference, including
Compose discovery, Node projects, multiple endpoints, Vite/HMR, Laravel proxy
trust, Cloudflare, lifecycle, migration, troubleshooting, and every command.

[docs/concepts.md](docs/concepts.md) explains the architecture and ownership
boundaries.

## License

MIT
