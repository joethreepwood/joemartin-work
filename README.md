# joemartin.work

My personal site. Plain HTML/CSS, no build step, hosted free on GitHub Pages.

## Edit it

- **All content** lives in [`index.html`](index.html). Each project is one
  `<section class="entry">` block — copy one to add a new project, changing the
  image, heading, text, and the `.cta` link. Sections auto-alternate image
  left/right.
- **Styling** is in [`style.css`](style.css). The colours/spacing are variables
  in the `:root {}` block at the top; dark mode is handled automatically.
- **Images** go in [`images/`](images/). Reference them as `images/yourfile.jpg`.
- **Embeds** (YouTube, etc.): drop an `<iframe>` inside a section's
  `<div class="entry__media">` in place of the `<img>`.

## Preview locally

Just open `index.html` in a browser. (Or run `python3 -m http.server` in this
folder and visit http://localhost:8000.)

## Publish

Commit and push to `main`. GitHub Pages redeploys automatically within a minute.

- `CNAME` binds the site to the custom domain `joemartin.work`. Don't delete it.
- Pages settings: repo **Settings → Pages → Deploy from a branch → `main` / root**.
