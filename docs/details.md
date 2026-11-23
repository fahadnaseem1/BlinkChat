# BlinkChat Interview Details

## 1. Project in one minute

BlinkChat is a private group chat application built with Java 21 and Spring Boot 4.2. A guest chooses a display name, receives an HttpOnly browser credential, creates or joins a room through an invitation, and exchanges plaintext messages over REST and STOMP WebSocket traffic. Messages stay available until the room ends.

The project uses a monolithic architecture, a vanilla JavaScript frontend, and file-based H2. It is intentionally a single-instance deployment because H2 is durable and the Spring simple broker and live presence maps are process-local.

## 2. Technology stack

| Area | Technology | How it is used |
|---|---|---|
| Backend language | Java 21 | Records, streams, modern text and collection APIs |
| Backend framework | Spring Boot 4.2 | Application startup, dependency injection, MVC, JPA, Security, scheduling |
| Build | Gradle Wrapper 9.9.2 | Dependency resolution, test execution, executable JAR build |
| HTTP | Spring MVC REST | Guest, room, invitation, snapshot, health, and close operations |
| Realtime | STOMP 1.2 over native WebSocket | Send, receipt, typing, presence, and lifecycle events |
| Broker | Spring simple broker | In-process `/queue` private destinations and heartbeats |
| Database | File-based H2 | Durable records for local use and hosted persistent storage |
| ORM | Jakarta Persistence | Entities, transactions, locking, JPQL, and EntityManager |
| Security | Spring Security | Cookie guest authentication, route authorization, CSRF, headers |
| Frontend | HTML, CSS, JavaScript modules | Responsive UI and client-side state |
| STOMP browser library | stompjs 7.2.1 | Native WebSocket STOMP framing and exponential reconnect |
| Backend tests | JUnit 5, AssertJ, Spring test, MockMvc | Integration flows, concurrency, expiry, security, and receipts |
| Browser tests | Playwright 1.58.2 | Independent browser-context and mobile UI flows |
| Deployment | Docker, Compose, Render | Container packaging, local volume, hosted disk, HTTPS |

## 3. End-to-end request flow

1. The browser loads static files from Spring Boot and calls `GET /api/csrf`.
2. It establishes a guest through `POST /api/guests`, or resumes an existing valid HttpOnly cookie.
3. The security filter resolves the opaque cookie and installs a `GuestPrincipal`.
4. The browser creates or joins a room through REST.
5. It opens `/ws`, negotiates STOMP, and subscribes only to private event and error queues.
6. Send, receipt, and typing commands go through `/app/chat.*`.
7. `ChatService` validates authorization and room state, updates records in a transaction, and publishes events.
8. The broker delivers private events while REST snapshots repair state missed during disconnect.

## 4. Key domain concepts

### Guest identity

A display name is only a label. The server creates a cryptographically random 256-bit secret and stores the SHA-256 digest of it in H2. The raw secret is sent in an HttpOnly, configurable-Secure, SameSite cookie.

Guest, credential, and room access use an opaque guest ID and credential digest rather than the display name. This prevents another guest with the same name from accessing a room.

### Invitations

An invitation secret is separate from the room ID. Its digest is stored in H2, and the raw secret belongs in the URL fragment so normal HTTP requests do not receive it.

Invitation redemption locks the room and invitation, allowing at most one guest to claim the final group slot. Existing membership retries are idempotent. Regeneration revokes older unused invitations.

### Messages and receipts

Each message has a unique operation ID for retry deduplication and a sequence number for pagination. Its body remains available until the room ends, subject to the 200-message room limit.

The frozen recipient audience is snapshotted when the message is accepted. Later group members cannot read or acknowledge earlier messages. A sender counts as having authored the message but does not send a recipient receipt.

### Delivery meaning

- **Accepted:** the server committed the operation and assigned the authoritative state.
- **Delivered:** at least the relevant recipient acknowledgement reached the server.
- **Seen:** the message was visible to the recipient for the UI threshold.
- **Removed:** the message body was erased when the room ended.

The system does not promise exactly-once socket delivery. Events trigger repair, and HTTP snapshots reconcile missed changes.

### Room-end retention

Messages are retained until the creator closes the room or its 24-hour lifetime ends. Closing or expiring a room removes its message bodies; lifecycle metadata is purged after the bounded recovery window.

## 5. Architecture and component responsibilities

| Component | Responsibility |
|---|---|
| `ApiController` | Guest session, room, invitation, snapshot, health, and close HTTP APIs |
| `ChatController` | STOMP send, delivered, seen, and typing commands |
| `GuestIdentityService` | Secret creation, digest lookup, identity expiry, validation, and revocation |
| `ChatService` | Membership, invites, send deduplication, receipts, room-end retention, snapshots, and cleanup |
| `ChatRepository` | JPA entity access, pessimistic room locking, and JPQL queries |
| `Records` | JPA models for guests, credentials, rooms, memberships, invitations, messages, and recipients |
| `Connections` | Live WebSocket session tracking, presence, typing leases, limits, and revocation |
| `ChatEventPublisher` | After-commit durable events and transient presence or typing events |
| `SecurityConfig` | Cookie resolution, CSRF, route authorization, and security headers |
| `WebSocketConfig` | STOMP endpoint, broker, transport, inbound, and outbound authorization |
| `Policy` | Configurable limits and lifetime values |
| `CleanupJob` | Scheduled room cleanup and identity cleanup |
| `Errors` | Safe domain and generic HTTP error mapping |

## 6. Security walkthrough

- Mutating REST calls require CSRF.
- The STOMP CONNECT frame and STOMP mutating commands require CSRF protection.
- Static assets and health, CSRF, guest establishment, and invitation preview are public.
- All other HTTP operations require an authenticated guest principal.
- Sender identity comes from authentication rather than a client-supplied user field.
- The inbound STOMP channel restricts destinations and subscriptions.
- Outbound delivery validates the credential and room membership before a body is sent.
- Room IDs and invitation secrets are not sufficient as a substitute for guest authorization.
- Error responses hide internals and stack traces.
- The cookie is HttpOnly and SameSite=Strict; hosted mode also marks it Secure.
- H2 stores credential and invitation digests rather than reusable raw secrets.
- CSP, referrer policy, and cache-control headers reduce script and response exposure.

## 7. Concurrency and reliability

The application uses pessimistic room locking and database transactions for operations that must be serialized, such as invitation redemption and room changes.

The unique constraints on room and operation, room and sequence, and message recipient pairs support safe retries and prevent duplicate logical state. Operation lookup lets the client recover an uncertain send after a timeout.

Because socket delivery can fail or arrive out of order, the browser:

- Keeps pending sends and drafts in page memory.
- Stores revisions and stable message sequence cursors.
- Queries operation status after uncertain network results.
- Reconciles snapshots on reconnect, focus restoration, and a periodic foreground check.
- Rejects a snapshot when the room revision has changed and resynchronizes.

`@TransactionalEventListener(AFTER_COMMIT)` publishes durable changes only after the database commit, reducing false notification of rolled-back state.

## 8. Frontend behavior

The frontend is split into:

- `app.js`: conversation state, UI rendering, drafts, pending sends, reconnection, and recovery
- `api.js`: CSRF initialization and JSON fetch calls
- `socket.js`: STOMP client setup and private subscriptions
- `visibility.js`: visible-message detection and seen acknowledgements
- `styles.css`: responsive desktop and mobile layout

The client keeps drafts and uncertain sends only in page memory. It does not persist private message text in localStorage. Drafts remain usable for chat switching but disappear on refresh.

The browser tracks server time relative to its monotonic clock to clear room content when its room ends, even if the device clock changes.

## 9. Testing strategy

Backend integration tests cover:

- Identity isolation for matching display names
- Concurrent invitation claims and send retries
- Room membership and invitation lifecycle
- Credential revocation and expiry
- Message retention until room end
- Frozen recipient audiences in groups
- Unicode code-point validation
- Revision mismatch and pagination resync
- HTTP authentication and CSRF
- Credential recovery and operation metadata after room end

Optional browser checks verify entry, room navigation, group chat, UI behavior, invitation copy, offline recovery, drafts, receipts, and mobile rendering.

## 10. Deployment architecture

The Docker image runs Java 21 as a non-root user. Render supplies HTTPS, the public URL, the database secret, and a persistent 1 GB disk. The hosted profile enables secure cookies, framework forward headers, proxy-aware origins, and a five-minute Hikari pool ceiling.

The application listens on `0.0.0.0:$PORT`. `BLINK_DATA_DIR` stores H2 data on the mounted disk, and `BLINK_DB_PASSWORD` protects the database.

Only one service instance is supported. Scaling horizontally would require externalizing the H2 database and STOMP broker, as well as making process-local presence and typing state durable or shared.

## 11. Interview questions and strong answers

### Why did you use H2 instead of PostgreSQL?

The first release prioritizes a simple deployment and a private temporary workload. H2 provides transactions, locking, JPA compatibility, and restart durability with minimal infrastructure. A persistent disk makes it suitable for the current single-instance product. PostgreSQL would be the next step if horizontal scaling, independent database operations, or higher concurrency were required.

### How does it prevent name-based impersonation?

The display name is independent from `GuestPrincipal.guestId`. A cookie credential resolves to an opaque guest, and every room operation verifies that guest ID against membership records.

### How do you avoid duplicate messages after a client timeout?

The client generates an operation ID. The server stores a room, sender, and operation uniqueness constraint and returns the original accepted message state on retry.

### How do concurrent invitation claims work?

The redemption flow locks the room and invitation in the transaction, checks room capacity and invitation validity, and creates a membership. Only the transaction that wins the lock can allocate the final slot.

### Why publish after commit?

An after-commit event listener avoids notifying a participant about state that was rolled back. It still does not guarantee socket delivery, so snapshots remain the recovery authority.

### How long are messages retained?

Messages remain available until the creator ends the room or the room reaches its 24-hour limit. A room can retain up to 200 messages. Closing or expiring a room removes its bodies; operation lookup may retain content-free metadata for the recovery window.

### Why not direct peer-to-peer WebRTC?

BlinkChat requires centralized authorization, retention rules, receipts, invitation control, offline recovery, and server-visible lifecycle deadlines. A relay or WebRTC architecture could help media delivery but would not replace the server's authority for room state and ephemeral records.

### What are the current scalability limits?

The application is limited to one instance because the simple STOMP broker and live session maps are process-local, and H2 file storage does not support safe horizontal scaling. Scaling it would require a shared database and external message broker, plus shared or distributed presence and typing state.

### What would you change next?

The highest-value changes are PostgreSQL or another shared database, Redis or a broker for distributed sessions and ephemeral state, structured metrics and tracing, delivery queues or retry infrastructure, automated load tests, and stronger secrets management. Do not describe end-to-end encryption or permanent identity as present features; they are explicitly outside this release.

## 12. Important privacy and interview caveats

BlinkChat provides logical temporary availability and server-side authorization, not proof of real-world identity or end-to-end encryption. The server processes plaintext. Screenshots and copied text remain outside application control. Provider snapshots and database pages may outlive visible deletion. The project should not be described as forensic deletion or a secure secret-sharing platform.
