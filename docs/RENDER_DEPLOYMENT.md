# Deploy BlinkChat from GitHub to Render

The repository includes a Java 21 Docker image, a Render Blueprint, local Compose configuration, and GitHub deployment checks. No Render API key, Docker registry account, or GitHub secret is needed for this workflow. Render builds the image directly from GitHub.

## 1. Push the application and deployment files

The configured remote is `https://github.com/fahadnaseem1/QuickChat.git`, on branch `main`. Confirm this is the repository you intend to use. Most application files are currently new/untracked: push the full application, not only `render.yaml`.

```sh
git status --short
git add src scripts docker .github/workflows/ci.yml gradle gradlew gradlew.bat build.gradle settings.gradle package.json Dockerfile .dockerignore .gitignore .editorconfig .env.example compose.yaml render.yaml README.md docs/RENDER_DEPLOYMENT.md
git diff --cached --stat
git commit -m "Prepare BlinkChat Docker deployment on Render"
git push origin main
```

The staged diff may include other changes already staged in this checkout. Review it before committing. Private `.env` files and the local `data/` directory are ignored. Never add local databases or credentials to Git.

In GitHub's **Actions** tab, let **Build and verify deployment** finish. It runs the backend tests, builds the Linux container, and checks hosted cookies, CSRF, non-root Java, mounted H2 storage, and guest/room recovery after restarting the container.

## 2. Create the Render Blueprint

After the files exist on GitHub, open:

[Deploy this repository on Render](https://dashboard.render.com/blueprint/new?repo=https://github.com/fahadnaseem1/QuickChat)

Alternatively select **New → Blueprint** in Render and connect that repository. Use branch `main` and the root `render.yaml`. Complete GitHub authorization if prompted, review the resources and billing, then apply the Blueprint.

The Blueprint configures:

| Setting | Value |
| --- | --- |
| Service | Docker web service, `blinkchat` |
| Region | Singapore; change before creating the service if another region is preferable |
| Compute plan | `0.5c-512mb`, the smallest paid web plan supporting a disk |
| Instances | Exactly one |
| Persistent disk | 1 GB at `/data` |
| H2 directory | `/data/blinkchat` |
| Health check | `/api/health` |
| Deploy trigger | After GitHub checks pass on `main` |

**This is a paid deployment.** Render's free web services cannot attach the persistent disk required by this H2 setup. Review current costs in the Dashboard before applying. A disk-backed service has a brief interruption during deployments; the browser reconnects and resynchronizes afterward.

Do not add a build command or start command: the Dockerfile supplies both. Render sets `PORT`; the app listens on `0.0.0.0:$PORT`. The Dockerfile's `EXPOSE 8080` is a local default and does not override Render's assigned port.

## 3. Environment configuration

| Variable | Source and purpose |
| --- | --- |
| `SPRING_PROFILES_ACTIVE` | Blueprint sets `hosted` for secure cookies and trusted proxy headers. |
| `BLINK_DATA_DIR` | Blueprint sets `/data/blinkchat`, inside the persistent disk. |
| `BLINK_DB_PASSWORD` | Render generates a secret at first Blueprint creation; retain the same value for that database. |
| `RENDER_EXTERNAL_URL` | Automatically injected by Render; supplies the default HTTPS WebSocket origin. |
| `BLINK_ORIGIN` | Optional override only for a custom domain, e.g. `https://chat.example.com`, with no trailing slash. |
| `PORT` | Automatically supplied by Render; leave unset in the Blueprint. |
| `JAVA_TOOL_OPTIONS` | Image defaults reserve half the memory for the heap and leave room for JVM/native memory. Override only after measuring usage. |

The hosted profile requires a database password and either `BLINK_ORIGIN` or `RENDER_EXTERNAL_URL`. Missing values fail startup rather than silently using local defaults. Do not upload `.env.example` to Render: it is intentionally a **local HTTP** configuration.

When adding a custom domain, set `BLINK_ORIGIN` to the exact HTTPS origin everyone will use, then save and deploy. Use that same origin for invitations and browser access; the app deliberately permits one browser origin.

**Do not replace `BLINK_DB_PASSWORD` after the H2 file exists without changing the database user's password as well.** Changing only the environment value prevents the app from opening the existing database. `generateValue` preserves an existing value on future Blueprint syncs. Losing or deleting the disk removes the durable guest and room data.

## 4. Verify the live deployment

Open the URL shown by Render and visit `/api/health`; it should return `{"status":"ok"}`. Then use two independent browser profiles/devices to create a chat, preview and join its invitation, exchange messages, view receipts, and confirm expiry.

In a disposable chat, perform a controlled Render restart and confirm the same guest cookie can still open the room. WebSocket connections and CSRF servlet sessions are transient; the browser refreshes state after reconnecting. Unread message bodies, guest credentials, and rooms persist on the disk until their normal expiry or cleanup.

Keep a single service instance. H2 file storage and the in-memory STOMP broker are not configured for horizontal scaling. Use an H2-native backup procedure for any backup you need; filesystem snapshots alone do not guarantee database-consistent recovery. Do not enable request-body or STOMP payload tracing.

## Local Docker check

With Docker installed:

```sh
cp .env.example .env
openssl rand -hex 32
# Paste the generated value into BLINK_DB_PASSWORD in .env.
docker compose up --build -d
docker compose ps
```

Open `http://localhost:8080`. Local Compose uses the `dev` profile so cookies work over HTTP. The named volume retains the database across `docker compose down` / `up`. Reuse the same password. `docker compose down --volumes` deletes the database, so use it only when intentionally resetting local data.

Spring Boot does not load `.env` by itself. Compose reads it for the values in `compose.yaml`; native `./gradlew bootRun` uses your shell environment instead.

## Troubleshooting

- **Build failure:** inspect GitHub Actions and Render build logs. No host-installed Java is required on Render; the build image supplies Java 21.
- **No port detected:** leave Docker Command empty and use the supplied image entrypoint; check that `PORT` is not overridden with an invalid value.
- **Socket cannot connect:** use the Render URL, or set `BLINK_ORIGIN` to the exact custom HTTPS origin. Remove stale local HTTP overrides.
- **Database authentication failure:** restore the secret used to create this H2 database; do not delete the disk to repair credentials.
- **Database permission failure:** use the image entrypoint, which initializes `/data/blinkchat` after the disk is mounted and starts Java as UID 10001. Do not override the runtime user unless the mounted directory has already been provisioned for it.
- **Data disappears after deployment:** confirm that the disk is attached at `/data` and `BLINK_DATA_DIR` points inside it.
- **Memory limit reached:** inspect resource metrics before changing the JVM settings or compute plan. Heap is only part of total JVM memory.

References: [Docker on Render](https://render.com/docs/docker), [Blueprint specification](https://render.com/docs/blueprint-spec), [environment variables](https://render.com/docs/environment-variables), [persistent disks](https://render.com/docs/disks), and [compute plans](https://render.com/docs/compute-plans).
