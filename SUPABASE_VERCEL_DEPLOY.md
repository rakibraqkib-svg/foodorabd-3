# Foodora BD — Node.js + Vercel + Supabase Deployment Guide

This project is a full-stack TypeScript application with:
- **Frontend**: React 19 + Vite + Tailwind CSS v4 (`src/`)
- **Node.js Backend**: Express API (`server.ts`)
- **Vercel Serverless Entry**: `api/index.mjs` + `vercel.json` (routes `/api/*` to Node.js serverless and all pages to `dist/index.html`)
- **Authentication**: **Supabase Auth** (`@supabase/supabase-js` Google OAuth + Email/Password)
- **Database**: **Supabase PostgreSQL** + Drizzle ORM (`src/db/schema.ts`) with automatic table bootstrap & seeding on cold start

---

## 1. Configure Supabase URL Redirects (For Google Sign-In)
1. Open your Supabase project (`https://supabase.com/dashboard/project/uvqptlflvdtxbrqiztzi`).
2. Go to **Authentication -> URL Configuration**:
   - **Site URL**: `https://foodorabd-3-nine.vercel.app`
   - **Redirect URLs** (add all of these):
     - `https://foodorabd-3-nine.vercel.app/**`
     - `https://foodorabd-3-nine.vercel.app`
     - `https://*.vercel.app/**`
     - `http://localhost:3000/**`

---

## 2. Deploy to Vercel
1. Push or import the `rakibraqkib-svg` GitHub repo into Vercel (or run `npx vercel --prod`).
2. In **Vercel Project Settings -> Environment Variables**, add:
   - `DATABASE_URL` = your Supabase Pooler URI (`postgresql://postgres.uvqptlflvdtxbrqiztzi:[YOUR-PASSWORD]@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres`)
   - `POSTGRES_URL_NON_POOLING` = direct connection (`postgresql://postgres:[YOUR-PASSWORD]@db.uvqptlflvdtxbrqiztzi.supabase.co:5432/postgres`)
   - `VITE_SUPABASE_URL` = `https://uvqptlflvdtxbrqiztzi.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2cXB0bGZsdmR0eGJycWl6dHppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5Mjk4NjksImV4cCI6MjExMDUwNTg2OX0.4NdWe8fXBv6qE_sVvUZhofFW5CVQJAY_X1IvkwB69ZE`
   - `SUPABASE_URL` = `https://uvqptlflvdtxbrqiztzi.supabase.co`
   - `SUPABASE_ANON_KEY` = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2cXB0bGZsdmR0eGJycWl6dHppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5Mjk4NjksImV4cCI6MjExMDUwNTg2OX0.4NdWe8fXBv6qE_sVvUZhofFW5CVQJAY_X1IvkwB69ZE`
   - `SUPABASE_SERVICE_ROLE_KEY` = your Supabase `sb_secret_...` key (keep private in Vercel Env Vars only, never commit to Git)
   - `SANDBOX_SESSION_SECRET` = any strong random 32+ character string
   - `GOOGLE_SITE_VERIFICATION` = your Google Search Console verification token (optional — can also be saved in Admin Panel -> Google SEO & Search Console)
   - `VITE_GOOGLE_MAPS_API_KEY` = your Google Maps Browser API key (optional — built-in Dhaka interactive map works without it)
3. Vercel automatically deploys with `vercel.json`:
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
   - **Node.js API Serverless Handler**: `api/index.mjs` (serves `/api/*`, `/sitemap.xml`, `/robots.txt`, and Google HTML verification files)
4. On the first `/api/*` request, `ensureSchemaTables()` & `ensureDatabaseSeeded()` automatically initialize all PostgreSQL tables and seed restaurants, dishes, riders, and coupons if empty!

---

## 3. Google Search Console Verification & Sitemap Submission
1. Open [Google Search Console](https://search.google.com/search-console/welcome) and add URL prefix property: `https://foodorabd-3-nine.vercel.app`.
2. Choose **HTML tag** verification, copy the `content="..."` token (or HTML filename `googleXXXX.html`), and paste it into **Admin Panel -> Site Settings -> Google Search Console Verification Code** (or set `GOOGLE_SITE_VERIFICATION` in Vercel Environment Variables).
3. Click **Verify** in Google Search Console, then open **Sitemaps** and submit: `https://foodorabd-3-nine.vercel.app/sitemap.xml`.

---

## 4. Run Locally with Node.js
```bash
npm install
npm run db:push
npm run dev
```
App runs on `http://localhost:3000`.
