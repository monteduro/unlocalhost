# unlocalhost

**Develop locally. Work from anywhere.**

unlocalhost makes your local development environment reachable through stable
HTTPS URLs. Code, containers, databases, volumes, and dev servers stay local. Nothing is deployed.

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
automatically, and routes everything through one optional remote tunnel.

- The real development stack stays on your machine.
- Compose projects can run simultaneously without host-port collisions.
- Docker-free Node and static `public/` projects are started and supervised directly.
- Frontend, API, admin, and Vite can be endpoints of one project.
- Vite assets and HMR share the app hostname; no second DNS record is needed.
- Generated overrides and state stay outside project repositories.
- One Caddy instance and one optional tunnel serve every project on a machine.
- Multiple machines stay independent through exact, machine-qualified DNS records.
- Public development responses bypass edge caches while browsers revalidate private copies; production-like routes keep their upstream policy.
- Humans and coding agents share the same non-interactive CLI and JSON status.

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

## Quick start

Enter the project and run the goal-oriented wizard:

```sh
cd ~/Sites/my-app
unlocalhost setup
```

It first presents an interactive checkbox list:

```text
What do you want to enable?

1) Local domain + HTTPS (recommended)
2) Development server / HMR (shown only when detected)
3) Remote access with Cloudflare Tunnel
```

unlocalhost then detects a Compose service or local `dev` command, allocates
every port, configures Caddy, starts the project, and optionally initializes or
reuses that machine's tunnel. The first remote setup asks once for a persistent machine alias; `my-app-studio.example.com` keeps another machine independent.
It never patches tracked source or configuration, and disables a legacy `devhost` proxy during upgrades.
Removal prints the exact DNS records to delete manually; it never reports unverified cleanup.
If Vite, Next.js, or another tool requires an application setting, the CLI
prints the exact endpoint and a follow-up action.

Static sites with `public/index.html` use `public/` as their document root
automatically. Other unknown stacks prompt for their normal start command; the
user still never chooses a port.

For an agent or script, make the same choices non-interactively:

```sh
unlocalhost --yes setup . --features https,dev
unlocalhost --yes setup . --features https,dev,remote --domain example.com --machine studio
unlocalhost --json status
```

Or enter the project and give your coding agent this short prompt:

```text
Run unlocalhost setup in this project. Enable local HTTPS, the detected
development server when present, and remote access. Follow only the explicit
actions printed by the CLI, do not invent ports or tunnels, and do not modify
project files unless setup says an application change is required. Verify the
result with unlocalhost --json status and return the URLs.
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

[docs/concepts.md](docs/concepts.md) explains architecture and ownership boundaries.

## License

MIT
