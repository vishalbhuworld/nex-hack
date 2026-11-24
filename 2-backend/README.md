# Resolve — multi-store fulfilment demo

## Run locally

1. Install Node.js LTS.
2. From this folder, run `npm install` once.
3. Run `npm start` (or `npm run dev`).
4. Open `http://localhost:5000`.

The workspace root has `1-frontend/` for the web UI and `2-backend/` for the Express API, tests, and backend dependencies. The Express server serves only the UI assets from `1-frontend/`.

By default, the prototype uses in-memory demo data and simulated payments; it needs no Firebase credentials. Enable Firestore persistence by setting `FIRESTORE_PERSISTENCE=true`, `FIREBASE_PROJECT_ID=resolve-multi-store-fulfilment`, and `GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON file kept outside this repository. The backend reads and writes separate `stores`, `products`, `inventory`, `reservations`, `orders`, `financialEvents`, `issues`, `auditEvents`, `staffAccounts`, and `customers` collections. It loads them on startup and writes only changed documents after app operations. Login sessions stay in memory and require signing in again after a server restart. Do not expose the credential or commit it.

The persisted state is intended for a single backend instance and hackathon-scale data. Do not scale the API to multiple instances without moving inventory/order mutations into Firestore transactions.

Run the focused backend consistency tests with `npm test`.

## Demo sign-in

- **Customer:** enter any valid-looking email address. Email ownership is not verified in this demo.
- **Admin:** `admin` / `admin123` by default. Override with `DEMO_ADMIN_ID` and `DEMO_ADMIN_PASSWORD` in `.env`.
- **Staff:** sign in with the staff ID and password created by the admin after signing in.

## Roles

- Customers can browse products, enter delivery details at checkout, reserve stock, and see only their own order statuses.
- Customers can cancel one reserved or paid item at a time before dispatch. A paid item gets its own simulated refund; other items in the order stay active. Successful simulated payments generate a customer-visible confirmation code.
- Admins can operate the store dashboard, run demo scenarios, and create staff accounts.
- Admins can view staff accounts and customers who have signed in during the current server session.
- Staff can view store operations, the audit timeline, and delivery details needed to fulfil orders. Admin responses contain aggregate order counts, not order or delivery details.
- Payment, cancellation, and refund events can be delayed and are deduplicated by event ID. The staff timeline includes an open recovery-issues queue for store failures.
- Abandoned reservations expire after 10 minutes and are cleaned up periodically as well as during normal order reads/writes. The concurrency demo sends competing purchase attempts together against limited stock.
- Staff cannot create accounts or reset/run destructive demo scenarios.

The API enforces these demo roles as well as hiding role-specific UI. Sessions and staff accounts are in memory. This is a hackathon prototype, not production authentication or durable storage.

## Backend endpoints

- `POST /api/auth/customer` — create a demo customer session from an email.
- `POST /api/auth/admin` — sign in as admin.
- `POST /api/auth/staff` — admin-only staff account creation.
- `POST /api/auth/staff/login` — staff sign-in.
- `GET /api/orders/catalog` — customer product catalog and available quantities.
- `GET /api/orders` — own orders for customers; full operations snapshot for admin/staff.
- `POST /api/orders` — reserve stock for a customer order.
- `POST /api/orders/:orderId/payment` — process a simulated payment for remaining reserved items; successful payments return a confirmation code and repeated event IDs are ignored.
- `POST /api/orders/:orderId/cancel` — cancel one item from the caller's own order using its `itemId`; a paid item records a refund for that item only.
- `POST /api/orders/:orderId/fail-store/:storeId` — simulate a store failure; `refundDelayMs` can delay the simulated refund.
- `POST /api/orders/:orderId/issues/:issueId/resolve` — staff marks a recovery issue reviewed.
- Delivery name, phone, street address, city, and six-digit PIN are required for customer checkout. These details are returned only to staff; customers see their own order status and admins see aggregate counts.
- `POST /api/controls/concurrency-demo` — admin/staff concurrency scenario.
- `POST /api/controls/reset` — admin-only demo reset.
