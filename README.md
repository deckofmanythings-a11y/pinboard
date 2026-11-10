# Pinboard

Shared corkboard: push pins, yarn, post-its, index cards, polaroid photos and "photo needed" placeholders, live for everyone who has the board link.

- Static site (`index.html`, `style.css`, `app.js`, vendored `sb-client.bundle.js` = supabase-js 2.110.7). Serve the folder with any static server.
- Backend: raided-hex Supabase project, `pb_*` tables + `pb-photos` bucket. Schema in `supabase/migrations/`.
- Access: the board uuid in `?b=` is the share secret. Tables have RLS with no policies; all reads/writes go through SECURITY DEFINER RPCs that take the uuid. Live moves, cursors and presence use Realtime broadcast on `pb:<uuid>`.
- Writes per item are serialized in the client (`enqueue`) so a slow insert can't land after a later update.
