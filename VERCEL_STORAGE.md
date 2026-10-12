# Vercel production storage

SkillBridge is built around a server-side LMS API.

- **Neon Postgres** stores the LMS state snapshot (accounts, sessions, courses, lessons, enrollments, progress, assignments, submissions, quizzes, certificates, and purchases).
- **Vercel Blob** stores uploaded profile pictures, course thumbnails, and lesson videos.
- **Razorpay** creates payment orders and verifies course purchases.

## Environment variables

Set these in **Vercel → Project → Settings → Environment Variables**:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon Postgres connection string |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob upload/read-write token |
| `RAZORPAY_KEY_ID` | Server-side Razorpay key ID |
| `RAZORPAY_KEY_SECRET` | Server-only Razorpay secret |
| `VITE_RAZORPAY_KEY_ID` | Public checkout key ID; must match `RAZORPAY_KEY_ID` |

Never use `VITE_` for a secret. Never commit a real key or database password.

## Setup

1. Add/connect Neon to the Vercel project and confirm `DATABASE_URL` exists for Production and Preview as needed.
2. Add/connect a Vercel Blob store; verify `BLOB_READ_WRITE_TOKEN` is available to deployments.
3. Add the matching Razorpay test keys first. Switch both keys to live mode only when ready to accept real payments.
4. Redeploy after changing variables.

The app creates `skillbridge_lms_state` automatically on the first LMS API request.

## Move local JSON data into Neon

Set `DATABASE_URL` locally and run:

```sh
npm run db:migrate
```

This replaces the Neon primary snapshot with `data/lms-db.json`. Export/back up production data before running it.
