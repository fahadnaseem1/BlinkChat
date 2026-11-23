# BlinkChat

A private, temporary group chat built with Java 21, Spring Boot 4.2.0, file-based H2, STOMP over native WebSocket, and vanilla browser modules. The browser client is bundled locally: @stomp/stompjs 7.2.1 (Apache-2.0). Gradle wrapper: 9.9.2. Spring Boot manages server dependency versions.

## Run locally

Install Java 21, then run:

```sh
./gradlew bootRun
```

Open http://localhost:8080. Choose a name, create a conversation, and share its invitation with a second browser profile or device. Use a private browser window to simulate a second person. Tabs in the same profile share one identity.

For LAN testing, set `BLINK_ORIGIN` to the exact URL both devices use, such as `http://192.168.1.10:8080`. Use that URL on both devices; WebSocket origins are deliberately restricted. Plain HTTP cookies are for local development only.

Give a chat an optional name, such as “Weekend plans,” to distinguish it in your list. All participants see the same name and short chat code in chat details. Active chats and invitations waiting for a friend appear in separate groups, with the open chat highlighted. Switching chats keeps each invitation with its chat; refreshing returns to the selected chat. After a refresh, select **Create invitation** in a waiting chat to generate a fresh link.

Only one person creates the chat. Their friend opens that chat's invitation and selects **Join chat**; creating another chat does not join the first one. Use `npm run test:rooms` to verify multiple chats, invitation isolation, notifications, and refresh selection with two browser identities.

Messages remain until their selected unread TTL (1 minute, 5 minutes, 1 hour, or 24 hours). Once all original recipients have viewed a message, its availability shortens to at most 10 more seconds. Rooms and credentials expire after 24 hours. Invitations expire after 15 minutes and can admit multiple guests, up to the room limit. End chat clears content for everyone.

Bodies and drafts live only in page memory on the client. Refresh discards drafts. H2 retains active server data under `./data`; keep this directory private. Never place it inside static resources or commit it. Credentials and invitations are stored as SHA-256 digests of independent random 256-bit secrets.

## Verify

```sh
./gradlew test bootJar
java -jar build/libs/BlinkChat-0.0.1-SNAPSHOT.jar
```

Integration tests use an isolated in-memory database and controllable clock. They cover concurrent invitation claims, concurrent send retries, membership isolation, credential expiry/revocation, delivery versus viewing, non-extending deadlines, expired-body filtering before cleanup, physical deletion, closure, pagination revisions, Unicode limits, HTTP authentication, and CSRF.

The optional browser test requires Node and Playwright. It uses independent browser contexts and fictional content, checks a 360px viewport, and exercises the full conversation lifecycle. Start the application first:

```sh
npm install
npx playwright install chromium
npm run test:browser
npm run test:rooms
npm run test:group
npm run test:ui
npm run test:ux
```

The UI check covers mobile entry, invitation copy feedback, chat details, keyboard dismissal, loading states, offline recovery, and sender grouping.

The UX check covers invitation previews without joining, returning guest names, per-chat memory-only drafts, uncertain-send recovery, receipt details, room expiry warnings, and guest-session confirmation.

## HTTP and socket contracts

`GET /api/csrf` returns the CSRF header name and token. Send this header on every mutation and the STOMP CONNECT frame. `POST /api/guests` takes `displayName` and sets an HttpOnly guest cookie. `GET /api/me`, `PATCH /api/me`, and `POST /api/logout` inspect, rename, and revoke that identity.

`GET/POST /api/rooms` lists/creates your rooms (creation takes `ttlSeconds` and an optional `title` of up to 40 characters). `GET /api/rooms/{id}` returns an authorized snapshot, policy, participants, server time, revision, and up to 100 available messages. Page with `GET /api/rooms/{id}/messages?after={sequence}&revision={baseline}`; a changed revision returns `resynchronize`. `POST /api/rooms/{id}/invites` regenerates an invitation while waiting. `POST /api/invites/preview` takes `secret` and returns only chat metadata without creating an identity or membership; it requires CSRF even before guest entry. `POST /api/invites/redeem` takes `secret`. `GET /api/rooms/{id}/operations/{operationId}` checks whether the authenticated guest’s send was accepted; expired accepted sends return metadata without a body. `POST /api/rooms/{id}/close` ends the room. Health: `GET /api/health`.

Connect native WebSocket at `/ws`, STOMP 1.2, heartbeats every 10 seconds. Only subscribe to `/user/queue/events` and `/user/queue/errors`. Only send to `/app/chat.send`, `/app/chat.delivered`, `/app/chat.seen`, and `/app/chat.typing`. Send fields: `roomId`, `operationId`, `body`. Receipt fields: `roomId`, `messageId`. Typing fields: `roomId`, `typing`. Sender identity comes exclusively from authentication. Arbitrary subscriptions and direct broker sends are rejected.

Events carry `type`, `roomId`, `revision`, `serverTime`, and `data`. Durable types are `room.updated`, `message.accepted`, `message.delivered`, `message.seen`, `message.removed`, and `room.closed`. Transient types are `presence.changed` and `typing.changed`. Acceptance includes the operation ID. Errors contain a category, safe message, and correlation ID.

Durable changes use a room-row lock and publish after commit. Retries never recreate expired content. Snapshots replace the active message set; revision gaps, reconnects, focus restoration, and a 30-second foreground check trigger reconciliation. This provides durable acceptance and eventual repair, without promising exactly-once socket delivery.

## Deploy to Render through GitHub

Use the included `render.yaml` Blueprint to deploy the Java 21 Docker image with a persistent H2 disk and secure hosted configuration. The Blueprint generates the database secret, uses Render's assigned URL for the WebSocket origin, and deploys after GitHub checks pass.

Follow the complete [Render deployment guide](docs/RENDER_DEPLOYMENT.md) for GitHub push commands, required environment variables, custom domains, local Docker Compose, and verification. This setup uses one paid web instance with a 1 GB disk; do not scale it horizontally.

For local containers, copy `.env.example` to `.env`, set a generated database password, and run `docker compose up --build -d`. Open `http://localhost:8080`. Native `./gradlew bootRun` remains available without Docker.

Limits and timings bind under `blink.*` in Spring configuration (`room-lifetime`, `credential-lifetime`, `invite-lifetime`, `read-grace`, `metadata-retention`, `max-rooms`, `max-messages`, `max-sends`, `sends-per-minute`, `max-connections`, `cleanup-ms`). Defaults follow the build guide. Content cleanup runs every 5 seconds; content-free operation metadata remains until one hour after a room ends. Availability checks do not rely on cleanup timing.

## Privacy and release verification

Temporary means unavailable through the app after its deadline and logically deleted from active database content. It does not mean forensic erasure, screenshot prevention, verified real-world identity, or end-to-end encryption. The server processes plaintext. Provider snapshots and database pages can outlive logical deletion. Do not enable framework message tracing or request-body logs in hosting.

Local automated tests do not replace a physical phone check, public TLS/socket verification across two networks, a controlled hosted restart with the selected disk, or a measured load exercise. Those deployment acceptance gates remain for the selected host. Optional same-person device linking and all deferred features in the guide are outside this release.
