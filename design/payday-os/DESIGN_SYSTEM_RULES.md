# PaydayOS design system rules

Source of truth: Figma file `uYZY2Q4OmmMoBLOJPuZ3PM` ("PaydayOS Design System + Admin"). The HTML prototype in `index.html` mirrors it.

## Tokens
- **Never hardcode** colours, spacing or radii. Use `var(--color-*)`, `var(--spacing-*)`, `var(--radius-*)`. The names match the Figma variables' WEB code syntax.
- **Primitives** (`--indigo-500`, `--gray-900`, ...) are used only to define semantic tokens. Components use semantic tokens.
- **Spacing scale:** 4 / 8 / 16 / 24 / 32 (`xs`..`xl`). **Radius:** 6 / 10 / 16 / full.
- **Dark mode** is implemented in CSS only (`:root[data-theme="dark"]`), because the Figma plan allows one mode per variable collection.

## Typography (Inter)
| Style | Size / line | Weight |
|---|---|---|
| display | 28 / 36 | 600 |
| heading | 18 / 26 | 600 |
| subheading | 14 / 20 | 600 |
| body | 14 / 20 | 400 |
| caption | 12 / 16 | 400 |
| label | 12 / 16 | 500 |

## Components
- **Badge** has Success / Warning / Danger variants. It is a fixed 120px wide so status columns line up.
- **KPI Card** shows a label, a value and a delta. The delta uses success green when up and danger red when down.
- **Table Row** has applicant, amount, score, co-lender and a status badge.
- Status colour mapping: disbursed or approved = success, pending or sent = warning, rejected or overdue = danger.

## Rules
1. Build from components. Never copy-paste a one-off card or row.
2. Currency is shown as ₹ with Indian grouping in real data (the prototype uses sample data).
3. Scorecard grade format: `Grade · points` (e.g. `A · 108`).
4. All data in the prototype is illustrative sample data, not real customers.
