# Salon Platform Template

A bespoke full-stack salon platform: public beauty/hair/nail storefront, appointment booking, customer accounts, admin foundation, WebSocket live chat, and Stripe Checkout. Built independently of Shopify.

**Current stage: development foundation / preview. Not production-ready.** The salon name **Atelier Beauty**, images, staff, services, products, and prices are placeholders until the real salon provides its content.

## Project structure

```text
apps/
  web/   React + Vite frontend (public site, booking, shop, account, admin preview)
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

`DEMO_MODE=true` is explicitly **development-only**. It uses seeded products, services, and specialists; appointments and chat messages are stored in memory if `MONGODB_URI` is omitted. Data disappears when the server restarts. The demo profile is `demo-customer`; preview admin is at `/admin`.

**Never deploy demo mode publicly.** Production startup refuses `DEMO_MODE=true` and requires a database plus Appwrite authentication configuration. For production, the `ADMIN_USER_IDS` setting must contain only trusted Appwrite user IDs. Admin permissions are checked server-side.

## Stripe integration

- `POST /api/checkout` validates product IDs, quantities, inventory, and prices server-side, then creates a Stripe Checkout Session.
- `POST /api/stripe/webhook` validates the Stripe signature over the raw request body and updates order payment state from verified events.
- Checkout is intentionally unavailable without both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. **No simulated payment success** is used.
- Use a test-mode Stripe account while developing. Configure the actual webhook endpoint and success/cancel URLs before launch.

### Environment values

| Setting | Purpose |
| --- | --- |
| `MONGODB_URI` | Persistent catalog, bookings, orders, and chat (optional only for local demo) |
| `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID` | Appwrite authentication |
| `ADMIN_USER_IDS` | Comma-separated authorized admin account IDs (server-side only) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Secure Stripe checkout and webhook verification |
| `PUBLIC_WEB_URL` | Stripe redirect origin |
| `WEB_ORIGIN` | Allowed frontend origin(s) |
| `VITE_DEMO_MODE`, `VITE_APPWRITE_*` | Frontend preview mode and Appwrite client config |

Never commit real secrets or place Stripe secret keys in `VITE_*` variables.

## API routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | API and configuration status |
| GET | `/api/products`, `/api/services`, `/api/staff` | Public catalog |
| GET/POST | `/api/appointments` | Authenticated appointment history / new request |
| GET | `/api/chat/:conversationId` | Private conversation history |
| POST | `/api/chat` | Store and broadcast a message |
| GET | `/api/admin/overview`, `/api/admin/conversations` | Admin-only dashboard and chat inbox |
| PATCH | `/api/admin/appointments/:id` | Admin appointment status update |
| POST | `/api/checkout` | Stripe Checkout Session |
| POST | `/api/stripe/webhook` | Signed payment events |

Socket.IO: authenticated `chat:join`, `chat:typing`, and broadcast `chat:message` events. Conversation ownership is validated by the API and WebSocket layer.

## Development roadmap

### Implemented in this foundation

- Responsive selected-design storefront with featured salon products
- Product list, category filters, add-to-bag, cart persistence, checkout request
- Hair/nail/beauty service selection, specialist/date/time selection, appointment request and confirmation
- Customer account screen with Appwrite sign-in/sign-up integration points
- Admin dashboard, appointment status updates, and live chat inbox with server-side access checks
- WebSocket chat transport, persistent message API when MongoDB is configured
- Stripe Checkout Session creation and signed webhook handling
- Health endpoint and basic backend tests

### Required before production

- Supply final salon brand, logo, photography, real products, staff, hours, prices, and service availability
- Replace the fixed time-slot example with real operating hours, staff schedules, time zones, duration-aware availability and transactional locking
- Complete admin CRUD for products, inventory, services, staff, order fulfillment, and advanced chat assignment
- Finish customer order history, shipping/tax/fulfillment, cancellations, refunds, transactional email, and booking deposits
- Add server-side rate limiting, audit logging, file attachment restrictions, stronger chat moderation, MFA, monitoring, and backups
- Add comprehensive end-to-end and Stripe test-mode coverage; verify deployment behind HTTPS

## Design source

Selected hybrid concept: Maison Beau editorial warmth + SÔL booking-first UI + FORM grid and product presentation. The original design source image lives in the project workspace during design QA; it is **not** a deployed page screenshot.
