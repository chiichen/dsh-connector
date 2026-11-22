# dsh-connector

Session-affiliated external service connector contracts and host plugin for [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness).

## Packages

- `@dsh-connector/core` (`packages/connector-core`): Host-agnostic connector capability contracts, stateless `ConnectorContext` model, context marker codec, and error hierarchy (`zod` v4 peer dependency, zero `dsh` dependencies).
- `dsh-connector-plugin` (`packages/dsh-connector-plugin`): Unified Cordis / `dsh` host plugin managing connector lifecycles, `SessionId <-> ConnectorContext` bidirectional mappings, Agent tool registration, and HTTP webhook routing.
- `@repo/typescript-config` (`packages/typescript-config`): Shared TypeScript configurations.
- `@repo/eslint-config` (`packages/eslint-config`): Shared ESLint configuration.

## Development

```sh
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run oxlint
pnpm run oxfmt
```
