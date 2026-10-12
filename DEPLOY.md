# Hosting EasyTesting for a team

EasyTesting starts real browsers, runs for minutes, and keeps its data (accounts, bugs, fingerprints, screenshots) in files. It needs a small **always-on server that can run a container**. It will not work on serverless platforms such as Vercel or Netlify Functions: there is no browser, runs are cut off after a short time, and the disk is wiped between requests. (Vercel is fine for hosting the *app you want to test*.)

## Quick start with Docker

```sh
docker compose up -d --build
```

Open http://localhost:8080 and create the first account. That person becomes the admin and adds everyone else under **Team**.

The data lives in the `heal-data` volume (`/data` in the container). Back it up by copying that volume.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on. Hosts such as Railway and Render set this for you. |
| `HEAL_HTTPS` | `0` | Set to `1` when the app is reached over HTTPS, so the sign-in cookie is marked Secure. |
| `HEAL_MAX_RUNS` | `3` | How many test runs execute at once. Others wait as "queued". Each run starts a browser, so size this to the machine (about 1 GB of memory per run is a safe guess). |
| `HEAL_SIGNUP` | off | `on` lets anyone create their own tester account from the sign-in screen (the landing page's **Get started** button opens it). Off means only an admin can add people. New accounts are always testers, and one address can create at most 5 an hour. Turn it on only when you are happy for strangers to start browser runs on your server, and keep `HEAL_MAX_RUNS` small. |
| `HEAL_CODE_UPLOADS` | `off` in the container | `on` lets people upload Playwright/Selenium projects. That runs *their code on this machine*. Leave it off on any shared server. |
| `ANTHROPIC_API_KEY` | none | Enables "Improve with AI" for writing test cases. The use-case text is sent to Anthropic. Never put the key in the repo; set it in the host's secret settings. |
| `HEAL_AI_MODEL` | `claude-opus-5-5` | Which Claude model to use for that option. |

## Where to run it

Any host that runs a container and gives it a persistent disk:

- **Railway / Render**: connect the GitHub repo, choose the Dockerfile, add a persistent volume mounted at `/data`, set `HEAL_HTTPS=1`. They provide HTTPS.
- **Fly.io**: `fly launch`, add a volume at `/data`, set `HEAL_HTTPS=1`.
- **A VM (Azure, AWS, Google Cloud) or an internal server**: install Docker, run `docker compose up -d`, and put an HTTPS reverse proxy (Caddy, nginx, or the cloud load balancer) in front.

## Before real users arrive

- **HTTPS is required** outside localhost: sign-in passwords travel over it.
- **Test code uploads stay off** unless every user is trusted. The plain-English modes (use cases and test cases) are much safer: they run only our own executor.
- The apps being tested must be reachable *from the server*. A staging site on a private network is only reachable if the server is on that network too.
- Run limits are per server, not per user. One person can use every slot.
- This image has not been built or run in the environment where it was written (no Docker there). Treat the first build as a trial: check `docker compose logs` and `/healthz`.

## Without Docker

```sh
npm ci && npm run build
npx playwright-core install --with-deps chromium
HEAL_CODE_UPLOADS=off node dist/cli.js serve --host 0.0.0.0 --port 8080 --data /var/lib/easytesting
```
