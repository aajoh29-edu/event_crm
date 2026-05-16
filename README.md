# Classic Productions — Website + CRM

Full local-testable stack: public event website + admin CRM dashboard, backed by SQLite.

## Quick Start

Requires **Node.js 18+** ([download](https://nodejs.org/)).

```bash
# 1. Install dependencies
npm install

# 2. Initialize the database (creates db/classic.db with seed data)
npm run init-db

# 3. Start the server
npm start
```

Then open:
- **Public website:** http://localhost:3000
- **Admin CRM:** http://localhost:3000/admin
- **Default login:** `admin` / `admin123`

> Change `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env` before going live.

## Project Structure

```
classic-productions/
├── server.js              Main Express server
├── package.json
├── .env                   Config (port, admin creds, session secret)
├── db/
│   ├── init.js            Database schema + seed data
│   ├── connection.js      Shared DB connection
│   └── classic.db         SQLite file (created on first run)
├── routes/
│   ├── auth.js            Login/logout/session
│   ├── public.js          Public API (events, reservations, contact, bookings)
│   └── admin.js           Admin CRM API (CRUD for everything)
├── public/
│   └── index.html         Public-facing website
└── admin/
    ├── login.html         Admin login page
    └── index.html         CRM dashboard (single-page app)
```

## Features

### Public Website (`/`)
- Hero + branded event lineup pulled from the database
- "Book Tickets" modal per event (creates booking + customer record)
- Table reservation form (creates reservation + customer record)
- Contact form (creates message in CRM)
- Newsletter signup

### CRM Dashboard (`/admin`)
- **Dashboard:** revenue, customers, VIPs, pending reservations, unread messages, charts
- **Customers:** searchable list, add/edit/delete, detail view showing all their bookings + reservations
- **Events:** full CRUD with status (active/cancelled/completed), per-event revenue + booking counts
- **Bookings:** all ticket purchases, status management (confirmed/cancelled/refunded)
- **Reservations:** all table bookings from website, approve/cancel/confirm
- **Messages:** contact form submissions, mark read/replied
- **Subscribers:** newsletter list management

## Testing the Flow

1. Go to http://localhost:3000
2. Book a ticket on any event → fill out the modal → submit
3. Submit a reservation → submit the contact form → subscribe to newsletter
4. Open http://localhost:3000/admin → log in
5. Watch the records show up in real time across all tabs

## Migrating to Google Cloud

When you're ready to deploy:

1. **App Engine / Cloud Run:** the server is stateless except for SQLite. For multi-instance deploys, swap `better-sqlite3` for **Cloud SQL (PostgreSQL/MySQL)** — only `db/connection.js`, `db/init.js`, and the query syntax in routes need to change. The schema is standard SQL.
2. **Sessions:** swap the default in-memory session store for `connect-redis` (Memorystore) or `connect-pg-simple`.
3. **Secrets:** move `.env` values to Google Secret Manager.
4. **Static files:** Cloud Run serves `/public` and `/admin` fine as-is; for higher scale, push to Cloud Storage + CDN.
5. **Domain + HTTPS:** Cloud Run gives you a managed cert automatically.

Add a `Dockerfile`:
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN node db/init.js
EXPOSE 3000
CMD ["node", "server.js"]
```

## Troubleshooting

- **`better-sqlite3` install errors:** you need build tools. On Mac: `xcode-select --install`. On Ubuntu: `sudo apt install build-essential python3`. On Windows: install Visual Studio Build Tools.
- **Port in use:** change `PORT` in `.env`.
- **Reset the database:** delete `db/classic.db` and run `npm run init-db` again.
