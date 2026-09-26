# Grasp OS

An internal operating system for AI at work: company knowledge, Apps with their screens and durable workflows, agents, and the controls around them. Every model call goes through one gateway, every external call through one connector layer, and everything that happens lands in an audit log.

Built on Cloudflare Workers with TypeScript, React and Vite+.

## Repository

| Path | What it is |
| --- | --- |
| `apps/core` | Core Worker: sign-in, knowledge, Apps, workflows, model gateway, audit |
| `apps/connect` | Connector Worker: access to outside systems |
| `apps/web` | The frontend |
| `apps/console` | Internal console for deployments and releases |
| `apps/router` | Routes each deployment's hostname |
| `packages/sdk` | `@grasp-os/sdk`: the API for workflows and screens |
| `packages/ui` | `@grasp-os/ui`: the UI kit |
| `packages/compiler` | `@grasp-os/compiler`: builds App screens |
| `packages/connectors/*` | Native connectors |
| `packages/shared` | `@grasp-os/shared`: shared types and schemas |

## Contributing

We don't accept outside contributions.

## License

[AGPL-3.0](LICENSE)
