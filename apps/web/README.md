> STALE (2026-08-11): untouched `sv create` scaffold output; superseded by `docs/DEPLOYMENTS.md` for how this app actually builds and ships. Kept pending founder deletion decision. It still names `apps/web-next`, a directory renamed to `apps/web` on 2026-06-29, and says nothing about Clerk, the `rbox-app` Pages project, or the `production`-branch deploy.

# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
npx sv@0.16.1 create --template minimal --types ts --install npm apps/web-next
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.
