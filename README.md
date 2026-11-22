# BlinkChat

A private, two-person temporary chat built with Java 21, Spring Boot 4.2.0, file-based H2, STOMP over native WebSocket, and vanilla browser modules. The browser client is bundled locally: @stomp/stompjs 7.2.1 (Apache-2.0). Gradle wrapper: 9.9.2. Spring Boot manages server dependency versions.

## Run locally

Install Java 21, then run:

```sh
./gradlew bootRun
```

Open http://localhost:8080. Choose a name, create a conversation, and share its invitation with a second browser profile or device. Use a private browser window to simulate a second person. Tabs in the same profile share one identity.

For LAN testing, set `BLINK_ORIGIN` to the exact URL both devices use, such as `http://192.168.1.10:8080`. Use that URL on both devices; WebSocket origins are deliberately restricted. Plain HTTP cookies are for local development only.

Messages remain until their selected unread TTL (1 minute, 5 minutes, 1 hour, or 24 hours). The first recipient view shortens availability to at most 10 more seconds. The sender's authorship counts as their view. Rooms and credentials expire after 24 hours. Invitations expire after 15 minutes and admit one additional identity. End chat clears content for both people.

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
```

## HTTP and socket contracts

`GET /api/csrf` returns the CSRF header name and token. Send this header on every mutation and the STOMP CONNECT frame. `POST /api/guests` takes `displayName` and sets an HttpOnly guest cookie. `GET /api/me`, `PATCH /api/me`, and `POST /api/logout` inspect, rename, and revoke that identity.

`GET/POST /api/rooms` lists/creates your rooms (creation takes `ttlSeconds`). `GET /api/rooms/{id}` returns an authorized snapshot, policy, participants, server time, revision, and up to 100 available messages. Page with `GET /api/rooms/{id}/messages?after={sequence}&revision={baseline}`; a changed revision returns `resynchronize`. `POST /api/rooms/{id}/invites` regenerates an invitation while waiting. `POST /api/invites/redeem` takes `secret`. `POST /api/rooms/{id}/close` ends the room. Health: `GET /api/health`.

Connect native WebSocket at `/ws`, STOMP 1.2, heartbeats every 10 seconds. Only subscribe to `/user/queue/events` and `/user/queue/errors`. Only send to `/app/chat.send`, `/app/chat.delivered`, `/app/chat.seen`, and `/app/chat.typing`. Send fields: `roomId`, `operationId`, `body`. Receipt fields: `roomId`, `messageId`. Typing fields: `roomId`, `typing`. Sender identity comes exclusively from authentication. Arbitrary subscriptions and direct broker sends are rejected.

Events carry `type`, `roomId`, `revision`, `serverTime`, and `data`. Durable types are `room.updated`, `message.accepted`, `message.delivered`, `message.seen`, `message.removed`, and `room.closed`. Transient types are `presence.changed` and `typing.changed`. Acceptance includes the operation ID. Errors contain a category, safe message, and correlation ID.

Durable changes use a room-row lock and publish after commit. Retries never recreate expired content. Snapshots replace the active message set; revision gaps, reconnects, focus restoration, and a 30-second foreground check trigger reconciliation. This provides durable acceptance and eventual repair, without promising exactly-once socket delivery.

## Hosted configuration

The Dockerfile builds an executable Java 21 service. Run a single instance with a persistent disk mounted at `/data`, and configure:

| Environment variable | Purpose |
| --- | --- |
| `SPRING_PROFILES_ACTIVE=hosted` | Secure cookies and forwarded HTTPS support |
| `BLINK_ORIGIN=https://your-domain` | Exact trusted browser origin; required for sockets |
| `BLINK_DATA_DIR=/data` | Private persistent H2 directory |
| `BLINK_DB_PASSWORD` | Optional H2 database password, supplied as a secret |
| `PORT` | Listening port, default 8080 |

Use HTTPS with WebSocket upgrade support. The hosted profile trusts forwarded headers: expose the application only through your trusted reverse proxy. A disposable host loses rooms and identities on redeployment; a file database alone does not guarantee durable hosting. Do not scale to multiple instances with embedded H2 and the in-memory broker.

Limits and timings bind under `blink.*` in Spring configuration (`room-lifetime`, `credential-lifetime`, `invite-lifetime`, `read-grace`, `metadata-retention`, `max-rooms`, `max-messages`, `max-sends`, `sends-per-minute`, `max-connections`, `cleanup-ms`). Defaults follow the build guide. Content cleanup runs every 5 seconds; content-free operation metadata remains until one hour after a room ends. Availability checks do not rely on cleanup timing.

## Privacy and release verification

Temporary means unavailable through the app after its deadline and logically deleted from active database content. It does not mean forensic erasure, screenshot prevention, verified real-world identity, or end-to-end encryption. The server processes plaintext. Provider snapshots and database pages can outlive logical deletion. Do not enable framework message tracing or request-body logs in hosting.

Local automated tests do not replace a physical phone check, public TLS/socket verification across two networks, a controlled hosted restart with the selected disk, or a measured load exercise. Those deployment acceptance gates remain for the selected host. Optional same-person device linking and all deferred features in the guide are outside this release.
