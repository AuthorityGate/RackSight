# RackSight editable logo

Use `racksight-logo-editable.svg` as the color-editable master. It preserves the exact silhouette and alpha edges of `racksight-icon.png`; it is not a redrawn approximation.

The SVG has a transparent background and two named color layers:

- `servers` uses `.server-color`
- `arch` uses `.arch-color`

To recolor the complete logo, edit only the two hex values near the top of the SVG:

```css
.server-color { fill: #9B2335; }
.arch-color { fill: #2C2C2C; stroke: #2C2C2C; }
```

There are no gradients, textures, shadows, or mixed maroon pixels. The SVG uses embedded alpha masks to preserve the supplied geometry exactly. Vector editors can select the `servers` or `arch` rectangle by name and change its single fill.

`racksight-logo-flat.png` is the same exact silhouette as a flattened transparent PNG. Every visible server pixel has one RGB value and every visible arch pixel has one RGB value, so color-range selection works reliably.

Regenerate both editable files after changing the export colors in `scripts/generate-editable-logo.js`:

```powershell
node scripts/generate-editable-logo.js
```
