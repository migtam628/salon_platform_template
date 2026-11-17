# Design QA — Atelier Beauty foundation

## Approved design reference

Hybrid of the user's chosen concepts: editorial warm-ivory typography, deep olive actions, appointment-first navigation, and product-led salon shop presentation. The source concept was the generated *Atelier Beauty* desktop composition approved before coding. It is preserved in `docs/approved-concept.webp`.

## Implementation map

| Concept region | Implementation | Check |
| --- | --- | --- |
| Serif wordmark, navigation, customer/cart controls, booking CTA | `apps/web/src/components.jsx`, `.site-header` | Code reviewed |
| Editorial split hero, portrait, primary booking/shop actions | `apps/web/src/pages.jsx`, `.hero` | Code reviewed |
| Quick service-selection strip | `.appointment-strip` | Code reviewed |
| Three product tiles and curated shop messaging | `.shop-feature`, `.featured-products` | Code reviewed |
| Floating live-chat entry | `.chat-widget` | Code reviewed |
| Mobile reflow, category tabs, booking form, shop grid | `apps/web/src/styles.css` media queries | Code reviewed; visual verification pending |

## Verification

- API integration tests: pass, including booking collisions, customer chat privacy, admin-only operations, and no fake checkout fallback.
- Frontend production build: pass.
- Static route-worker tests: pass.
- Generated hero and product images: inspected individually; converted to optimized WebP.
- Desktop/mobile browser screenshot comparison: **not verified**. The connected browser could not resolve the preview host, and the local Chromium sandbox blocked its IPC socket. Recheck at 1440×900 and 390×844 in a permitted browser before public launch.

## Follow-ups

1. Complete desktop/mobile visual QA in a working browser and fix deviations from the approved composition.
2. Replace placeholder products, staff, prices and brand imagery with salon-approved materials.
3. Add full availability engine and operational workflows before taking real bookings or payments.

This is a foundation-stage signoff only, not a production launch approval.

## Phase 2 admin screen

- Concept: `docs/admin-concept.webp`, generated from the previously approved storefront direction.
- Intended desktop native size: 1536×1024. Browser screenshot comparison remains pending because the local preview host could not be reached from the connected browser and local Chromium IPC was denied.
- Source-level fidelity ledger:
  1. **Left rail:** fixed pale-ivory sidebar, serif wordmark, nine operational links, selected olive row — implemented in `admin.css` / `AdminPortal.jsx`.
  2. **Top hierarchy:** slim operation bar, gold hairline, serif “Products & catalog” heading, right aligned olive “Add product” — implemented.
  3. **Metrics:** three low-key product/stock/category tiles, not a generic chart dashboard — implemented with live counts.
  4. **Catalog anatomy:** search/filter controls, thumbnail/name/SKU/price/stock/visibility/edit columns — implemented.
  5. **Editor:** right rail for product properties with labels and olive save action — implemented. Stock is edited only on the Inventory page after creation to preserve an adjustment audit trail; this intentionally differs from the concept's inline stock field.
  6. **Stock watch:** low-stock list below catalog — implemented with live inventory rather than the illustrative numbers in the image.
- Responsive breakpoint rules are provided for 1350px, 1040px, 790px and 550px. **Not visually verified in a browser yet.**
- Copy exception: generated concept includes sample products and counts; runtime is data-driven and begins with three sample products.
- Future QA must include screenshot inspection at 1536×1024 and 390×844, form interactions, and a five-point side-by-side comparison before public deployment.
