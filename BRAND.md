# unlocalhost brand

## Positioning

**Category:** remote local development infrastructure.

**One line:** Develop locally. Work from anywhere.

**Expanded:** unlocalhost keeps the real development environment on your own
machine and makes every HTTP endpoint reachable through stable HTTPS URLs.

**Core contrast:** not a deploy, not a preview environment, not a simplified
copy. It is the code, containers, databases, volumes, and development servers
already running on the machine.

## Audience

- Developers who keep a workstation, Mac mini, homelab, or office machine
  running and need to work from elsewhere.
- People running several Compose projects that fight over host ports.
- Coding agents that need deterministic commands and machine-readable status.
- Teams that cannot add personal networking files to shared repositories.

## Message hierarchy

1. Develop on your own machine from anywhere.
2. Keep the complete environment intact.
3. Run many projects simultaneously without choosing ports.
4. Use one proxy and one optional tunnel for the whole machine.
5. Keep project repositories untouched.

The tunnel, Caddy, and automatic ports are proof. They are not the headline.

## Voice

Direct, technical, and slightly defiant. Explain the system without pretending
the infrastructure is magic.

Use:

- “Your dev machine. From anywhere.”
- “Not a deploy. Your actual environment.”
- “One machine. Every project. Any location.”
- “The code stays. You move.”

Avoid:

- “Share localhost.”
- “Deploy in one click.”
- “Production-ready.”
- “Secure” without naming the actual boundary or recommending access control.
- Claims that Cloudflare, Docker, or framework configuration is completely
  automatic.

## Logo

The mark is a terminal—the clearest shorthand for local development—with an
arrow escaping its top-right boundary. The prompt remains inside: access leaves
the machine, while the development environment does not.

The wordmark is lowercase `unlocalhost` in a monospaced face. Highlight `un` in
signal green when color is available. Do not add a space or hyphen.

Assets:

- [`brand/mark.svg`](brand/mark.svg) — standalone mark.
- [`brand/wordmark.svg`](brand/wordmark.svg) — mark and wordmark.

## Visual system

| Role | Color | Hex |
|---|---|---|
| Ink | Near black | `#0b0d0c` |
| Paper | Warm white | `#f3f4ed` |
| Signal | Electric green | `#b8ff57` |
| Route | Cool blue | `#7aa7ff` |
| Muted | Steel gray | `#929a94` |

Use signal green sparingly for active routes, prompts, and primary actions.
Diagrams should resemble infrastructure traces rather than cloud illustrations.

Primary typography:

- Display and wordmark: a modern monospace.
- Body: a neutral grotesk/sans-serif.
- Commands and operational data: monospace.

## Alpha badge

Write `alpha` in lowercase inside a thin rounded rectangle. It should remain
visibly subordinate to the wordmark and must appear anywhere installation is
promised.
