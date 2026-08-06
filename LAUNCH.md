# unlocalhost alpha launch kit

## Launch premise

Most remote-development products move the environment to somebody else’s
server. unlocalhost keeps it on your machine and gives you a stable way back
in.

The alpha announcement should demonstrate one real Compose project with its
database and Vite endpoint, then open the same project from another device.
Avoid framing the product as a link-sharing tool.

## Short descriptions

**GitHub description**

Develop on your own machine from anywhere—Docker, databases, Vite and all.

**npm description**

Develop on your own machine from anywhere, without deploying your local
environment.

**Directory tagline**

Remote development without moving your development environment.

## Launch post for X

> Introducing unlocalhost (alpha): remote development without moving your dev
> environment. Keep Docker, databases, Vite and code on your own machine, then
> reach every project through stable HTTPS. One proxy, one optional tunnel,
> zero repo changes. [link]

## Optional X thread

**1/5**

> localhost works perfectly—until you are no longer sitting in front of the
> machine. I built unlocalhost so the machine can stay local while the
> development session goes anywhere.

**2/5**

> It is not a deploy or a preview copy. Your real Compose stack keeps running:
> containers, databases, volumes, Vite/HMR and all.

**3/5**

> One Caddy proxy gives every endpoint a stable HTTPS hostname. One optional
> Cloudflare Tunnel exposes exact, machine-qualified endpoint hostnames
> remotely. Adding project number ten does not mean creating tunnel number ten.

**4/5**

> unlocalhost allocates loopback ports and writes Compose overrides outside
> project repositories. Shared repos stay untouched, even when every project
> wants port 80, 3306, or 5173.

**5/5**

> The CLI is designed for both humans and coding agents: non-interactive setup,
> useful errors, and versioned JSON status. The first alpha is open source:
> [link]

## Hacker News

**Title**

Show HN: unlocalhost – develop on your own machine from anywhere

**Opening**

I keep real development environments running on a machine that I cannot always
sit in front of. Existing options usually meant deploying a copy, exposing one
port at a time, or adding personal networking configuration to team repos.

unlocalhost is a CLI that puts one Caddy proxy in front of all local projects
and optionally connects it to one Cloudflare Tunnel with exact endpoint DNS. Compose
overrides and allocated loopback ports live outside the projects, so several
stacks can run simultaneously without modifying their repositories.

The goal is remote local development, not preview hosting: the original
containers, database state, volumes, and Vite server remain on the machine.
This is an early alpha, and I am especially looking for feedback on non-Laravel
Compose projects, Linux service supervision, and agent workflows.

## Alpha release notes

### unlocalhost 0.1.0-alpha.3

- Keep Cloudflare and other shared caches disabled for development endpoints
  while allowing browsers to retain private copies with mandatory revalidation.
- Reuse unchanged assets through conditional requests without risking stale
  development bundles.

### unlocalhost 0.1.0-alpha.2

- Prevent Cloudflare from edge-caching public responses for development
  endpoints while leaving local and production-like routes unchanged.
- Classify managed commands as development automatically and let raw-port or
  Compose registrations opt in explicitly with `--dev`.
- Persist the endpoint policy as `dev_mode` in the external project registry.

### unlocalhost 0.1.0-alpha.1

- Add the goal-oriented `unlocalhost setup` wizard for new and existing projects.
- Use exact, machine-qualified Cloudflare DNS records instead of a shared
  wildcard for new remote configurations.

### unlocalhost 0.1.0-alpha.0 (historical)

- Register Compose and non-Compose projects without changing their repositories.
- Allocate stable loopback ports and replace conflicting Compose publications
  through external overrides.
- Route multiple projects and endpoints through one Caddy instance with local
  HTTPS.
- Expose the same routes through one optional wildcard Cloudflare Tunnel.
- Manage frontend, API, admin, and Vite/HMR endpoints as one logical project.
- Supervise Caddy and cloudflared on macOS and Linux.
- Inspect dependency health and project state in human-readable or versioned
  JSON output.

Known alpha constraints:

- Cloudflare Access must be configured separately.
- Framework proxy trust, CORS, public URLs, and Vite HMR settings remain
  intentional application configuration.
- Windows service installation is not supported yet.

## Demo script

1. Show two Compose projects that both publish web `80` and MySQL `3306`.
2. Register both without editing either repository.
3. Run `unlocalhost up --all`.
4. Open their distinct local HTTPS hostnames.
5. Open one project’s Vite endpoint and demonstrate HMR.
6. Open the public hostname from another device.
7. Stop the tunnel and show that local HTTPS still works.
8. Show clean `git status` in both projects.
9. End on `unlocalhost --json status`.

## Launch checklist

- Publish the GitHub repository and add the short description.
- Confirm the MIT license, security warning, guide, and alpha release notes.
- Publish `unlocalhost-cli@0.1.0-alpha.0` with `npm run release:alpha` and test
  `npm install --global unlocalhost-cli@alpha` on a clean machine.
- Replace every `[link]` in this document with the canonical landing URL.
- Protect the public demo with Cloudflare Access.
- Record the demo script as a short terminal-first video.
- Publish the X post, then the technical thread only if people ask how it works.
- Post Show HN after the installation path has been tested by someone other
  than the author.
- Track installation failures separately from feature requests during alpha.
