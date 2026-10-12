# EasyTesting landing page

A single static page (HTML, CSS and a little JavaScript, no build step, no dependencies). It is separate from the EasyTesting app itself, which needs a server and a browser and cannot run on Vercel.

## Deploy to Vercel

1. Push this repository to GitHub (the `site/` folder must be in the branch you deploy).
2. In Vercel choose **Add New, Project**, and import the repository.
3. Set these, and leave everything else alone:
   - **Root Directory:** `site`
   - **Framework Preset:** Other
   - **Build Command:** leave empty (turn the override on and clear it if Vercel fills one in)
   - **Output Directory:** leave empty
4. Choose the **Production Branch** (the branch that holds `site/`, for example `web-app` until it is merged into `main`) and press **Deploy**.

Or from a terminal, after `npx vercel login`:

```sh
npx vercel --cwd site
npx vercel --cwd site --prod
```

`vercel.json` turns on clean URLs and adds basic security headers.

## Preview locally

From the repository root:

```sh
node scripts/serve-site.mjs
```

Then open http://127.0.0.1:4180. Use this instead of a bare `python -m http.server`: browsers need "range requests" to scrub through the demo video, which Vercel supports and the Python server does not. (Opening `index.html` by double-click also works.)

## The Get started and Sign in buttons

Both buttons appear in the header, the top of the page and the footer. Where they lead is set in `config.js`:

```js
window.EASY_CONFIG = { appUrl: 'https://app.yourcompany.com' };
```

- With `appUrl` set, **Get started** opens `<appUrl>/#/signup` (the Create account screen, which needs `HEAL_SIGNUP=on` on that server) and **Sign in** opens `<appUrl>/#/signin`.
- With it empty, **Sign in** opens `http://127.0.0.1:4173` (EasyTesting running on the visitor's own computer) and **Get started** scrolls to the install steps. That is right for a project page, but wrong for a public site: set `appUrl` before you publish.

The landing page is static, so the app itself must be hosted somewhere else that can run a browser (see `DEPLOY.md`).

## Things to update

- **Repository links.** The "Get started" section and footer point to `https://github.com/Sumit38/EasyTesting` (branch `main`). If you rename the repository, search `site/index.html` for `Sumit38/EasyTesting` and change it.
- **Custom domain.** Add it in the Vercel project's Domains settings.

## The demo video

`demo.webm` is a real recording of the app (create an account, write a use case, generate cases, review, run, report), with on-screen captions, and `demo-poster.jpg` is its cover image. To record it again after the app changes (from the repository root; needs Chrome or Edge, and `npx playwright-core install ffmpeg` once):

```sh
node --import tsx scripts/record-demo-video.mts
```

It takes about two minutes and replaces both files. The video is WebM, which current Chrome, Edge, Firefox and recent Safari play; the page offers a download link where it cannot.

## The interactive demo

The demo on the page replays a real run, recorded from EasyTesting running its own sample sign-in page: the cases it generated, how each step was read, a run on the healthy page, and a second run after the page changed. The recorded data lives in `demo-data.js`.

To record it again after changing the generator or the executor (run from the repository root):

```sh
node --import tsx scripts/build-site-demo.mts
```

It needs Chrome or Edge installed. Nothing in `demo-data.js` is typed by hand.
