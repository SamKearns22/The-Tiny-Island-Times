# Database migration — image captions & listicles

This update adds image subheadings (captions) to articles and a new listicle
article type. Both need a few new columns on your existing `posts` table.

Run this **once** in the Supabase SQL editor (Project → SQL Editor → New query).
It is safe to run even if you're not sure whether you've run it before — each
line does nothing if the column already exists:

```sql
alter table posts add column if not exists header_caption text;
alter table posts add column if not exists mid_caption text;
alter table posts add column if not exists layout text default 'standard';
alter table posts add column if not exists listicle_items jsonb default '[]'::jsonb;
```

That's it. Your existing stories are unaffected — they'll simply have empty
captions and a `layout` of `'standard'`, exactly as before.

## What's new after migrating

- **Image subheadings**: every image field on the publish and edit forms now
  has an optional "Image subheading" box. Whatever you type shows in italics
  directly under that image on the published article.
- **Listicles**: a new "Listicle" tab on the `/admin` page. It lets you build a
  numbered article — each item has a heading, body text, and an optional image
  (with its own optional subheading). Add as many items as you like with the
  "+ Add another item" button; remove any with its "Remove" button. Published
  listicles are auto-numbered (1, 2, 3…) on the page.
- **Editing listicles**: the "Edit" button next to a listicle in the Published
  stories list opens it back in the listicle form with everything pre-filled.
  You can change any text, reorder by removing and re-adding, add new items, and
  for each existing image either keep it (leave the file box blank), replace it
  (choose a new file), or tick "Remove current image" to drop it. The same
  applies to the header image. The story's web address and original publish date
  stay the same after an edit, so shared links keep working.
