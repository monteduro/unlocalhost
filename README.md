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

## Install

Requirements:

- Node.js 22 or newer.
- Caddy for HTTPS and hostname routing.
- Docker Compose 2.24.4 or newer only for Compose projects.
- cloudflared only for remote access.

From npm:

```sh
npm install --global unlocalhost-cli
```

From this repository:

```sh
npm install
npm run build
npm link
```

Missing optional dependencies fail with platform-specific installation
instructions. Run `unlocalhost doctor` at any time.

## First run

```sh
unlocalhost init
unlocalhost proxy install
caddy trust
unlocalhost doctor
```

Register and start a Compose project:

```sh
cd ~/Sites/my-app
unlocalhost --yes add "$PWD" --slug my-app --services web:80
unlocalhost up my-app
unlocalhost url my-app
```

Configure remote access once for the entire machine:

```sh
cloudflared tunnel login
unlocalhost tunnel init --domain dev.example.com --name unlocalhost
unlocalhost tunnel install
unlocalhost url my-app --public
```

The tunnel uses one wildcard DNS record. Adding another project does not create
another tunnel or touch DNS again.

## Agent-ready workflow

An agent entering a project can inspect its Compose services and then run:

```sh
unlocalhost doctor
unlocalhost --json tunnel status
unlocalhost --yes add "$PWD" --slug <slug> \
  --services <http-service>:<container-port>
unlocalhost up <slug>
unlocalhost --json status <slug>
unlocalhost url <slug> --public
```

Only HTTP services should become endpoints. Databases and caches remain inside
their Compose networks. unlocalhost never patches the registered repository.

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
