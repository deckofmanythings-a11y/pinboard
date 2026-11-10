-- Per-pin style: 'tall' (waisted push pin) or 'round' (map-pin dome). Null = tall.
alter table public.pb_items add column if not exists pin_style text check (pin_style in ('round','tall'));

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
  insert into pb_items as t (id, board_id, kind, x, y, w, h, rot, z, color, pin_color, pin_style, title, body, image_path, created_by)
  values ((p_item->>'id')::uuid, p_board, p_item->>'kind',
          coalesce((p_item->>'x')::real,0), coalesce((p_item->>'y')::real,0),
          coalesce((p_item->>'w')::real,200), coalesce((p_item->>'h')::real,200),
          coalesce((p_item->>'rot')::real,0), coalesce((p_item->>'z')::int,0),
          left(p_item->>'color',32), left(p_item->>'pin_color',32),
          case when p_item->>'pin_style' in ('round','tall') then p_item->>'pin_style' end,
          left(p_item->>'title',300), left(p_item->>'body',5000),
          left(p_item->>'image_path',300), left(p_item->>'created_by',60))
  on conflict (id) do update set
    kind = excluded.kind, x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
    rot = excluded.rot, z = excluded.z, color = excluded.color, pin_color = excluded.pin_color,
    pin_style = coalesce(excluded.pin_style, t.pin_style),   -- older clients don't send it
    title = excluded.title, body = excluded.body, image_path = excluded.image_path,
    updated_at = now()
  where t.board_id = p_board;   -- can't hijack an item from another board
  update pb_boards set updated_at = now() where id = p_board;
end $$;

