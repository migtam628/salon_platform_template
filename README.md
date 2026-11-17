# Salon Platform Template

A bespoke full-stack salon platform: public beauty/hair/nail storefront, appointment booking, customer accounts, admin foundation, WebSocket live chat, and Stripe Checkout. Built independently of Shopify.

**Current stage: Phase 3 booking and operations preview. Not production-ready.** The salon name **Atelier Beauty**, images, staff, services, products, and prices are placeholders until the real salon provides its content.

## Project structure

```text
apps/
  web/   React + Vite frontend (public site, booking, shop, account, admin portal)
  api/   Node.js + Express API, Socket.IO, MongoDB data access, Appwrite authentication, Stripe
```

## Local development

Requirements: Node.js 22+, npm, optional MongoDB for persistence.

1. `npm install`
2. Copy `.env.example` to `apps/api/.env` and enter development settings. For local preview, use `DEMO_MODE=true`.
3. Copy the web-specific variables from `.env.example` to `apps/web/.env.local` and set `VITE_DEMO_MODE=true` for preview.
4. Run `npm run dev` at the repository root.
5. Open the frontend URL printed by Vite. The API defaults to port 4000. WebSocket traffic and `/api` requests are proxied by Vite.

Run `npm test` for API tests and the web worker test; `npm run build` for the frontend build.

### Demo mode

`DEMO_MODE=true` is explicitly **development-only**. It uses seeded products, services, and specialists; all changes are stored in memory if `MONGODB_URI` is omitted. Data disappears when the server restarts. The demo profile is `demo-customer`; preview admin is at `/admin`. Admin tabs use real `/admin/products`, `/admin/inventory`, `/admin/services`, `/admin/team`, `/admin/appointments`, `/admin/orders`, `/admin/chat` and `/admin/settings` routes.

**Never deploy demo mode publicly.** Production startup refuses `DEMO_MODE=true` and requires a database plus Appwrite authentication configuration. For production, the `ADMIN_USER_IDS` setting must contain only trusted Appwrite user IDs. Admin permissions are checked server-side.

## Stripe integration

- `POST /api/checkout` validates product IDs, quantities, inventory, and prices server-side, then creates a Stripe Checkout Session.
- `POST /api/stripe/webhook` validates the Stripe signature over the raw request body and updates order payment state from verified events.
- Checkout is intentionally unavailable without both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. **No simulated payment success** is used.
- Use a test-mode Stripe account while developing. Configure the actual webhook endpoint and success/cancel URLs before launch.
- Appointment deposits are **not** charged by the current booking flow. Confirm the salon's deposit, no-show and refund policy before connecting service prepayments.

## Appointment scheduling and notifications

- Public booking slots come from the actual specialist's working days/hours, service duration, previously reserved intervals, and configured salon timezone; every slot uses a 15-minute boundary. Lead time is 60 minutes by default; the booking horizon is 90 days.
- Appointments can be moved or cancelled by their signed-in customer or a salon administrator. A changed appointment returns to `requested` so the team can reconfirm it.
- Admin → Appointments provides a seven-day calendar, specialist/status filters, a full register, and an availability-aware rescheduling dialog. Admin → Team manages the standard working schedule.
- In MongoDB deployments, a compound unique multikey index on `(staffId, occupiedSlots)` prevents two active bookings from sharing the same 15-minute interval even under simultaneous requests. Existing booking records are migrated during API startup; incompatible legacy records must be corrected manually.
- Appointment changes create pending email notification jobs: received, confirmed, rescheduled, cancelled and 24-hour reminder. Pending reminders are superseded when an appointment changes. A background worker polls every 30 seconds when **both** `RESEND_API_KEY` and `SALON_EMAIL_FROM` are configured.
- The email sender must be verified with the provider. Without those environment variables, jobs are **not delivered**. See the admin notification-status endpoint for pending/sent/failed counts. This is a transactional email outbox, not a marketing mailing list.
- Current limitations: standard weekly hours only (no holidays, breaks, staff leave, multi-location support), no SMS, no appointment deposits, no automatic refunds, and no two-way calendar sync. Check the salon's actual operating policies before launch.

### Environment values

| Setting | Purpose |
| --- | --- |
| `MONGODB_URI` | Persistent catalog, bookings, orders, and chat (optional only for local demo) |
| `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID` | Appwrite authentication |
| `ADMIN_USER_IDS` | Comma-separated authorized admin account IDs (server-side only) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Secure Stripe checkout and webhook verification |
| `PUBLIC_WEB_URL` | Stripe redirect origin |
| `WEB_ORIGIN` | Allowed frontend origin(s) |
| `SALON_TIME_ZONE` | IANA time zone for appointment slots (default `America/New_York`) |
| `BOOKING_MIN_LEAD_MINUTES` | Minimum advance notice for bookings (default 60) |
| `RESEND_API_KEY`, `SALON_EMAIL_FROM` | Optional real email delivery of confirmation, change, cancellation, and reminder jobs; verified sender required |
| `VITE_DEMO_MODE`, `VITE_APPWRITE_*` | Frontend preview mode and Appwrite client config |

Never commit real secrets or place Stripe secret keys in `VITE_*` variables.

## API routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | API and configuration status |
| GET | `/api/products`, `/api/services`, `/api/staff` | Public catalog |
| GET/POST | `/api/appointments` | Authenticated appointment history / new request |
| GET | `/api/availability?serviceId&staffId&date` | Duration-aware available slots in salon time zone |
| GET | `/api/appointments/:id/availability?date` | Owner/admin reschedule slot options, excluding the current booking |
| PATCH | `/api/appointments/:id` | Owner/admin reschedule (reverts to requested) |
| POST | `/api/appointments/:id/cancel` | Owner/admin cancel an upcoming appointment |
| GET | `/api/chat/:conversationId` | Private conversation history |
| POST | `/api/chat` | Store and broadcast a message |
| GET | `/api/admin/overview`, `/api/admin/conversations` | Admin-only dashboard and chat inbox |
| PATCH | `/api/admin/appointments/:id` | Admin appointment status update |
| GET/POST | `/api/admin/products`, `/api/admin/services`, `/api/admin/staff` | List all records / create records |
| PATCH | `/api/admin/products/:id`, `/api/admin/services/:id`, `/api/admin/staff/:id` | Edit catalog and team, including visibility |
| GET | `/api/admin/inventory` | Current stock and movement audit log |
| POST | `/api/admin/inventory/:id/adjust` | Atomic stock adjustment with audit reason |
| GET | `/api/admin/orders`, `/api/admin/integrations` | Order listing and safe service-status flags |
| GET | `/api/admin/notifications` | Email provider state and queue delivery counts |
| PATCH | `/api/admin/orders/:id/fulfillment` | Track fulfillment on paid orders |
| POST | `/api/checkout` | Stripe Checkout Session |
| POST | `/api/stripe/webhook` | Signed payment events |

Socket.IO: authenticated `chat:join`, `chat:typing`, and broadcast `chat:message` events. Conversation ownership is validated by the API and WebSocket layer.

## Development roadmap

### Implemented in this foundation

- Responsive selected-design storefront with featured salon products
- Product list, category filters, add-to-bag, cart persistence, checkout request
- Hair/nail/beauty service selection, specialist/date/time selection, appointment request and confirmation
- Customer account screen with Appwrite sign-in/sign-up integration points
- Staff working-hour-aware live booking availability, 15-minute slot locking, 90-day booking horizon, reschedule/cancellation workflows, and admin weekly calendar
- Notification outbox for booking updates and reminders, with real email delivery when configured
- Admin dashboard, appointment status updates, and live chat inbox with server-side access checks
- Full editor screens for product catalog, visibility, price, service menu, specialist specialties and standard workdays/hours
- Inventory adjustments with nonnegative stock enforcement and a 30-item movement audit view
- Order administration: payment state, customer email when received from Stripe, item snapshots, and paid-order fulfillment state
- Dedicated responsive admin shell with sidebar and searchable/filterable product table
- WebSocket chat transport, persistent message API when MongoDB is configured
- Stripe Checkout Session creation and signed webhook handling
- Health endpoint and basic backend tests

### Required before production

- Supply final salon brand, logo, photography, real products, staff, hours, prices, and service availability
- Collect real operating hours and add per-specialist holidays, breaks, leave, and schedule exceptions; implement booking cutoffs and cancellation windows as salon policy requires
- Add inventory reservations / post-payment deductions, guest checkout contact details, shipping/pickup options, fulfillment labels, real refunds, and order/customer history
- Implement advanced chat assignment, SMS/push notifications, product image uploads, role granularity, and staff access policies
- Finish customer order history, shipping/tax/fulfillment, cancellations, refunds, transactional email, and booking deposits
- Add server-side rate limiting, audit logging, file attachment restrictions, stronger chat moderation, MFA, monitoring, and backups
- Add comprehensive end-to-end and Stripe test-mode coverage; verify deployment behind HTTPS

## Design source

Selected hybrid concept: Maison Beau editorial warmth + SÔL booking-first UI + FORM grid and product presentation. The original design source image lives in the project workspace during design QA; it is **not** a deployed page screenshot.
