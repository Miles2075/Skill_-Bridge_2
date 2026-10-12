# SkillBridge

SkillBridge is a local online learning platform for students and instructors, with a server-side LMS API.

## Stack
- TanStack Start + React + TypeScript
- Neon Postgres for production persistence
- Vercel Blob for course videos, thumbnails, and profile pictures
- Razorpay for course payments

## Local development

Requirements: Node.js and npm.

```sh
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:3000 in your browser.

## Vercel production setup

1. In Vercel, open the project and select **Settings → Environment Variables**.
2. Set `DATABASE_URL` to the Neon Postgres connection string. Use the pooled Neon URL if available.
3. Set `BLOB_READ_WRITE_TOKEN` by connecting a Vercel Blob store (public access is used for course media).
4. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` from the same Razorpay mode (test or live).
5. Set `VITE_RAZORPAY_KEY_ID` to the matching public Razorpay key ID.
6. Redeploy the project.

The app creates its `skillbridge_lms_state` row in Neon on the first LMS API request. Without `DATABASE_URL`, the server uses the local JSON file; that fallback is only suitable for local development because serverless filesystems are ephemeral.

## Migrate local LMS data to Neon

Back up the current Neon state before migrating; this command replaces the `primary` state snapshot.

```sh
npm run db:migrate
```

Run the command locally with `DATABASE_URL` set in the environment. Never commit real credentials to GitHub.

## LMS API basics
- `POST /api/lms/auth/signup` and `POST /api/lms/auth/login`
- `GET /api/lms/courses` and `GET /api/lms/course?idOrSlug=...`
- `GET /api/lms/my-purchases`
- `POST /api/lms/purchase-confirmed` — verifies a captured Razorpay payment server-side before recording the purchase and enrolling the current user

The generic `/api/lms/query` compatibility endpoint is allow-listed and does not permit arbitrary database writes. Course and lesson changes must use the dedicated LMS endpoints.
