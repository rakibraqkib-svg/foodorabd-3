# Foodora BD — Node.js + Vercel + Supabase Deployment Guide

This project is a full-stack TypeScript application with:
- **Frontend**: React 19 + Vite + Tailwind CSS v4 (`src/`)
- **Node.js Backend**: Express API (`server.ts`)
- **Vercel Serverless Entry**: `api/index.mjs` + `vercel.json` (routes `/api/*` to Node.js serverless and all pages to `dist/index.html`)
- **Authentication**: **Supabase Auth** (`@supabase/supabase-js` Google OAuth + Email/Password)
- **Database**: **Supabase PostgreSQL** + Drizzle ORM (`src/db/schema.ts`) with automatic table bootstrap & seeding on cold start

---

## 1. Configure Supabase URL Redirects (For Google Sign-In)
1. Open your Supabase project (`https://supabase.com/dashboard/project/joxahjncgxsikggsqmrh`).
2. Go to **Authentication -> URL Configuration**:
   - **Site URL**: `https://your-app.vercel.app`
   - **Redirect URLs** (add all of these):
     - `https://your-app.vercel.app/**`
     - `https://*.vercel.app/**`
     - `http://localhost:3000/**`
3. Verify **Authentication -> Providers -> Google** is enabled with your Google OAuth Client ID & Secret.

---

## 2. Deploy to Vercel
1. Push or import the project into Vercel (or run `npx vercel --prod`).
2. In **Vercel Project Settings -> Environment Variables**, add:
   - `DATABASE_URL` = your Supabase Pooler URI (`postgresql://postgres.joxahjncgxsikggsqmrh:[YOUR-PASSWORD]@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`)
   - `VITE_SUPABASE_URL` = `https://joxahjncgxsikggsqmrh.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpveGFoam5jZ3hzaWtnZ3NxbXJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0NzQyMjUsImV4cCI6MjExMDA1MDIyNX0.4YArqUGJx3wDfjAHmzcuXtbxU0yaKcJcRqMiKSRZOZg`
   - `SUPABASE_URL` = `https://joxahjncgxsikggsqmrh.supabase.co`
   - `SUPABASE_ANON_KEY` = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpveGFoam5jZ3hzaWtnZ3NxbXJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0NzQyMjUsImV4cCI6MjExMDA1MDIyNX0.4YArqUGJx3wDfjAHmzcuXtbxU0yaKcJcRqMiKSRZOZg`
   - `SUPABASE_SERVICE_ROLE_KEY` = your Supabase secret key (optional, for server-side admin verification)
   - `SANDBOX_SESSION_SECRET` = any strong random 32+ character string
   - `VITE_GOOGLE_MAPS_API_KEY` = your Google Maps Browser API key (optional — built-in Dhaka interactive map works without it)
3. Vercel automatically deploys with `vercel.json`:
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
   - **Node.js API Serverless Handler**: `api/index.mjs` (pre-bundled from `server.ts` during `npm run build`)
4. On the first `/api/*` request, `ensureSchemaTables()` & `ensureDatabaseSeeded()` automatically initialize all PostgreSQL tables and seed restaurants, dishes, riders, and coupons if empty!

---

## 3. Run Locally with Node.js
```bash
npm install
npm run db:push
npm run dev
```
App runs on `http://localhost:3000`.
