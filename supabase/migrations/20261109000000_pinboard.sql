-- Pinboard: multi-user corkboard (raided-hex project, pb_ prefix).
-- Access model: a board's uuid IS the share secret. Tables have RLS on with NO
-- policies, so the anon key can't list or touch anything directly; every read/write
-- goes through SECURITY DEFINER RPCs that require the board uuid. Live sync uses
-- Realtime broadcast/presence on channel "pb:<board uuid>", not postgres_changes.

create table if not exists public.pb_boards (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default 'Untitled board',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.pb_items (
  id          uuid primary key,
  board_id    uuid not null references public.pb_boards(id) on delete cascade,
  kind        text not null check (kind in ('postit','card','photo','placeholder')),
  x           real not null default 0,
  y           real not null default 0,
  w           real not null default 200,
  h           real not null default 200,
  rot         real not null default 0,
  z           integer not null default 0,
  color       text,
  pin_color   text,
  title       text,
  body        text,
  image_path  text,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists pb_items_board_idx on public.pb_items(board_id);

create table if not exists public.pb_strings (
  id          uuid primary key,
  board_id    uuid not null references public.pb_boards(id) on delete cascade,
  from_item   uuid not null references public.pb_items(id) on delete cascade,
  to_item     uuid not null references public.pb_items(id) on delete cascade,
  color       text not null default '#c0262d',
  created_at  timestamptz not null default now()
);
create index if not exists pb_strings_board_idx on public.pb_strings(board_id);

alter table public.pb_boards  enable row level security;
alter table public.pb_items   enable row level security;
alter table public.pb_strings enable row level security;

-- ---------- RPCs ----------
create or replace function public.pb_create_board(p_title text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  insert into pb_boards(title) values (coalesce(nullif(left(trim(p_title),120),''),'Untitled board'))
  returning id into v;
  return v;
end $$;

create or replace function public.pb_get_board(p_board uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'board',   to_jsonb(b),
    'items',   coalesce((select jsonb_agg(to_jsonb(i) order by i.z) from pb_items i where i.board_id = b.id), '[]'::jsonb),
    'strings', coalesce((select jsonb_agg(to_jsonb(s)) from pb_strings s where s.board_id = b.id), '[]'::jsonb)
  )
  from pb_boards b where b.id = p_board;
$$;

create or replace function public.pb_rename_board(p_board uuid, p_title text)
returns void language sql security definer set search_path = public as $$
  update pb_boards set title = coalesce(nullif(left(trim(p_title),120),''),'Untitled board'), updated_at = now()
  where id = p_board;
$$;

create or replace function public.pb_upsert_item(p_board uuid, p_item jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from pb_boards where id = p_board) then
    raise exception 'board not found';
  end if;
  if (select count(*) from pb_items where board_id = p_board) >= 1000
     and not exists (select 1 from pb_items where id = (p_item->>'id')::uuid) then
    raise exception 'board is full (1000 items)';
  end if;
  insert into pb_items as t (id, board_id, kind, x, y, w, h, rot, z, color, pin_color, title, body, image_path, created_by)
  values ((p_item->>'id')::uuid, p_board, p_item->>'kind',
          coalesce((p_item->>'x')::real,0), coalesce((p_item->>'y')::real,0),
          coalesce((p_item->>'w')::real,200), coalesce((p_item->>'h')::real,200),
          coalesce((p_item->>'rot')::real,0), coalesce((p_item->>'z')::int,0),
          left(p_item->>'color',32), left(p_item->>'pin_color',32),
          left(p_item->>'title',300), left(p_item->>'body',5000),
          left(p_item->>'image_path',300), left(p_item->>'created_by',60))
  on conflict (id) do update set
    kind = excluded.kind, x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
    rot = excluded.rot, z = excluded.z, color = excluded.color, pin_color = excluded.pin_color,
    title = excluded.title, body = excluded.body, image_path = excluded.image_path,
    updated_at = now()
  where t.board_id = p_board;   -- can't hijack an item from another board
  update pb_boards set updated_at = now() where id = p_board;
end $$;

create or replace function public.pb_delete_item(p_board uuid, p_id uuid)
returns void language sql security definer set search_path = public as $$
  delete from pb_items where id = p_id and board_id = p_board;
$$;

create or replace function public.pb_add_string(p_board uuid, p_id uuid, p_from uuid, p_to uuid, p_color text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_from = p_to then raise exception 'cannot tie a string to itself'; end if;
  if (select count(*) from pb_items where board_id = p_board and id in (p_from, p_to)) <> 2 then
    raise exception 'items not on this board';
  end if;
  insert into pb_strings(id, board_id, from_item, to_item, color)
  values (p_id, p_board, p_from, p_to, coalesce(left(p_color,32),'#c0262d'))
  on conflict (id) do nothing;
end $$;

create or replace function public.pb_delete_string(p_board uuid, p_id uuid)
returns void language sql security definer set search_path = public as $$
  delete from pb_strings where id = p_id and board_id = p_board;
$$;

revoke all on function public.pb_create_board(text), public.pb_get_board(uuid), public.pb_rename_board(uuid,text),
  public.pb_upsert_item(uuid,jsonb), public.pb_delete_item(uuid,uuid),
  public.pb_add_string(uuid,uuid,uuid,uuid,text), public.pb_delete_string(uuid,uuid) from public;
grant execute on function public.pb_create_board(text), public.pb_get_board(uuid), public.pb_rename_board(uuid,text),
  public.pb_upsert_item(uuid,jsonb), public.pb_delete_item(uuid,uuid),
  public.pb_add_string(uuid,uuid,uuid,uuid,text), public.pb_delete_string(uuid,uuid) to anon, authenticated;

-- ---------- Storage: public-read photo bucket, anon may upload (no list/overwrite) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pb-photos', 'pb-photos', true, 8388608, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do nothing;

drop policy if exists "pb photos anon upload" on storage.objects;
create policy "pb photos anon upload" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'pb-photos');
