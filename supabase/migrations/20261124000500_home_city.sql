-- A member's home city saved with their account (owner directive 24 Nov 2026 14:59 UTC, 3C; docs/83 named this as the
-- small next step). Until now the chosen city lived only in a cookie on one browser. One nullable column on the
-- member's own preferences row, which only they can read or write (the existing row rule). Null means "not chosen":
-- the browser's choice or the default market applies. Nobody else, friends included, can see it.
--
-- Adds a column only: no row changes. Rollback: alter table public.user_preferences drop column home_market.

alter table public.user_preferences
  add column if not exists home_market text references public.markets (slug) on update cascade on delete set null;
comment on column public.user_preferences.home_market is 'The member''s chosen city (a public.markets slug); private to them (docs/83).';
