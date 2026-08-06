# Upstream and reuse provenance

## Fork baseline

- Project: OpenHands Agent Canvas
- Pinned source commit: `56638693908b8ac83a2fa3bde6eb6c33aae37f4b`
- License: MIT, retained in `LICENSE`

The existing Agent Canvas application, launcher, ingress, packaging, frontend shell, and local backend integration are retained rather than rebuilt.

## Donor research

Vibe Kanban was reviewed as a donor for orchestration and worktree concepts. No source file was copied into this v1 implementation. Its useful ideas were translated into independent protocol and lifecycle boundaries so Surface, Runtime, and Provider remain replaceable.

## New control-plane-owned areas

- `control-plane/`
- `src/api/control-plane-service/`
- `src/routes/control-plane.tsx`
- the Control Plane navigation entry and launcher/ingress wiring
- `docs/control-plane-v1.md`

Future upstream updates should be merged against the pinned baseline while keeping the protocol layer independent of OpenHands-specific UI and runtime objects.
