-- Pinholes left in the cork when a pin is pulled out (note moved or removed).
-- Stored on the board as a capped jsonb array of [x, y]; pb_get_board returns it via to_jsonb(b).
alter table public.pb_boards add column if not exists holes jsonb not null default '[]'::jsonb;

create or replace function public.pb_add_hole(p_board uuid, p_x int, p_y int)
returns void language sql security definer set search_path = public as $$
  update pb_boards b set holes = (
    select coalesce(jsonb_agg(t.h order by t.n), '[]'::jsonb) from (
      select e.h, e.n
      from jsonb_array_elements(b.holes || jsonb_build_array(jsonb_build_array(
             greatest(-300, least(4300, p_x)), greatest(-300, least(2900, p_y))))) with ordinality as e(h, n)
      order by e.n desc limit 600
    ) t)
  where b.id = p_board;
$$;

revoke all on function public.pb_add_hole(uuid,int,int) from public;
grant execute on function public.pb_add_hole(uuid,int,int) to anon, authenticated;
