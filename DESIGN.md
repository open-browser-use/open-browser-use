# Design Context

## Design Thesis

open-browser-use should look like a local machine tool with a severe public
identity: black surface, chalk-white text, fine rules, hard edges, lowercase
labels, and almost no chromatic decoration. The website can be cinematic. The
extension and agent surfaces should be compact, sharp, and operational.

Physical scene: a developer is pairing an agent to Chrome while watching a
browser and terminal on a dim desktop. The interface must stay visible, precise,
and low-glare. Dark mode is intentional here, not category reflex.

## Source Of Truth

The brand baseline comes from `/Users/labrinyang/projects/open-browser-use-web`:

- monochrome black/white palette with tinted neutrals;
- large lowercase wordmark: "open browser use";
- sparse copy: "agent browser tool. agentic RL ready.";
- italic serif details for poetic marketing notes;
- cinematic grayscale hero imagery;
- fixed hard edges, thin lines, no soft cards;
- direct action links with underline/rule behavior;
- Avenir Next / Helvetica Neue for primary text.

The product UI baseline is already partially reflected in this repository's
extension popup and options CSS:

- dark shell, square controls, thin borders;
- lowercase wordmark and labels;
- compact type scale;
- tabular numeric state values;
- monochrome status indicators;
- explicit focus outlines instead of glow-heavy decoration.

## Color

Use a restrained monochrome system. Prefer OKLCH tokens in new CSS.

```css
:root {
  color-scheme: dark;
  --obu-black: oklch(6% 0.003 260);
  --obu-panel: oklch(9% 0.003 260);
  --obu-panel-muted: oklch(13% 0.003 260);
  --obu-white: oklch(94% 0.006 92);
  --obu-ink-soft: oklch(84% 0.006 92);
  --obu-muted: oklch(70% 0.006 92);
  --obu-line: oklch(94% 0.006 92 / 0.16);
  --obu-line-strong: oklch(94% 0.006 92 / 0.28);
  --obu-focus: oklch(94% 0.006 92);
  --obu-agent-amber: oklch(83% 0.17 85);
}
```

Guidance:

- Default surfaces are black or near-black.
- Text and controls are white, soft white, or muted gray.
- Lines carry structure. Use 1px rules before using boxes.
- Use amber only for the agent pointer, extension mark, or rare agent-control
  emphasis. It should not become a general UI accent.
- Avoid cyan/blue gradients in new product UI. Existing blue overlay code is a
  legacy visual direction and should not be expanded.
- Do not use pure `#000` or `#fff` in new CSS. Use tinted neutrals.

## Typography

Primary stack:

```css
--font-ui: "Avenir Next", "Helvetica Neue", Helvetica, ui-sans-serif, system-ui, sans-serif;
--font-serif: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
--font-mono: "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
```

Rules:

- Product UI uses the sans stack. It should feel native, technical, and quiet.
- Marketing details may use the serif stack in italic, lowercase, and small
  doses.
- Labels, buttons, and headings stay lowercase.
- Letter spacing is `0` for normal text. Small kicker labels may use positive
  tracking up to `0.18em`.
- Use tabular numbers for status, versions, ids, counts, and diagnostics.
- Avoid display fonts inside product UI.

Suggested product scale:

```css
--type-caption: 0.6875rem;
--type-small: 0.75rem;
--type-body: 0.8125rem;
--type-body-strong: 0.875rem;
--type-title: 1.425rem;
--type-status: 1.18rem;
```

## Layout

- Use dense, predictable product layouts.
- Prefer grids, rows, rails, and rule-separated panels.
- Radius defaults to `0`.
- Cards are allowed for actual framed tools such as status panels, setup panels,
  diagnostics, and repeated issue rows. Do not nest cards.
- On marketing pages, allow asymmetry and oversized type, but keep the next
  section visible where possible.
- On extension surfaces, optimize for scanning: status first, evidence second,
  action third.

Spacing should be compact and stepped:

```css
--space-1: 0.25rem;
--space-2: 0.375rem;
--space-3: 0.5rem;
--space-4: 0.625rem;
--space-5: 0.75rem;
--space-6: 0.875rem;
--space-7: 1rem;
```

## Components

Buttons:

- Square corners.
- Primary buttons invert the monochrome palette: white fill, black text.
- Secondary buttons are transparent with a strong line.
- Disabled states reduce opacity but keep layout stable.
- Focus is a 1px white outline with a visible offset.

Links:

- Text links use bottom rules or underline-like rules.
- Hover increases line contrast. Avoid color-only hover.

Panels:

- Use `1px solid var(--obu-line)` on black or near-black.
- No heavy shadows in product UI.
- Background changes should be subtle, usually one neutral step.

Status:

- Prefer tiny dots, rails, labels, and concrete state names.
- Error and attention states can remain monochrome unless the user must
  distinguish multiple simultaneous severities.
- If color is required for severity, use it sparingly and document the role.

Code and handoff text:

- Use the mono stack.
- Preserve exact commands and ids.
- Copy surfaces should look selectable or copyable but not like a chat bubble.

## Motion

Use motion only for state feedback:

- 150ms to 220ms for hover, reveal, and copy confirmation.
- `cubic-bezier(0.22, 1, 0.36, 1)` as the default ease-out curve.
- Do not animate layout properties.
- Respect `prefers-reduced-motion`.
- No page-load choreography in product UI.

## Browser Overlay And Agent Pointer

The overlay/pointer is a product-control affordance. It must say "the agent is
operating here" without obscuring the page.

Design direction:

- Keep the pointer shape recognizable as a cursor, because the user must track
  page operations immediately.
- Use a monochrome cursor body with a restrained amber agent signal. Amber is
  already associated with the extension mark and should become the agent-control
  accent.
- Replace broad blue/cyan takeover atmosphere with a quieter monochrome layer:
  faint rules, subtle scrim, or localized signal near the pointer.
- Click feedback should be a small measured pulse at the action point, not a
  decorative ripple field.
- Movement should feel deliberate and mechanical: fast ease-out, slight
  directional tilt, no playful wobble unless it communicates travel.
- During input lock, the overlay should communicate ownership with a minimal
  border/rule or cursor halo, not a full-screen color wash.

Pointer states to design for:

- idle: visible pointer at last known coordinate;
- moving: eased travel with optional tiny trail or angle change;
- press: compressed pointer or filled tip;
- click: one pulse centered on the target coordinate;
- blocked/stale: pointer hidden or dimmed with no ambiguous target promise;
- released: quick fade, no lingering ornament.

Accessibility and constraints:

- Pointer must remain visible on both light and dark pages.
- Pointer should not cover too much target content. Keep the active tip exact.
- Overlay root remains `pointer-events: none`.
- Suppress overlay during screenshots and captures.
- Reduced motion should jump or fade without travel choreography.

## Imagery

Marketing imagery can use grayscale, high-contrast, vast-scale scenes. The
current public image reads as a lone figure facing a wide net-like sky. This
works because it gives the brand a precise mood without turning the product UI
into illustration.

Do not use generic SaaS screenshots, gradient blobs, or abstract dashboards as
the main brand image. If screenshots are needed, use real browser/terminal
states and keep them monochrome.

## Copy

- Keep visible copy short.
- Use concrete state and action words.
- Prefer "copy for agent" over broad onboarding copy.
- Prefer exact commands in docs and setup surfaces.
- Marketing can be poetic; product UI should be literal.
- Do not explain keyboard shortcuts, hover behavior, or obvious controls in the
  UI.

## Anti-Patterns

- Rounded SaaS cards.
- Purple, blue, or teal gradient identity.
- Decorative glass, blur, or glow.
- Mascot-like agent personality.
- Large colorful takeover overlays.
- Generic "AI automation platform" language.
- Title-cased brand labels.
- Nested cards and ornamental side stripes.
