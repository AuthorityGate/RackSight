# RackSight editable logo

Use `racksight-logo-editable.svg` as the color-editable master.

The SVG has a transparent background and two named elements:

- `servers` uses `.server-color`
- `arch` uses `.arch-color`

To recolor the complete logo, edit only the two hex values near the top of the SVG:

```css
.server-color { fill: #9B2335; }
.arch-color { fill: #2C2C2C; stroke: #2C2C2C; }
```

There are no gradients, textures, shadows, or mixed maroon pixels. Vector editors can also select the `servers` path or `arch` group by name.
