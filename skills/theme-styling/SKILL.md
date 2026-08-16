---
name: theme-styling
description: Theme a Powerhouse editor or drive-app UI correctly in light and dark. Covers the bai token system ([data-bai-theme] + --bai-* vars + ThemeProvider, for vault-style packages) and design-system semantic tokens (--foreground/--background/--primary + .dark, for packages built on document-engineering, e.g. the invoice demo) plus theming third-party widgets (Select, DatePicker) whose dark: variants never generate in a consumer build, and native widgets (date/select/checkbox) via color-scheme/accent-color. Read before building or restyling any editor UI.
---

# Theme & Styling for Powerhouse Editors

**Read this before building or restyling any editor UI, drive-app tab, or new component.** Getting the theming system wrong is invisible in the code review and only shows up when someone toggles dark mode — this skill exists so that doesn't happen.

## Two systems — pick the one that matches the package

Powerhouse editors use one of two independent theming mechanisms. They are not interchangeable and do not compose: pick one per package (or per component tree) and stay inside it.

| | System A — bai tokens | System B — design-system semantic tokens |
|---|---|---|
| Ambient switch | `data-bai-theme="dark"\|"light"` **attribute** on a wrapper `<div>` | `.dark` **class** on an ancestor (Tailwind `@custom-variant dark (&:where(.dark, .dark *));`) |
| Who sets it | `ThemeProvider` (React context) from `editors/shared/theme-context.tsx` | Design-system's own theme plumbing / host app shell |
| Token source | Hand-rolled `--bai-*` custom properties, defined per-theme in `style.css` | `@import "@powerhousedao/design-system/theme.css"` |
| Use when | You're working inside a package that already has this wired up — e.g. **bai-knowledge-note** and its `editors/knowledge-vault`, `editors/wbs-editor`, `editors/project-editor`, `editors/knowledge-note-editor`, etc. | You're building a new package/demo whose editors are composed mainly from `@powerhousedao/document-engineering` / `@powerhousedao/design-system` primitives (TextInput, Select, DatePicker, …) without an existing bai-style provider — e.g. `demos/invoice` |
| Reference implementation | `editors/shared/theme-context.tsx` + `style.css` in bai-knowledge-note | `style.css` in the invoice demo package (`demos/invoice`) |

Never mix them in one tree: a `dark:` Tailwind variant checks for `.dark`, so it will silently never match inside a `[data-bai-theme="dark"]` subtree that has no `.dark` class, and vice versa.

## System A: the bai token system

### Mechanism

`ThemeProvider` (from `editors/shared/theme-context.tsx`) holds theme state (`"dark" | "light"`, default `"dark"`), persists it to `localStorage` under `bai-theme`, and renders:

```tsx
<div data-bai-theme={theme} className="bai-theme">{children}</div>
```

Every `--bai-*` custom property is defined twice in `style.css`, scoped by that attribute:

```css
.bai-theme, [data-bai-theme="dark"] { --bai-bg: #1e1e2e; /* ... */ }
[data-bai-theme="light"] { --bai-bg: #f8f9fc; /* ... */ }
```

so any descendant can read `var(--bai-bg)` and get the value for whichever theme is active — no conditional logic needed in the component, ever. `useTheme()` exposes `{ theme, toggle }` for anything that needs to branch on the theme value itself (rare — almost everything should just consume the CSS vars).

**Most editors mount their own `ThemeProvider`** at the top of their default export (`wbs-editor`, `project-editor`, `knowledge-vault`) so they render correctly whether opened standalone or nested. At least one editor in bai-knowledge-note (`knowledge-note-editor`) instead consumes the tokens directly without mounting its own provider, relying on an ancestor having already set `data-bai-theme` — this only works if that editor is never opened somewhere without such an ancestor. When in doubt, mount your own `ThemeProvider`; it's cheap and makes the editor correct in isolation.

### Token table

| Token | Dark (Catppuccin Mocha, default) | Light (neutral) | Meaning |
|---|---|---|---|
| `--bai-bg` | `#1e1e2e` | `#f8f9fc` | Editor root / page background |
| `--bai-surface` | `#181825` | `#ffffff` | Card / panel background (one level up from root) |
| `--bai-deep` | `#11111b` | `#f1f3f8` | Recessed background — content preview panes, textareas sitting "inside" a surface |
| `--bai-hover` | `#313244` | `#e8eaf0` | Hover background for buttons, rows, progress-bar track |
| `--bai-border` | `rgba(255,255,255,0.1)` | `#e2e4e9` | Default 1px border / divider |
| `--bai-ring` | `rgba(255,255,255,0.1)` | `#e2e4e9` | Focus ring base (currently identical to border) |
| `--bai-text` | `#e4e4e7` | `#1f2937` | Primary text (titles, root text color) |
| `--bai-text-secondary` | `#d4d4d8` | `#374151` | Field values, body copy |
| `--bai-text-tertiary` | `#9ca3af` | `#6b7280` | Toolbar labels/icons, secondary UI text |
| `--bai-text-muted` | `#6b7280` | `#9ca3af` | Section headers ("PROVENANCE", "GOALS"), hints |
| `--bai-text-faint` | `#4b5563` | `#d1d5db` | Faintest text — meta/timestamps, empty-state copy |
| `--bai-accent` | `#cba6f7` (mauve) | `#7c3aed` (violet) | Brand accent — primary buttons, active tab, links |
| `--bai-accent-text` | `#1e1e2e` | `#ffffff` | Text/icon color drawn **on top of** an accent-filled surface |
| `--bai-accent-soft` | `rgba(203,166,247,0.1)` | `rgba(124,58,237,0.08)` | Soft accent background wash |
| `--bai-accent-hover` | `rgba(203,166,247,0.8)` | `rgba(124,58,237,0.85)` | Accent hover state |
| `--bai-status-draft` | `#f59e0b` | `#d97706` | Status color: draft |
| `--bai-status-review` | `#3b82f6` | `#2563eb` | Status color: in review |
| `--bai-status-canonical` | `#10b981` | `#059669` | Status color: canonical/approved |
| `--bai-status-archived` | `#6b7280` | `#6b7280` | Status color: archived |

`TOOLBAR_CLASS` (exported from `theme-context.tsx`) is **one class string reused for both themes** — it's built from arbitrary-value Tailwind classes like `!bg-[var(--bai-surface)]`, so the same class resolves to the right color per theme without an if/else.

### Invariant rules

- **Editor root shape**: `ThemeProvider` → `<DocumentToolbar toolbarClassName={TOOLBAR_CLASS} />` → a full-height wrapper (`min-h-screen`, or `flex min-h-screen` for a sidebar layout) with `style={{ backgroundColor: "var(--bai-bg)", color: "var(--bai-text)" }}`.
- **Cards/sections**: `var(--bai-surface)` background + `1px solid var(--bai-border)`, typically `rounded-xl p-5`.
- **Colors go in `style={{}}`, not Tailwind.** Use inline `style` for every token-driven color (background, text, border). Use Tailwind classes only for layout, size, spacing, radius, and typography scale (`flex`, `gap-3`, `rounded-lg`, `text-sm`, `font-semibold`). The one accepted exception is the arbitrary-value bracket form (`bg-[var(--bai-surface)]`, `hover:border-[var(--bai-accent)]`) already established for hover/focus states on card-style buttons in `knowledge-vault` (`NoteList.tsx`, `SearchView.tsx`, `ProjectsView.tsx`'s `ProjectCard`) — pick whichever form the sibling components in the same file already use, don't mix both styles in one component.
- **Never** reach for `text-gray-*`, `bg-gray-*`, `border-gray-*`, `bg-white`, `text-white`, `border-white`, or any literal hex/`rgb()`/`rgba()` for the UI's own chrome (backgrounds, borders, general text). If a color isn't a token, it doesn't survive a theme switch.
- **Status pills/colors come from a shared meta object**, never hand-typed. `editors/shared/project-status.ts` exports `GOAL_STATUS_META`, `PROJECT_STATUS_META`, `DELIVERABLE_STATUS_META` — `Record<Status, { label, fg, bg, border }>`. Reference `META[status].fg` / `.bg` / `.border` directly; don't retype the rgba values even if you're fairly sure you copied them right — a second occurrence that "matches" by eye but drifts by one alpha value is exactly the kind of thing this skill exists to catch (see the `GOAL_STATUS_META.BLOCKED`-shaped callout box in `GoalSidebar.tsx`/`WbsPanel.tsx` for a fixed example of this exact mistake). These meta values are intentionally theme-invariant — the same reds/greens/ambers in both light and dark — so referencing them is always theme-safe.
- **Modals**: `fixed inset-0 z-50 flex items-center justify-center`, a click-to-close scrim `absolute inset-0 bg-black/60`, and a `relative z-10` panel (`rounded-2xl p-6 shadow-2xl`) on `var(--bai-surface)` + `var(--bai-border)`.
- **Dropdowns/menus must be viewport-safe**: anchor with `absolute right-0` near a right-hand edge (not `left-0`, which clips off-screen in narrow layouts), and cap long lists with `max-h-[60vh] overflow-y-auto` (see `StatusChipMenu.tsx` for the reference implementation — not every dropdown in the codebase has this yet; add it to any new one and consider backfilling short ones you touch).

### Allowed exceptions — established house patterns, not violations

These look like hardcoded non-token colors but are deliberate, precedented conventions. Don't "fix" them:

- **Destructive red recipe**: `hover:bg-red-500/10 hover:text-red-400` on icon buttons, `bg-red-500/20 text-red-400 ring-1 ring-red-500/30 hover:bg-red-500/30` on a confirm-delete button, `bg-red-500/10` + `text-red-400` on a warning-icon badge, `text-red-400` on inline validation errors. This exact recipe is used consistently everywhere destructive actions appear (originates in `knowledge-vault/components/SourceList.tsx`'s `DeleteModal`) and reads correctly in both themes because it's a fixed semi-transparent red, not theme-dependent.
- **`hover:bg-white/5`** for subtle row/button hover overlays. This is the house pattern for "give any interactive row a faint hover" regardless of theme — confirmed against `SourceList.tsx`, which already applies it on light-theme-capable surfaces. Don't replace it with a token-based hover unless you're touching the whole file's hover convention deliberately.
- **`bg-black/60`** as a modal scrim. Fixed and correct in both themes by construction (it's darkening whatever is behind it, not the panel).
- **Focus rings**, where present, follow whatever ring convention the surrounding component already uses.

### Text color and placeholders — usually already correct

Every input/textarea/select that sets its own `color: var(--bai-text-*)` gets a correctly-themed placeholder for free: Tailwind v4's preflight sets `::placeholder { color: color-mix(in oklab, currentcolor 50%, transparent); }`, i.e. the placeholder is automatically a 50%-opacity version of whatever `color` the field has. You do not need a separate `::placeholder` rule or a `placeholder:opacity-*` utility unless you want a different dimming amount than 50% for a specific field. The only way this breaks is forgetting to set `color` on the field at all — then it inherits from an ancestor (also usually fine, since editor roots set `color: var(--bai-text)`), or, in the worst case, resolves to the browser default black, which is unreadable on a dark surface. **Always set `color` explicitly on every input/textarea/select.**

## System B: design-system semantic tokens

Used when a package's editors are built directly from `@powerhousedao/document-engineering` components (`TextInput`, `Textarea`, `Select`, `DatePicker`, `FormLabel`, …) rather than hand-rolled form controls. `style.css` looks like:

```css
@import "@powerhousedao/design-system/theme.css";
@custom-variant dark (&:where(.dark, .dark *));
@import "tailwindcss";
@import "@powerhousedao/connect/style.css";
```

Key tokens: `--foreground`, `--background`, `--primary`, `--primary-foreground`, `--border`, `--muted-foreground`, `--ring`. The dark variant is a **class** (`.dark`), not an attribute — whatever toggles the theme in that host app must add/remove `.dark` on an ancestor, the same convention `dark:` Tailwind utilities expect.

The invoice demo (`demos/invoice`) is the reference implementation for this system, and it teaches the more important lesson below.

## Third-party widget theming — the invoice lesson

**Why it breaks**: `document-engineering` components ship their own `dark:` Tailwind utility classes (e.g. `text-gray-900 dark:text-gray-50`, `dark:bg-charcoal-900`), but those classes are only *compiled* into `document-engineering`'s own `dist/style.css` — a stylesheet the consuming app never imports. Tailwind v4 in the **host** app scans only the host's own source files, never `node_modules`, so it never generates those `dark:` utilities itself either. The class name string is present in the rendered DOM (React put it there), but no CSS rule anywhere matches it. Net effect: only the light-mode utility resolves, always, regardless of the active theme — dark-on-dark text, white hover flashes, black selection boxes, invisible today-markers, all while the surrounding app looks perfectly themed.

**The fix, in every case, is the same shape**: theme the library's markup from your own `style.css`, targeting something guaranteed to be present in the DOM, using tokens so the rule is correct in both themes without duplication:

1. **Prefer the component's own semantic class names** when it has them (`.select__list-item`, `.select__search`, `.select__list`, `.date-picker__selected`, `.date-picker__today`, `.date-picker__day-button`, `.base-picker__input`, `.base-picker__popover`, …). These are stable across the library's own utility-class churn.
2. **Fall back to `[class*="<literal-utility-token>"]` substring-attribute selectors** when there's no semantic hook. The ungenerated utility class is still literally sitting in the `class=""` attribute even though it does nothing visually — so it works as a marker you can select on. Chain multiple `[class*=...]` on one selector to scope precisely (e.g. `[class*="dark:bg-charcoal-900"][class*="hover:bg-gray-100"]:hover` matches only the Select trigger, not every text input that also has `dark:bg-charcoal-900`).
3. **Drive every value from a token**: `var(--foreground)`, `var(--muted-foreground)`, `var(--primary)`, `var(--primary-foreground)`, `var(--border)`, `var(--background)` — never a fixed color, or you've just reintroduced the same bug with extra steps.
4. **Use `color-mix(in oklab, var(--x) N%, transparent)` for hover/selection overlays.** This adapts automatically per theme because it's derived from the live token, not a hardcoded translucent value. The invoice demo uses `var(--foreground)` (not `var(--primary)` or `var(--accent)`) as the mix base for calendar hover states specifically because the accent color sits too close to the dark surface color to read as a visible hover in dark mode — a foreground-based wash reads in both themes. Tune the percentage per desired strength (the invoice demo uses 8% for a subtle trigger hover, 12–18% for row/day hover, 22% for a "current" marker).
5. **Add `!important`** wherever the library's own utility classes carry real specificity or get inlined — otherwise your override loses the cascade.
6. **`:has()` is fair game** for "neutralize the wrapper around a themed child" cases (e.g. `div:has(> .select__search) { background-color: transparent !important; }` to kill a search wrapper's own white hover fill).

This isn't limited to colors — the same "compiled only into the library's own unused dist CSS" problem hits arbitrary-value layout utilities too (a `max-h-[300px]` dropdown cap, popover padding, month/year grid gaps). If a document-engineering component looks structurally broken (uncapped dropdown height, cramped spacing, a stray double border) in a way that has nothing to do with color, suspect the same root cause and fix it the same way: target the stable class hook with plain CSS.

See `style.css` in the invoice demo (`demos/invoice`) for a fully worked, heavily-commented example covering `TextInput`/`Textarea`/`FormLabel`, `Select` (trigger hover, option rows, search field, dropdown height), and `DatePicker` (today/selected/hover states, nav-arrow z-index, popover padding, double-border removal, month/year grid views, input field text/icon color, unifying a split input+icon background). Read the comments, not just the rules — each one names the specific failure mode it fixes.

## Native browser widgets

Some form elements are rendered by the OS/browser, not by CSS you control at all — `color-scheme` and `accent-color` are the only levers:

| Widget | Problem | Fix |
|---|---|---|
| `<input type="date">` | Calendar icon/popup renders in the browser's default (light) chrome regardless of your inline dark background | `color-scheme: dark` / `color-scheme: light`, scoped to the active theme |
| `<select>` | The closed control can be inline-styled, but the **open option-list popup** is OS-drawn chrome that also follows `color-scheme`, not your inline styles — a dark-themed select can still pop a white options list | Same fix as date inputs: `color-scheme: dark` / `light` |
| `<input type="checkbox">` / radio | Checked-state fill uses the browser's default blue, clashing with the app's accent | `accent-color: var(--your-accent-token)` |

In the bai system, key these off the theme attribute, mirroring the existing date-input rule in `style.css`:

```css
[data-bai-theme="dark"] input[type="date"] { color-scheme: dark; }
[data-bai-theme="light"] input[type="date"] { color-scheme: light; }

[data-bai-theme="dark"] select { color-scheme: dark; }
[data-bai-theme="light"] select { color-scheme: light; }

[data-bai-theme="dark"] input[type="checkbox"],
[data-bai-theme="light"] input[type="checkbox"] { accent-color: var(--bai-accent); }
```

`accent-color: var(--bai-accent)` can be written once for both themes because the token itself resolves differently per theme — no need to duplicate the declaration, only the selector attribute if you want to keep the file's existing habit of spelling out `="dark"` and `="light"` explicitly rather than a bare `[data-bai-theme]` presence selector.

In System B, scope the same declarations under `.dark` / default instead of the attribute selectors.

## Verification checklist

Toggle both themes (the `ThemeToggle` button, or flip `data-bai-theme`/`.dark` by hand in devtools) and check every item — most theme bugs are only visible in the theme you didn't test in:

- [ ] **Toolbar**: background, buttons, icons, and text all follow the theme — no leftover default Connect chrome bleeding through.
- [ ] **Root gutters**: scroll all the way to the bottom of a long editor. There should be no unthemed strip of default background showing past the last themed panel.
- [ ] **Every input/textarea/select**: typed text is legible, placeholder is legible-but-dimmed, in both themes.
- [ ] **Native widget icons**: date-picker calendar icon, select's caret/popup, checkbox tick — legible, no light-browser-chrome bleeding into dark mode.
- [ ] **Dropdowns/menus near a viewport edge**: don't clip off-screen; long lists scroll internally instead of pushing the page.
- [ ] **Status pills / colored badges**: correct hue and contrast in both themes — these should need zero theme-specific code because they come from the shared status meta.
- [ ] **Modals**: scrim dims the background, panel surface/border are themed, and buttons inside the modal follow the same token rules as the rest of the editor.
