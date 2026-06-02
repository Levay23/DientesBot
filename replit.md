# Dientes Fijos Medellín — CRM

Sistema CRM para clínica dental. Permite gestionar pacientes, citas, mensajes de WhatsApp con IA, y automatizaciones de seguimiento.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/crm run dev` — run the CRM frontend (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL`, `SESSION_SECRET`, `GROQ_API_KEY`

## Default Credentials

- **Email:** admin@dientesfijosmedellin.com
- **Password:** Dientes123

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 (port 8080, path `/api`)
- CRM: React + Vite (port 5000, path `/`)
- DB: PostgreSQL + Drizzle ORM
- AI: Groq SDK (`llama-3.3-70b-versatile`), assistant name "Andrea"
- WhatsApp: Baileys (WhatsApp Web protocol)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/db/src/schema.ts` — DB schema (source of truth)
- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth for contracts)
- `lib/api-zod/src/` — Generated Zod schemas
- `lib/api-client-react/src/` — Generated React Query hooks
- `artifacts/api-server/src/lib/groq.ts` — AI prompt + Andrea personality
- `artifacts/api-server/src/lib/whatsapp.ts` — WhatsApp connection + message handling
- `artifacts/crm/src/pages/` — CRM frontend pages

## Architecture decisions

- Contract-first: OpenAPI spec → Zod schemas + React Query hooks via Orval codegen
- Sessions stored server-side (express-session + connect-pg-simple) with `SESSION_SECRET`
- WhatsApp uses Baileys (WhatsApp Web protocol), no Meta API required
- AI (Groq) handles full booking flow: extracts patient name/phone, suggests available slots, registers patient, creates appointment
- Automations are stored rules (trigger + message template + delay) — currently manual-trigger only, no scheduler

## Product

- **Dashboard** — clinic stats, today's appointments, recent activity, monthly chart
- **Agenda** — day/week calendar view, CRUD appointments
- **Pacientes** — patient list with search, medical history
- **Chat Center** — WhatsApp conversation inbox, AI chat history
- **WhatsApp** — QR scan to connect number, bot enable/disable toggle
- **Automatizaciones** — message automation rules (reminder, follow-up, welcome, etc.)
- **Configuración** — clinic hours, AI personality & knowledge base

## User preferences

- Times shown in 12h AM/PM format (a.m./p.m.) everywhere
- Dashboard title: "Dientes Fijos Medellín" with 🦷 emoji, gradient serif font
- AI assistant name: Andrea
- Spanish (Colombia) locale throughout

## Gotchas

- WhatsApp session is persisted in PostgreSQL table `whatsapp_auth`. Use **WhatsApp → Desconectar** in the CRM or `POST /api/whatsapp/disconnect` to reset and scan QR again.
- `GROQ_API_KEY` is required for the AI assistant — without it, AI responses will fail.
- The `artifacts/crm: Dientes Fijos Medellín CRM` workflow (port 22444) is a stale manually-configured workflow; the canonical one is `artifacts/crm: web` (port 5000).
- Automations run automatically every **15 minutes** when the API server is up and WhatsApp is connected.
- **Render:** keep a **single instance** of `dientesbot-api` — Baileys cannot run on multiple nodes. Check `GET /api/healthz` for DB + WhatsApp status.
- Agent messages from Chat Center are sent to the patient's WhatsApp when the session is connected.
- Run `pnpm --filter @workspace/db run push` after any schema change before restarting the API server.
- CI: GitHub Actions runs `pnpm run typecheck` and `pnpm run build` on push/PR to `main`/`master`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
