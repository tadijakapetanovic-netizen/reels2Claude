# Common reel claims: what's true, and how to check

The claims "your vibe-coded app needs X" videos repeat most. Each entry: **Reality** (the nuance the
video usually skips), **Check** (where to look in a repo), **Fix** (the usual change). When current
official docs disagree with this file, trust the docs and say so.

Last reviewed: 2026-09-30.

---

## Keys and secrets

### "Your API keys are exposed in the frontend"

**Reality:** Correct for *secret* keys, misleading for keys designed to be public. Anything that ends
up in the browser bundle or mobile app is readable by anyone who looks.

Env vars with these prefixes are **inlined into client code** at build time:

| Framework | Public prefix |
|---|---|
| Next.js | `NEXT_PUBLIC_` |
| Vite (React/Vue/Svelte) | `VITE_` |
| Expo / React Native | `EXPO_PUBLIC_` |
| Create React App | `REACT_APP_` |
| SvelteKit | `PUBLIC_` (`$env/static/public`) |
| Astro | `PUBLIC_` |
| Nuxt | `NUXT_PUBLIC_` / `runtimeConfig.public` |
| Gatsby | `GATSBY_` |

- **Meant to be public** (fine in the client, if the backend is locked down): Supabase anon /
  `sb_publishable_…` key, Firebase web config `apiKey`, Stripe `pk_…`, Clerk publishable key,
  Sentry DSN, PostHog project key, Google Maps browser key (should be HTTP-referrer restricted).
- **Secret** (server only): Supabase `service_role` / `sb_secret_…`, OpenAI `sk-…`, Anthropic
  `sk-ant-…`, Stripe `sk_…` / `rk_…` / webhook `whsec_…`, Resend `re_…`, Twilio auth token, AWS
  secret access key, database URLs containing a password, JWT signing secrets.
- In Expo / React Native, **everything** in the JS bundle is extractable, not just `EXPO_PUBLIC_`
  vars, so hardcoded constants count too.

**Check:** env var names with a public prefix that contain `SECRET`, `SERVICE_ROLE`, `PRIVATE`,
`OPENAI`, `STRIPE_SECRET`; literal key patterns in client code; client components (`'use client'`,
Vite/Expo source) that call paid APIs directly (`api.openai.com`, `api.anthropic.com`).

**Fix:** move the call behind a server route / server action / edge function; drop the public prefix;
**rotate** any secret that has ever shipped to a client (old bundles stay cached and public).

### "Never expose your Supabase service_role key"

**Reality:** Correct and critical. `service_role` (legacy JWT) and the newer `sb_secret_…` keys bypass
Row Level Security entirely: whoever has one can read and write every table. Supabase is replacing
`anon`/`service_role` with `sb_publishable_…`/`sb_secret_…`; the same rule applies to both
generations.

**Check:** `createClient(url, <service key>)` in code that runs in the browser or app; env names like
`NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`; hardcoded `eyJ…` JWTs (the payload's `role` claim says
`anon` or `service_role`); `sb_secret_` strings anywhere outside server-only code.

**Fix:** use it only in server code; rotate it in the Supabase dashboard (API settings) if it ever
reached a client.

### "Your Supabase anon key is visible in the browser, you're exposed!"

**Reality:** **Misleading.** The anon / publishable key is *designed* to be public. What protects the
data is Row Level Security (next section). Verdict is usually ❌ for the key itself, while the RLS
question still needs checking.

### "Your Firebase API key is public!"

**Reality:** **Misleading.** Firebase's web `apiKey` identifies the project; it isn't a secret. The
protection is Security Rules (and optionally App Check). Judge the rules instead (see below).

### "Don't commit your .env file"

**Reality:** Correct. A key pushed to a public repo gets scraped by bots within minutes, and deleting
the file later doesn't remove it from git history.

**Check:** `.gitignore` covers `.env`, `.env.local`, `.env*.local`; whether an env file with real
values is tracked (read-only: `git ls-files` if it's a git repo); `.env.example` should hold
placeholders only.

**Fix:** add the ignore rule, untrack the file, and **rotate every key it contained**.

---

## Database access

### "Enable Row Level Security (RLS) on Supabase or anyone can read your database"

**Reality:** Correct and usually critical for apps that talk to Supabase from the browser or a mobile
app. Tables in exposed schemas (`public` by default) without RLS can be read **and written** by anyone
holding the public anon key, which is everyone. Details the videos skip:

- Tables made in the dashboard **Table Editor** get RLS on by default. Tables made with **SQL or
  migrations** do **not**, and that's where vibe-coded apps get caught.
- RLS on with **no policies** = nobody can access the table (safe, but the app breaks).
- A policy like `using (true)` for `anon`/`authenticated` on private data = RLS in name only.
- An `update` policy without `with check` can let users change columns they shouldn't (e.g. their own
  `role` or `plan`).
- **Views** bypass RLS unless created `with (security_invoker = true)`; `security definer` functions
  run with their owner's rights.
- Storage buckets marked **public** serve every file to anyone with the URL; private buckets need
  policies on `storage.objects`.

**Check:** `supabase/migrations/*.sql`: for each `create table`, a matching
`alter table … enable row level security` and sensible `create policy` statements; grep for
`using (true)`, `security definer`, `create view`. No migrations in the repo → ❓: Dashboard →
Advisors → Security Advisor flags tables with RLS disabled, or run
`select tablename, rowsecurity from pg_tables where schemaname = 'public';` in the SQL editor.

**Fix:** `alter table public.x enable row level security;` plus owner-scoped policies, e.g.
`create policy "own rows" on public.notes for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);`
Test the app afterwards: missing policies show up as empty results or permission errors.

### "Firebase: your database is open (test mode)"

**Reality:** Correct when rules are `allow read, write: if true;`. The default "test mode" rules
(`if request.time < timestamp.date(…)`) are wide open until that date, then lock everyone out.

**Check:** `firestore.rules`, `storage.rules`, `database.rules.json`. Not in the repo → ❓ Firebase
console → Firestore / Storage → Rules.

**Fix:** per-user rules, e.g.
`match /users/{userId}/{doc=**} { allow read, write: if request.auth != null && request.auth.uid == userId; }`

### "Your app is vulnerable to SQL injection"

**Reality:** Usually **doesn't apply**. Query builders and ORMs (supabase-js, Prisma, Drizzle, Knex,
Mongoose) parameterize values. The real risk is hand-built SQL.

**Check:** `$queryRawUnsafe` / `$executeRawUnsafe` (Prisma), SQL built with string concatenation or
untagged template strings, `sql.raw(…)`, Postgres functions that `execute format(…)` with user input.

**Fix:** parameterized queries (`$queryRaw` tagged templates, placeholders, `format('%L', …)`).

---

## Authorization and money

### "Check auth on every API route / server action"

**Reality:** Correct and often critical. Hidden buttons protect nothing: every API route, and every
Next.js **server action**, is a public HTTP endpoint anyone can call. Two separate checks are needed:
*who is this* (authentication) and *may they touch this record* (authorization). A classic hole is
`GET /api/notes/123` returning note 123 to anyone (IDOR). Routes using an admin / service-role client
skip RLS, so they must check ownership themselves.

**Check:** each route handler / server action: does it get the user from a verified session and scope
queries by owner (`.eq('user_id', user.id)`) or rely on RLS with the user's own client?

**Fix:** verify the session first; filter by owner; return 401/403/404 otherwise.

### "Supabase: use getUser() / getClaims() on the server, not getSession()"

**Reality:** Correct. On the server, `getSession()` reads the session from cookies **without
verifying it**, so it can be forged. Use `getClaims()` (verifies the JWT, locally with asymmetric
keys) to protect pages and data, or `getUser()` (asks the Auth server; always current). In
browser-only code, `getSession()` is fine.

**Check:** `auth.getSession()` in middleware, route handlers, server components, server actions.

### "Paywalls / premium checks in the frontend can be bypassed"

**Reality:** Correct. If `if (user.plan === 'pro')` only runs in the browser, the paid feature's API
is free for anyone who calls it directly. Also check the user can't write their own `plan` / `role`
column (see RLS `with check`).

**Check:** where plan / role / credits are checked; whether the server repeats the check.

### "Verify your Stripe webhook signatures"

**Reality:** Correct and critical when webhooks grant access or credits. Without verification anyone
can POST a fake "payment succeeded" event.

**Check:** the webhook route calls `stripe.webhooks.constructEvent(rawBody, signature, whsec)`. In the
Next.js App Router the raw body is `await req.text()`, **not** `req.json()`.

### "Add rate limiting"

**Reality:** **Depends.** Critical for endpoints that cost money per call (AI/LLM proxies, SMS,
email), for sign-up/login/password-reset if the auth is self-built, and for public forms. Low value for
ordinary authenticated CRUD in a small app. Managed auth (Supabase, Firebase, Clerk) already
rate-limits its own endpoints.

**Check:** `@upstash/ratelimit`, `express-rate-limit`, custom middleware; AI routes that have neither
auth nor limits. Host-level rules (Vercel Firewall, Cloudflare) aren't visible → ❓. In-memory
limiters don't work on serverless (each instance has its own memory).

**Fix:** require auth on paid endpoints first, then a per-user/IP limit with a shared store (e.g.
Upstash Redis). Also set a monthly spending cap in the AI provider's dashboard (❓).

---

## Web and app hardening

### "Validate and sanitize all input" / "XSS"

**Reality:** Partly correct. React, Vue and Svelte escape output by default, so XSS mostly comes from
`dangerouslySetInnerHTML`, `v-html`, `{@html}`, `innerHTML`, or rendering user markdown/HTML without a
sanitizer. Server-side validation of shape and length (e.g. zod) is a sound 🟡 medium practice.

**Check:** those APIs fed with user content; request bodies used without validation.

### "Add security headers / a CSP"

**Reality:** Mostly 🟡/⚪ for small apps. Cheap wins: `Strict-Transport-Security`, clickjacking
protection (`X-Frame-Options: DENY` or CSP `frame-ancestors`), `X-Content-Type-Options: nosniff`,
`Referrer-Policy`. A full Content-Security-Policy is valuable but easy to get wrong, and a broken
CSP breaks the app.

**Check:** `headers()` in `next.config.*`, middleware, `vercel.json`, `netlify.toml`, `_headers`.

### "CORS * is insecure"

**Reality:** **Depends.** `Access-Control-Allow-Origin: *` is fine for a public API without cookies.
The real problem is reflecting any origin together with `Access-Control-Allow-Credentials: true`.
Same-origin routes (a Next.js app calling its own `/api`) need no CORS at all.

### "Hash your passwords"

**Reality:** Correct, but **doesn't apply** when a managed auth provider handles passwords (Supabase
Auth, Firebase Auth, Clerk, Auth0, OAuth-only NextAuth/Auth.js) → ✅ or ➖. Only relevant if the app
stores passwords itself.

**Check:** a `password` column or field in the app's own tables; `bcrypt` / `argon2` usage.

### "Update your dependencies / run npm audit"

**Reality:** **Depends.** `npm audit` is noisy (many findings are dev-only or unreachable). What
matters is keeping the framework and auth libraries patched. For example, CVE-2025-29927 let
attackers skip Next.js middleware (and any auth check in it) by sending an `x-middleware-subrequest`
header; it was fixed in 12.3.5, 13.5.9, 14.2.25 and 15.2.3.

**Check:** installed versions in `package.json` / the lockfile; for current advisories use web search
rather than memory.

### "Store tokens in secure storage, not AsyncStorage" (React Native / Expo)

**Reality:** **Depends**, usually 🟡. AsyncStorage is unencrypted app storage; `expo-secure-store` uses
the Keychain / Keystore. The risk is mainly rooted/jailbroken devices and device backups. Note that
SecureStore has value-size limits, so auth libraries' docs sometimes show AsyncStorage or an
encrypted-storage wrapper; follow the auth provider's current React Native guide.

### "Turn on email confirmation / MFA / CAPTCHA / leaked-password protection"

**Reality:** Useful against fake sign-ups and account takeover, 🟡 for most apps. These are dashboard
settings of the auth provider → usually ❓, with exact menu paths for the user.

---

## AI features

### "Your AI feature is vulnerable to prompt injection"

**Reality:** **Depends.** Low risk for a plain chatbot. Real risk when the model can take actions
(tools, sending email, database writes, browsing) or when its output is trusted as code/SQL/HTML, or
when secrets are placed in the prompt.

**Check:** what the model's output can trigger; whether user or web content is mixed into prompts that
carry secrets or privileges; whether model output is rendered as HTML or executed.

**Fix:** keep secrets out of prompts, require confirmation for consequential actions, and treat model
output as untrusted input.

### "Anyone can drain your OpenAI credits"

**Reality:** Correct if an AI endpoint has no auth and no limits, or the key is in the client. See
"exposed API keys" and "rate limiting" above. Set a spending cap in the provider dashboard (❓).

---

## Hype patterns (usually ❌ or ➖)

- **"You need microservices / Kubernetes / Redis / a separate backend"** for an app with few users:
  premature; complexity is its own risk.
- **"Framework X is insecure, switch to Y"**: security comes from configuration and code, not brand.
- **"Every vibe-coded app gets hacked in 5 minutes"**: urgency is not a claim. Judge the specifics.
- **"Buy my template / course / audit to fix this"**: judge the claim on its merits; the pitch
  isn't evidence.
- **Advice aimed at a different stack** (e.g. Firebase rules advice for a Supabase app): ➖, and say
  what the equivalent check is for this stack.
