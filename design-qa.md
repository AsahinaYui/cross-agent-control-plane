# Design QA — standalone control-plane overlay

## Evidence

- Selected visual reference: `design-qa-assets/reference.png`
- User defect screenshots: `C:/Users/wuxin/AppData/Local/Temp/codex-clipboard-0840777c-953a-47c7-b862-de8611c5bc51.png`, `codex-clipboard-0a8d7c4a-5e03-407c-a43f-87ed318c3ce1.png`, and `codex-clipboard-b14cbf83-8bf1-48cc-b6b2-45bb653c857a.png`
- Browser-rendered implementation: `design-qa-assets/implementation.png`
- Combined inspected raster: `design-qa-assets/comparison.png`
- HTML comparison: `design-qa-assets/comparison.html`
- Reference and implementation pixels: 1487 × 1058
- CSS viewport: 1487 × 1058
- Device scale factor: 1
- State: dark theme, DeepSeek expanded, four provider/model modules visible.

## Findings and fixes

- [P1] Drag release still toggled expansion in the shipped desktop interaction.
  - Fix: card activation now records the tap start point, rejects pointer movement of 7 px or more, and suppresses activation immediately after a completed drag.
  - Post-fix evidence: a collapsed card remained `aria-expanded=false` after drag; an expanded card remained `aria-expanded=true` after drag; a stationary click still changed expansion.
- [P1] Model cards contained configuration copy and interaction instructions that made the overlay visually noisy.
  - Fix: removed responsibility copy, the long empty-state explanation, and the “再次点击此模块收回” instruction from activity cards. Responsibility remains editable in Settings.
- [P2] The status dot and drag-grip marks did not add useful information.
  - Fix: removed both; status remains explicit in the progress row and model identity remains explicit through the provider logo.
- [P1] Provider availability and model choices were not truthful.
  - Fix: desktop provider discovery now reads ccSwitch's local provider metadata directly, keeps Runtime and Provider as separate choices, checks CLI availability, and supplements only the official OpenAI route with the local Codex model cache. Credentials never enter the renderer. The model field is a real select, so alternatives are not filtered away like the former datalist.

## Required fidelity surfaces

- Fonts and typography: passed. The compact header hierarchy remains legible with no instructional copy competing for attention.
- Spacing and layout rhythm: passed. Compact cards are shorter and the expanded card preserves the independent floating-module layout.
- Colors and visual tokens: passed. Dark transparent glass remains readable over a complex desktop while preserving the selected Y2K accent palette.
- Image quality and asset fidelity: passed. OpenAI, Anthropic, DeepSeek, and custom-provider marks use source/library assets; the two nonfunctional card marks were removed.
- Copy and content: passed. Activity cards now show only role, pinned model, state, progress, and real expanded-run details; responsibilities are settings-only.

## Functional checks

- Stationary click toggled the Project Direction card.
- Project Direction and DeepSeek could remain expanded simultaneously.
- Dragging an expanded card preserved `aria-expanded=true`.
- Dragging a collapsed card preserved `aria-expanded=false`.
- Settings showed the compatible models for each selected ccSwitch route in the native model select.
- Settings retained responsibility, role, write intent, task, Coordinator surface, and Execution Plan controls; responsibility and Coordinator surface are persisted in the plan.
- Provider-catalog and ccSwitch isolation tests: 5 passed.
- Browser console warnings/errors: none.
- Production overlay build: passed.
- Standalone overlay TypeScript check: passed.
- Electron main/catalog syntax checks: passed.
- `git diff --check`: passed.

The darker palette remains an intentional user-directed deviation from the light reference.

final result: passed
