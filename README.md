# App Template

<!-- template-only -->
> [!IMPORTANT]
> **This is the template.** Make a new app from it with **`./new-app`**, run
> from a real terminal (Terminal.app or iTerm, on the Pi's network). It asks
> for the name in the domain, the repository, the label, the Neon branches,
> the Google clients and the PostHog key, saying where to get each one, then:
> copies this repo, has Claude rename and check it, writes the local and
> production envs, commits as you, creates the GitHub repository, prepares
> the Pi (`/opt/<name>`, its `.env`, `<name>.pietroteruya.dev` on the tunnel),
> sets the deploy secrets, pushes (the first deploy) and turns the issue
> queue on. It ends by pointing you at `/design-system` for the app's look.
> A run that stops picks up with `./new-app --resume <name>`. Everything
> below this box is what each new app's README says about itself.
<!-- /template-only -->

A Flutter app for iPhone, Android and the web, with its own backend.

- **App** (`app/`): Flutter, with Google sign-in, a blank home and an
  assistant.
- **Server** (`server/`): NestJS with Better Auth (Google sign-in), Postgres
  on Neon through Drizzle, and the assistant through OpenRouter.

Deployed to a Raspberry Pi as Docker images pulled from GHCR, at
<https://apptemplate.pietroteruya.dev>.

- [SETUP.md](./SETUP.md): local development, Google OAuth, Neon, deployment.
- [AGENTS.md](./AGENTS.md): how the code is organised.
