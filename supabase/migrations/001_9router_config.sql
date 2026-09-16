-- 9Router config-domain mirror (Supabase/Postgres 17).
-- Applied 2026-09-15 to project 9router (fwqzetycnrpubiaxqnuz, ap-southeast-1).
-- Scope: CONFIG tables only. Telemetry (usageHistory/usageDaily/requestDetails)
-- stays in local SQLite by design — see src/lib/db/supabase.js header.
--
-- RLS is enabled with NO permanent policies (deny-all for anon/authenticated).
-- The server uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS. Do NOT add
-- permissive policies: providerConnections.data holds plaintext OAuth tokens
-- and API keys (parity with the local SQLite file, service-role only).
create table if not exists settings (
  id integer primary key check (id = 1),
  data jsonb not null
);
create table if not exists "providerConnections" (
  id text primary key,
  provider text not null,
  "authType" text not null,
  name text,
  email text,
  priority integer,
  "isActive" boolean not null default true,
  data jsonb not null,
  "createdAt" timestamptz not null,
  "updatedAt" timestamptz not null
);
create index if not exists idx_pc_provider on "providerConnections"(provider);
create index if not exists idx_pc_provider_active on "providerConnections"(provider, "isActive");
create index if not exists idx_pc_priority on "providerConnections"(provider, priority);
create table if not exists "providerNodes" (
  id text primary key,
  type text,
  name text,
  data jsonb not null,
  "createdAt" timestamptz not null,
  "updatedAt" timestamptz not null
);
create index if not exists idx_pn_type on "providerNodes"(type);
create table if not exists "proxyPools" (
  id text primary key,
  "isActive" boolean not null default true,
  "testStatus" text,
  data jsonb not null,
  "createdAt" timestamptz not null,
  "updatedAt" timestamptz not null
);
create index if not exists idx_pp_active on "proxyPools"("isActive");
create index if not exists idx_pp_status on "proxyPools"("testStatus");
create table if not exists "apiKeys" (
  id text primary key,
  key text unique not null,
  name text,
  "machineId" text,
  "isActive" boolean not null default true,
  "createdAt" timestamptz not null
);
create index if not exists idx_ak_key on "apiKeys"(key);
create table if not exists combos (
  id text primary key,
  name text unique not null,
  kind text,
  models jsonb not null,
  "createdAt" timestamptz not null,
  "updatedAt" timestamptz not null
);
create index if not exists idx_combo_name on combos(name);
create table if not exists kv (
  scope text not null,
  key text not null,
  value jsonb not null,
  primary key (scope, key)
);
create index if not exists idx_kv_scope on kv(scope);
alter table settings enable row level security;
alter table "providerConnections" enable row level security;
alter table "providerNodes" enable row level security;
alter table "proxyPools" enable row level security;
alter table "apiKeys" enable row level security;
alter table combos enable row level security;
alter table kv enable row level security;
