# dsh-webhook-router

Turborepo scaffolded with `create-turbo -e with-vite`. Apps build with Vite 8 (Rolldown). Shared logic is tested with Vitest.

## Build and test

```sh
pnpm install
pnpm exec turbo run build
pnpm exec turbo run test
pnpm exec turbo run typecheck
pnpm exec turbo run oxlint
pnpm exec turbo run oxfmt
```

CI runs those Turborepo tasks on Node 24.22.3 (the scaffold requires Node >=24.20.0).

## Using this example

Run the following command:

```sh
pnpm dlx create-turbo@latest -e with-vite
```

## What's inside?

This Turborepo includes the following packages and apps:

### Apps and Packages

- `docs`: a vanilla [Vite](https://vite.dev) TypeScript app
- `web`: another vanilla [Vite](https://vite.dev) TypeScript app
- `@repo/ui`: a stub component and utility library shared by both `web` and `docs`
- `@repo/eslint-config`: shared ESLint configuration
- `@repo/typescript-config`: shared `tsconfig.json` files

Each package and app is 100% [TypeScript](https://www.typescriptlang.org/).

### Utilities

This Turborepo has some additional tools already set up for you:

- [TypeScript](https://www.typescriptlang.org/) for static type checking
- [ESLint](https://eslint.org/) for code linting
- [Prettier](https://prettier.io) for code formatting
- [Vitest](https://vitest.dev/) for unit tests in `@repo/ui`
