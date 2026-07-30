# unlocalhost landing

The alpha landing page for unlocalhost.

## Purpose

The page positions unlocalhost as remote local development infrastructure:
the complete environment stays on the developer’s machine while its HTTP
endpoints become reachable through stable HTTPS URLs.

Primary message:

> Develop locally. Work from anywhere.

Core contrast:

> Not a deploy. Your actual environment.

## Local development

Requires Node.js 22.13 or newer.

```sh
npm install
npm run dev
```

Validation:

```sh
npm test
npm run lint
```

## Content

- `app/page.tsx` contains the finished single-page landing.
- `app/globals.css` contains the visual system and responsive layout.
- `public/og.png` is the social sharing card.
- `public/favicon.png` is derived from the project mark.
- `.openai/hosting.json` links the private Sites preview.

The GitHub repository URL is defined once at the top of `app/page.tsx`. Update
it there if the final owner or organization changes.
