# Playable Collections — brand

> *Press play on a collection.*

Store assets for this app's Civitai App listing. **These files are the source of truth for
this app's identity** — the listing images are exported from them, not the other way round.

## Identity

**Voice.** Late-night radio DJ — warm, effortless, hands-free. The only one of the set you use lying down.

**Motif.** **The ribbon and the triangle.** Fanned media cards with a play triangle cut clean through the front one, and gold tip-sparks lifting away.

## Palette

| Role | Hex | |
|---|---|---|
| Plate / dominant | `#FF4D6D` | the icon background, edge to edge |
| Secondary | `#FFA8B8` | the mark itself |
| Accent | `#FFC94D` | the tip — used sparingly, one element only |
| Cover ground | `#2E1024` | |

## Files

| File | Purpose |
|---|---|
| `icon.svg` | listing icon, 1024×1024 |
| `cover.svg` | listing cover, 1600×900 |

Export with `rsvg-convert`:

```bash
rsvg-convert -w 1024 -h 1024 brand/icon.svg  -o /tmp/icon.png
rsvg-convert -w 1600 -h 900  brand/cover.svg -o /tmp/cover.png
```

🔴 **Flatten the icon's corners onto the plate colour before uploading** — do not upload it
with transparency:

```bash
magick /tmp/icon.png -background '#FF4D6D' -alpha remove -alpha off /tmp/icon-upload.png
```

The listing pipeline transcodes every asset to JPEG, which has no alpha channel, and the
transparency is flattened to **black**. The store then clips the icon with a CSS avatar mask
that is slightly *less* rounded than the plate, so a thin dark rim survives along the curve.
Filling the corners with the plate colour removes the whole class — there is no transparency
left to flatten.

Attach with:

```bash
civitai app listing set-icon  /tmp/icon-upload.png
civitai app listing set-cover /tmp/cover.png
```

On a live listing this opens a revision for moderator re-review; the current assets stay
visible until it is approved. Setting the icon and cover in the same session puts both on one
revision, so they are reviewed together.

## Shared construction grammar

This app is one of five first-party apps drawn to a common grammar, so a row of them reads as
a suite while each stays individually memorable. Keep to it when changing anything here:

- Flat vector. Solid fills only — no gradients, shading, bevel, glow or 3D.
- Geometric primitives only: squares, triangles, circles, arcs, rings.
- Thick, uniform stroke weight. This is the strongest family signal at thumbnail size.
- Three colours maximum: one dominant, one accent, one neutral.
- The plate fills the whole canvas **edge to edge**; the margin lives *inside* it, around the
  mark. Never ask for margin *around* the plate — that bakes in a surround the store cannot
  crop past the rounded corners.
- **No lettering anywhere** — and that includes motifs whose skeleton *constructs* a letter or
  digit. Before locking a shape, ask what character it resembles.
- Never name a direction with a noun that already implies one. Say the geometry.

## App-specific note

The play triangle points **right** — flat edge left, apex right. State it explicitly in any regeneration; it has come back pointing down when left implied. Cards carry a plate-coloured stroke so overlapping same-fill shapes keep a visible edge; without it the fan renders as one blob.

## If you regenerate these

These were drawn as vector rather than generated, after three measured rounds established that
the constraints above and diffusion are structurally mismatched: across 42 generated images,
flat solid fills held 0/20, exact palette 1/10, and the alpha channel 0/20. Generation is
useful for *finding* a composition and poor at *meeting* a spec. If you use it, treat the
output as a sketch and redraw the winner in vector — and judge a candidate by what a stranger
would say it depicts, not by whether it matches the prompt.
