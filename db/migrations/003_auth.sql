-- Login dengan email dan kata sandi (diputuskan 2026-11-16).
-- Kata sandi disimpan sebagai hash scrypt; sesi disimpan sebagai hash SHA-256 dari token cookie.

alter table app_user add column password_hash text;

create table session (
  token_hash  text primary key,
  user_id     uuid not null references app_user(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index session_user_idx on session (user_id);
