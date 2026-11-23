# BlinkChat — Detailed Build Guide

## 1. Purpose of this document

Build a polished, responsive, ephemeral chat application with Java 21, Spring Boot, WebSocket with STOMP, file-based H2, and HTML, CSS, and vanilla JavaScript.

This document is a product specification, architecture guide, and implementation roadmap. It deliberately contains no application code, pseudocode, configuration snippets, database statements, or terminal commands. Names of files, data fields, endpoints, and events describe contracts to implement later.

The intended result is a working project that two people can open on different devices, use without registering accounts, and understand without technical instructions.

The recommended first release uses invite-based private rooms. A display name identifies someone visually; a private browser credential establishes their identity. Typing another person's name never gives access to their rooms.

All numerical limits and timings below are proposed product defaults. Keep them configurable and change them only through an explicit product decision.

## 2. Product vision and boundaries

BlinkChat is for private conversations without permanent history. One person creates a room, shares an invitation privately, and others join. Messages remain available until the room ends, at most 24 hours after creation.

The experience should feel quiet, fast, and intentional: a clear invitation flow, comfortable message bubbles, and helpful connection states.

### First-release scope

| Capability | Required behavior |
| --- | --- |
| Guest access | Choose a display name and receive a private browser identity. |
| Private room | Exactly two participant identities may occupy a room. |
| Invitation | A short-lived, single-use link admits the second participant. |
| Live messaging | Both browsers exchange plain text through the server. |
| Temporary storage | H2 stores active messages and the minimum lifecycle metadata. |
| Message retention | Content remains available until room closure or room expiry. |
| Receipts | Sending, sent, delivered, seen, and failed have distinct meanings. |
| Presence | Show whether the other participant has a live authenticated connection. |
| Typing | Show a short-lived indicator only in the relevant room. |
| Recovery | Refresh and reconnect restore only currently available messages. |
| Device support | One person can use a laptop while the other uses a phone. Multiple tabs for one guest are supported. |
| Interface | Desktop sidebar and mobile full-screen conversation, with accessible controls. |

### Deferred features

Defer accounts, passwords, searchable usernames, contacts, group chat, attachments, voice and video, message editing, export, push notifications, end-to-end encryption, and permanent history.

Using the same participant identity on a second physical device is an optional follow-up feature described in Section 19. It is separate from the core requirement that two different people can chat across devices.

Do not add React, PostgreSQL, Redis, Kafka, or an external message broker to complete this first release.

## 3. Decisions to make before implementation

| Topic | Recommended decision | Reason |
| --- | --- | --- |
| Entry model | Guest identity plus private invitation | Avoids account management while preventing name-based impersonation. |
| Room size | Two participant identities, permanently allocated once joined | Makes privacy and receipt behavior predictable. |
| Message type | Plain text only | Keeps validation, rendering, and deletion manageable. |
| Routing | Authenticated personal event destination | Avoids exposing a shared public room subscription. |
| Frontend hosting | Spring Boot serves the static frontend | Keeps cookies, HTTP requests, and sockets on one origin. |
| Persistence | Embedded, file-based H2 | Preserves active data across local application restarts. |
| Server count | One application instance | Matches the embedded database and in-memory broker design. |
| Message retention | Until the room ends, at most 24 hours after creation | Keeps viewed and unread messages available throughout the chat. |
| Sender view | Accepted authorship counts as the sender having viewed their own text | Avoids waiting for every sender tab to open the message. |
| Offline behavior | Preserve an unsent draft only in current page memory | Avoids silently keeping private text in browser storage. |
| Security | Guest authentication and authorization from the beginning | Password signup can wait; private room protection cannot. |

Full account features can be added later through Spring Security. For this guide, use Spring Security early for guest request authentication, CSRF protection, and message authorization, without introducing a login form or passwords.

## 4. Default settings and product limits

| Setting | Initial value | Interpretation |
| --- | --- | --- |
| Room lifetime | Twenty-four hours | Absolute lifetime from creation; never extended by activity. |
| Invitation lifetime | Fifteen minutes | Also limited by the room's remaining lifetime. |
| Guest credential lifetime | Twenty-four hours | Absolute expiry; existing membership does not bypass it. |
| Cleanup interval | Five seconds | Operational target while the application is healthy. |
| Metadata retention | Until one hour after room closure or expiry | Content-free retry and deletion metadata only. |
| Message length | Two thousand Unicode code points | Reject oversized content; do not silently truncate. |
| Maximum socket frame payload | Sixteen KiB | Enforced separately from character count. |
| Display name | Two to thirty visible characters | Trim outer whitespace and reject control characters. |
| Message rate | Thirty accepted sends per minute per participant | Add a small burst allowance and a separate IP ceiling. |
| Live connections | Five per guest | Includes multiple browser tabs. |
| Active rooms | Five per guest | Includes waiting rooms. |
| Retained messages | Two hundred per room | Reject further sends with a clear capacity error. |
| Accepted sends per room lifetime | Two thousand | Additional abuse limit. |
| Snapshot page size | Up to one hundred active messages | Use stable sequence-based pagination. |
| Typing refresh | At most once every two seconds | Avoid an event for every keystroke. |
| Typing timeout | Four seconds | Clear the indicator without relying on a stop event. |
| Heartbeat target | Ten-second intervals | Negotiate with the STOMP client and server. |
| Stale connection threshold | Approximately thirty seconds | Allow tolerance for browser and network scheduling. |
| Foreground reconciliation | Every thirty seconds | Repair missed lifecycle events even without a disconnect. |

The room's 24-hour limit starts at creation and is not extended by activity. Messages are retained until then or until the creator ends the room sooner.

## 5. Core user journeys

### Journey A: Create a conversation

1. The visitor opens BlinkChat and sees a brief explanation that messages remain until the chat ends.
2. They choose a display name.
3. The server establishes a guest identity and private browser credential.
4. They select Create chat and create a room.
5. The waiting screen shows an invitation link, its expiry, and a Copy invite button.
6. They share the invitation through a channel of their choice.
7. The interface shows Waiting for someone to join until a second identity claims the invitation.
8. Once joined, both participants see each other's display names and the room's end time.

### Journey B: Join an invitation

1. The recipient opens the invitation.
2. The page shows a name field and a deliberate Join chat action.
3. Opening or previewing the link alone does not consume it.
4. The server validates the invitation and guest identity when Join chat is submitted.
5. A successful atomic claim creates the second membership and invalidates the invitation.
6. The client opens its authenticated event connection and reconciles room state.
7. The room becomes ready for both participants.

The invitation is a bearer capability: whoever claims it first can occupy the second slot. The creator must share it privately. A leaked invitation cannot establish the intended person's real-world identity.

### Journey C: Exchange messages

1. The sender types text and selects Send.
2. A pending bubble appears locally with Sending status.
3. The server validates the operation and commits the message.
4. The sender receives an acceptance event and sees Sent.
5. The recipient's browser receives the message and acknowledges receipt.
6. The sender sees Delivered.
7. When the message is visibly displayed in the active conversation, the recipient sends a seen acknowledgment.
8. Both participants receive the room-end time.
9. Both retain the message until the room ends.

### Journey D: Recipient is offline

The server accepts a valid message and retains it until the room ends. The sender sees Sent while no recipient device has acknowledged it. When the recipient reconnects before room end, the active snapshot supplies the message.

### Journey E: Leave or close

Closing a browser tab disconnects that device and does not close the room. Explicitly selecting End chat closes the room for both participants, invalidates invitations, makes all message content unavailable, and schedules physical cleanup.

Use a confirmation explaining that End chat affects both people. A room never reopens after closure, and a departed participant slot is never reassigned.

## 6. What happens between two devices

Each browser connects to the same Spring Boot service. The browsers do not connect directly to each other.

HTTP handles guest setup, room creation, invitation redemption, and authoritative snapshots. WebSocket carries ongoing bidirectional traffic. STOMP supplies destinations and message framing on that connection. H2 stores application state; it does not deliver messages to browsers.

Spring documents WebSocket as a transport whose application message format is defined separately, with STOMP providing that higher-level structure. See [Spring's STOMP documentation](https://docs.spring.io/spring-framework/reference/web/websocket/stomp.html).

| Component | Responsibility |
| --- | --- |
| Browser UI | Render screens, capture input, and show connection and message states. |
| Frontend state layer | Track messages, room-end time, revisions, drafts, and pending operations. |
| HTTP controllers | Receive setup and snapshot requests and return consistent responses. |
| STOMP controllers | Receive send, receipt, and typing commands. |
| Identity and authorization layer | Resolve the caller and verify permission for every operation. |
| Room service | Manage room creation, two-person membership, and closure. |
| Invitation service | Create, hash, redeem, expire, and revoke invitation secrets. |
| Message service | Validate and persist messages, receipts, and lifecycle transitions. |
| Event publisher | Deliver committed updates to the appropriate participant identities. |
| Presence service | Maintain live connection counts and typing leases in memory. |
| Cleanup service | Remove content when rooms end and later remove lifecycle metadata. |
| H2 repositories | Read and write durable application records. |

The built-in Spring simple broker keeps subscriptions in memory and supports STOMP heartbeats when configured with a scheduler. Use it for this single-instance project; H2 remains the recovery source after a disconnect. See [Spring's simple broker documentation](https://docs.spring.io/spring-framework/reference/web/websocket/stomp/handle-simple-broker.html).

## 7. Guest identity and browser credentials

### Display name versus identity

A display name is a label. Two guests may have the same label and remain different identities. Use an internal opaque identifier for memberships, routing, and receipts.

Create a cryptographically random guest bearer secret with at least 256 bits of entropy. Store only its cryptographic digest in H2. Send the raw credential to the browser in a Secure, HttpOnly, SameSite cookie for hosted HTTPS use.

An authenticated request resolves the cookie to a guest identity and produces the server-side principal used by HTTP and WebSocket handlers. The frontend never chooses its principal identifier.

This is a custom guest credential design, not a claim that default in-memory HTTP sessions automatically survive restarts. Resolve credentials from H2 after a restart so a valid browser can recover its guest identity. Use the same identity resolution for the socket handshake.

Spring WebSocket integrates with the principal established by HTTP authentication. Its security documentation also explains message authorization and CSRF handling for STOMP connections. Follow those mechanisms when implementing the guest flow. See [Spring WebSocket security](https://docs.spring.io/spring-security/reference/servlet/integrations/websocket.html).

### Required identity behavior

- A valid existing credential returns the same guest rather than creating duplicates.
- Changing a display name does not change memberships or grant access.
- A new browser without a credential creates a new identity.
- An expired credential cannot resume sending or receiving room events.
- Logout revokes that browser credential and closes sockets authenticated with it.
- Clearing cookies loses the guest's recovery capability unless optional device linking was completed.
- The server checks credential validity during inbound socket commands and before outbound private delivery, and closes sockets when a credential expires or is revoked.

Make guest establishment idempotent while an existing valid cookie is present. Apply rate limits to anonymous establishment to prevent uncontrolled identity creation.

## 8. Invitation and membership rules

Use a random invitation secret separate from the room identifier and guest credential. A public room identifier alone never authorizes access.

Store a digest of the invitation secret, its room, expiry, consumed time, and consuming guest. Do not store or log the raw secret.

Prefer putting the secret in the invitation URL fragment. The frontend reads it, removes it from the address bar after capture, and submits it in the protected Join request. Keep it only in page memory while joining. Fragments reduce accidental exposure through HTTP requests, but scripts running on the page could still read them; keep the invitation page free of analytics and third-party widgets.

### Atomic redemption

Invitation validity, room capacity, and membership creation must be checked in one database transaction. Lock the room and relevant invitation record in a consistent order. If two guests attempt to claim the final slot, only one succeeds.

| Situation | Result |
| --- | --- |
| Valid invite, empty second slot | Add the guest and consume the invite. |
| Existing member retries a successful join | Return their existing membership without allocating a slot. |
| Creator opens their own invitation | Show their waiting room; do not consume the invitation. |
| Different guest reuses consumed invitation | Reject without exposing conversation details. |
| Expired or revoked invitation | Explain that a new invitation is required. |
| Room closed or expired | Reject joining and show the room-unavailable screen. |
| Second participant already allocated | Reject an additional identity, even when someone is offline. |

The creator may regenerate an invitation only while waiting for the second participant. Regeneration immediately invalidates earlier unused invitations. After the second participant joins, no new participant invitation can be issued.

## 9. Data model and retention

Use separate records for identity, credentials, rooms, memberships, invitations, message content, and lifecycle metadata. These are conceptual entities; avoid returning persistence entities directly to the frontend.

### Guest

| Field | Purpose |
| --- | --- |
| Guest identifier | Stable internal identity. |
| Display name | Human-readable label. |
| Created time | Retention and troubleshooting. |
| Expiry time | Upper bound for guest access. |

### Guest credential

| Field | Purpose |
| --- | --- |
| Credential identifier and guest reference | Associate an authenticated browser with its guest. |
| Secret digest | Verify the private cookie without storing the secret. |
| Created, expiry, and revoked times | Control access lifetime. |
| Device label | Optional friendly label for later linked-device management. |

### Room

| Field | Purpose |
| --- | --- |
| Room identifier and creator reference | Identify the room and invitation owner. |
| State | Waiting, active, closed, or expired. |
| Created, expiry, and closed times | Define absolute availability. |
| Retained message limit | Bound the number of messages stored for a room. |
| Next message sequence | Allocate a stable ordering position. |
| Durable revision | Order durable room mutations and reconcile clients. |
| Accepted-send count | Enforce the lifetime metadata bound. |

### Membership

Store room, guest, participant slot, joined time, and optional role. Enforce uniqueness for each room-and-guest pair and each room-and-slot pair. Membership is historical until room metadata is purged; disconnecting never deletes it.

### Invitation

Store invitation identifier, secret digest, room, creator, expiry, revoked time, consumed time, and consuming guest. The digest must be unique. Purge unused expired secrets promptly; retain consumed-join metadata only for the bounded room recovery window.

### Message lifecycle record

| Field | Purpose |
| --- | --- |
| Server message identifier | Stable canonical identity across devices. |
| Room and sender references | Establish ownership and recipient membership. |
| Client operation identifier | Recognize retries of the same send. |
| Room sequence | Order messages independently of arrival timing. |
| Accepted time | Order messages and audit delivery. |
| Room-end time | The room's expiry, shared by every message. |
| First delivered time | First recipient application acknowledgment. |
| First seen time | First accepted recipient view acknowledgment. |
| Removal time and reason | Record room closure or room expiry without retaining text. |
| Last durable revision | Help merge status updates. |

Keep one row per accepted send as the bounded idempotency record until the room metadata is purged. Enforce uniqueness on room, sender, and client operation identifier. Do not retain a message-body hash after deletion solely to compare retries; return the first accepted result for that operation identifier.

### Message content

Store only a message reference and its plain-text body. Delete this content row when the room ends. Keeping content separate from bounded metadata makes the privacy boundary explicit.

### Indexes and integrity rules

- Index credential and invitation digests for lookup.
- Index memberships by guest and room.
- Make room-and-message-sequence unique.
- Index available messages by room and sequence, and cleanup candidates by room end.
- Enforce one content row per message.
- Prevent orphaned content and memberships through foreign keys and deliberate purge ordering.
- Use database constraints alongside service checks; concurrent requests can pass the same preliminary validation.

H2 supports embedded disk-based and in-memory databases, transactions, and row-level locking. Its documentation notes that an embedded database is opened within the application's JVM. Keep one owning application instance in this design. See [H2 features and connection modes](https://h2database.com/html/features.html).

## 10. Message lifecycle: exact semantics

Treat delivery status and content availability as separate dimensions. A message can be seen while remaining available until the room ends. A single status field should not erase that history or grant access after the room ends.

| UI status | Exact meaning |
| --- | --- |
| Sending | The current browser has submitted text but has no server acceptance yet. |
| Sent | The server transaction committed the message successfully. |
| Delivered | At least one recipient browser acknowledged receiving the body into application memory. |
| Seen | At least one recipient browser acknowledged displaying the message under the visibility rules. |
| Failed | The send was rejected, or the browser cannot establish whether it was accepted and requires recovery or retry. |
| Removed | The room ended and its message body is no longer available. |

Writing to a socket or publishing to the broker does not prove delivery. A STOMP transport receipt is not a substitute for an application-level delivery acknowledgment.

### Both participants have viewed

The sender's accepted authorship counts as their view. The other participant must generate a valid seen acknowledgment. This satisfies the two-participant rule without waiting for every tab or every future linked device.

Never count the sender's second tab as recipient delivery or recipient viewing. Identity determines the recipient, not which socket produced an acknowledgment.

### When a client may send Seen

A recipient browser may acknowledge viewing only when the relevant room is active, the document is visible and focused, and the message bubble has been within the visible conversation area for at least five hundred milliseconds.

A message off-screen, in a background tab, or in a room-list preview remains unread. Presence and typing do not imply a view.

This is a UI observation, not proof of human attention. The server can validate identity and message eligibility, but cannot prove that a person actually read text.

### Retention in words

At acceptance, associate the message with the room's existing expiry. Receipts never change that time.

The creator can end the room sooner. Room expiry or closure makes all message bodies unavailable and starts the bounded metadata-retention window.

Duplicate receipts and later recipient views update status only. Sender retries never create a duplicate message.

### Worked example

| Time | Event | Result |
| --- | --- | --- |
| Time | Event | Result |
| --- | --- | --- |
| 10:00:00 | A message is accepted in a room that ends at 10:30 | The message remains available until 10:30. |
| 10:01:00 | Recipient browser receives the message | Delivered; room-end time is unchanged. |
| 10:01:10 | Recipient visibly opens it | Seen; the message remains available. |
| 10:15:00 | Creator ends the room | Both clients remove the body; the server refuses further body reads. |
| By next successful cleanup batch | Content row is deleted | Lifecycle metadata remains temporarily for retries and reconciliation. |

## 11. Business logic for sending and receipts

### Accepting a send

1. Resolve the authenticated guest from the private credential.
2. Validate command structure, operation identifier, and text size.
3. Begin a short transaction and lock the room consistently.
4. Check membership and credential validity.
5. Look for an existing accepted operation with the same room, sender, and client operation identifier.
6. If found, return that operation's current metadata without inserting content. A retry after closure can receive this metadata while membership records remain, but cannot retrieve room content.
7. For a new operation, require an active, unexpired room with both participant slots allocated.
8. Enforce capacity and rate limits and reject blank text.
9. Assign the canonical message identifier, sequence, acceptance time, and room-end time.
10. Persist lifecycle metadata and content atomically and increment the room revision.
11. Commit before reporting Sent or publishing a message event.
12. Publish the committed update to the two participant identities, including the sender's other connected tabs.

Preserve meaningful whitespace and line breaks. Apply trimming only to determine whether content is empty. Treat content as text throughout its lifecycle.

If persistence fails, do not publish the body or report success. If persistence succeeds but event publication fails, the message remains accepted. The sender can retry the same operation and both participants can recover through snapshots.

### Processing Delivered

Verify that the caller is the recipient, that the message belongs to the room, and that content remains available. Set the first delivered time once. Publish the resulting committed receipt to both identities. Repeated acknowledgments are harmless.

### Processing Seen

Verify the same eligibility and record the first seen time once. Seen also establishes Delivered if a delivery acknowledgment was lost. Broadcast the updated receipt state after commit without changing message retention.

An acknowledgment for a message in an ended room must not revive the message or change its lifecycle. Return a harmless already-unavailable result without a body.

### Keeping transactions understandable

For this bounded two-person project, serialize durable operations for a room using a consistent room-row lock. Use the same lock order for sends, receipts, joins, closure, and cleanup. Keep socket publication and external work outside the transaction.

This deliberately trades maximum throughput for simple correctness. Measure contention before considering a more complex concurrency strategy.

## 12. Expiration, deletion, and privacy boundaries

### Availability and physical cleanup

Availability must be checked whenever a body is queried, included in a snapshot, or prepared for publication. A room's closed or expired state makes all its messages unavailable immediately.

A healthy cleanup worker should delete room content in the next five-second batch. If the server is stopped or overloaded, physical deletion may occur later. Ended room content must still be excluded immediately when the server next serves a request.

Run startup cleanup before allowing normal recovery reads. Clients also compare room-end times before rendering incoming events, so a late event does not flash content from an ended room.

### Cleanup responsibilities

1. Find due lifecycle records in bounded batches.
2. Acquire each room's lock using the standard lock order.
3. Recheck due time and room state inside the transaction.
4. Delete content and record a removal reason once.
5. Advance the room revision when a durable removal occurs.
6. Publish a content-free removal event after commit.
7. Purge room metadata after its recovery window, in dependency order.
8. Remove expired credentials, unused invitations, and unreferenced expired guests.

The job must tolerate duplicate execution and server restarts. A failed batch should be recorded without logging message bodies and retried later. Never schedule one operating-system thread per message.

### Browser behavior

- Remove ended-room message bodies from JavaScript state and the visible DOM.
- Clear any message preview that still references removed content.
- Cancel message-specific timers and remove pending body references after resolution.
- Keep drafts and retry bodies in page memory only and clear them on successful acceptance, explicit discard, credential loss, or room closure.
- Avoid local storage, IndexedDB, service-worker response caching, and analytics recording for conversations.
- Reconcile and hide stale private views when a page returns from browser back-forward caching.

Use no-store response behavior for private room and message HTTP responses. Static assets may be cached independently because they contain no conversation data.

### What ending a room means

The application stops serving room content, deletes message bodies from its active logical database, and instructs connected clients to remove them. Messages are not individually removed after viewing or by a message timer. Room closure and the 24-hour room limit remain the retention boundary. This does not guarantee forensic erasure from database pages, logs, filesystem snapshots, crash dumps, browser memory, or a participant's screenshots and copies.

TLS protects data in transit. It does not provide end-to-end encryption; this server can access message bodies. Describe BlinkChat as temporary chat, without claiming screenshot prevention, anonymous identity verification, or cryptographic self-destruction.

## 13. HTTP interface contract

These are proposed resource names and behaviors, not implementation snippets. All private operations require the authenticated guest. Mutations require CSRF protection. Opaque identifiers are references, never authorization credentials.

| Method | Resource | Purpose | Main rules |
| --- | --- | --- | --- |
| GET | /api/csrf | Obtain browser-readable CSRF information | Do not expose the HttpOnly guest credential. |
| POST | /api/guests | Establish or resume a guest browser identity | Set private cookie; return safe guest details. |
| GET | /api/me | Read current guest and credential expiry | Reject expired credentials. |
| PATCH | /api/me | Update display name | Validate length; preserve identity. |
| POST | /api/logout | Revoke this browser credential | Close related live connections. |
| POST | /api/rooms | Create a waiting room | Validate the optional title and active-room limits. |
| GET | /api/rooms | List this guest's available rooms | Never return other guests' rooms. |
| GET | /api/rooms/{roomId} | Read an authoritative room snapshot | Require membership; omit unavailable content. |
| GET | /api/rooms/{roomId}/messages | Page through available bodies | Stable sequence cursor, bounded page size. |
| POST | /api/rooms/{roomId}/invites | Create or replace an invitation | Creator only, while second slot is empty. |
| POST | /api/invites/redeem | Claim the second participant slot | Secret in request body; atomic validation. |
| POST | /api/rooms/{roomId}/close | End the room for both participants | Any member; irreversible room state. |
| GET | /api/health | Minimal deployment health response | No users, database contents, or secrets. |

A snapshot includes server time, room revision, room state, participant labels, room policy, available-message count, and a bounded first page of active messages. A continuation cursor identifies subsequent pages and the baseline revision.

Read snapshot metadata and its first page in one consistent database view. For later pages, if the durable revision changed, return a resynchronization signal rather than mixing pages from different room states. Small room limits make restarting a snapshot affordable.

### Errors

Return a stable machine-readable error category, a safe human message, an optional retry delay, and a correlation identifier. Validation errors may identify an input field. Never include stack traces, credentials, or message text in errors.

| Category | Frontend behavior |
| --- | --- |
| Invalid input | Explain the field or message restriction. |
| Unauthenticated or expired session | Stop private requests and offer a fresh guest entry. |
| Forbidden or unknown private resource | Show a generic unavailable message without confirming another person's room. |
| Invite unavailable | Offer a new invitation from the creator. |
| Room full | Explain that the room already has two participants. |
| Room closed or expired | Disable sending and clear private content. |
| Rate limited | Show when retry is permitted. |
| Capacity reached | Keep draft; explain that the room has reached its message limit. |
| Server failure | Keep uncertain sends distinguishable from confirmed failures. |

## 14. WebSocket and STOMP contract

Use one same-origin handshake endpoint at /ws. Use native WebSocket transport for the first release, with a small maintained STOMP browser client library. Vanilla JavaScript does not require writing a protocol parser by hand.

Bundle and pin the client dependency with the application. SockJS is unnecessary unless a tested browser or infrastructure requirement later justifies a fallback.

### Client commands

| Destination | Command | Required information |
| --- | --- | --- |
| /app/chat.send | Submit a message | Room identifier, client operation identifier, plain-text body. |
| /app/chat.delivered | Acknowledge receipt | Room identifier and message identifier. |
| /app/chat.seen | Acknowledge visible display | Room identifier and message identifier; a small bounded batch may be supported. |
| /app/chat.typing | Refresh or stop typing | Room identifier and typing state. |

The server derives the sender from the authenticated principal and the recipient from the room. A client-supplied sender, recipient, timestamp, status, sequence, or deadline must not override server decisions.

### Personal subscriptions

| Destination | Contents |
| --- | --- |
| /user/queue/events | Authorized room, message, receipt, and presence events for the current identity. |
| /user/queue/errors | Private command errors tied to the submitting operation where possible. |

Spring user destinations can route an event to the sessions associated with a particular user principal. Bind that principal to the opaque guest identity, and still enforce authentication and destination permissions explicitly. See [Spring user destinations](https://docs.spring.io/spring-framework/reference/web/websocket/stomp/user-destination.html).

Reject arbitrary subscriptions to broker internals, other identities' destinations, wildcard room streams, and public content topics. Reject client sends directly into broker queues. Allow only the declared commands and personal subscription forms.

### Event catalog

| Event | Meaning |
| --- | --- |
| room.updated | Membership, room policy summary, or state changed. |
| message.accepted | An operation has a committed canonical message identifier. |
| message.available | An active message is available to this participant. |
| message.delivered | First recipient delivery has been recorded. |
| message.seen | First view has been recorded. |
| message.removed | Content is unavailable; includes identifier and removal reason, never text. |
| presence.changed | Other participant's aggregate connection state changed. |
| typing.changed | Other participant is typing or their typing lease ended. |
| room.closed | Room ended or expired and content must be cleared. |
| session.expired | Credential is no longer usable and the connection will close. |

Durable events carry an event identifier, event type, room identifier, room revision, server time, and the minimum relevant data. Message events also carry canonical message identifier and sequence. Acceptance results include the client operation identifier for pending-bubble replacement.

Presence and typing are transient and use their own timestamps or versions rather than advancing durable room revision. Private command acknowledgments may refer to an already-existing durable revision and should not be mistaken for a new room mutation.

## 15. Ordering, idempotency, and synchronization

### Stable ordering

Order messages by the room sequence allocated in the database transaction. Do not rely on browser clocks, UUID ordering, or socket arrival order.

Spring documents that thread-pool processing can affect inbound and outbound ordering and provides order-preservation settings. Review those settings for the chosen version, but keep application sequences and reconciliation regardless. See [Spring message ordering](https://docs.spring.io/spring-framework/reference/web/websocket/stomp/ordered-messages.html).

### Send retries

Generate one unique client operation identifier when the user first sends a particular message. Retry that operation with the same identifier. A separately composed message gets a different identifier even when the text is identical.

If the connection drops after commit but before acceptance reaches the browser, the retry resolves to the existing message. If its room has ended, the retry returns unavailable metadata and never inserts the body again.

Keep the accepted-operation metadata until one hour after room closure or expiry. After metadata purge, the room no longer accepts commands, so an old retry cannot create a replacement message.

### Snapshot reconciliation sequence

1. Establish an authenticated socket and subscribe to personal destinations.
2. Start buffering incoming durable events while requesting the room snapshot.
3. Load the consistent snapshot and its bounded pages. Restart if the revision changed while paging.
4. Replace the client's authoritative active-message set with the snapshot.
5. Discard buffered events covered by the snapshot revision.
6. Apply newer durable revisions in order, deduplicating message identifiers.
7. If a revision is missing, request another snapshot rather than guessing what happened.
8. Resume normal interaction only after connection and room state are reconciled.

Every durable room mutation should emit a corresponding revision-bearing event to both identities. A revision check does not itself guarantee event delivery; snapshots are the repair mechanism.

When a message is absent from a complete authoritative snapshot, remove any confirmed local copy. Never merge old cached content back into the snapshot. Separately reconcile uncertain local operations by their operation identifiers; if a room is unavailable, discard their bodies.

### Room-end and removal precedence

Content removal and the most recent authoritative room state take precedence over late content events. Reject older revisions and content from ended rooms. Reset obsolete asynchronous requests when the user switches rooms so a late response cannot populate the wrong conversation.

The client uses server time and elapsed monotonic time to detect room end. After reconnect, focus restoration, or a large clock discrepancy, reconcile before displaying previously held text.

### Delivery guarantee

This release provides durable acceptance, idempotent retries, and eventual repair through snapshots. It does not claim exactly-once socket delivery or durable broker replay.

Because commit and socket publication are separate, a crash between them can delay notification. Reconciliation on reconnect, page focus, revision gaps, and the thirty-second foreground check repairs that state. A transactional outbox is a later improvement if stronger notification guarantees become a requirement.

## 16. Presence and typing

### Presence

Track the set of authenticated live socket sessions for each guest. The guest is online while at least one valid connection remains. Closing one of three tabs must not mark the guest offline.

Deduplicate disconnect processing, expire stale connections through heartbeat detection, and clear presence on restart. Do not restore old online flags from H2.

Publish presence only to members of active rooms involving that guest. There is no public list of online people. Connected means reachable through the server, not actively reading this conversation.

Use a short disconnect grace period of approximately three seconds before publishing offline to reduce flicker during quick reconnects, while still respecting credential expiry immediately.

### Typing

Authorize the room, forward typing only to the other participant, and retain short-lived per-connection typing leases in memory. Aggregate across the guest's connections so one tab stopping does not cancel another tab's active typing.

Clear the indicator after its timeout, successful send, room switch, room closure, or loss of all relevant connections. Do not persist keystrokes or typing history, and do not send the draft text with a typing event.

## 17. Reconnection and offline behavior

| Connection state | UI behavior |
| --- | --- |
| Connecting | Show progress; preserve draft; disable send until ready. |
| Connected and synchronized | Enable sending and normal receipts. |
| Reconnecting | Show a compact banner and pause new sends. |
| Network offline | Explain the connection issue and preserve only the current in-memory draft. |
| Session expired | Close private connections, clear content, and return to guest entry. |
| Room unavailable | Clear content and show a stable end state. |

Reconnect with exponential backoff and random jitter, beginning around one second and capping around thirty seconds. Pause futile attempts while the browser reports offline and allow an explicit Retry action.

Do not automatically submit a newly composed draft when connectivity returns. The user chooses Send after the room is synchronized. An already-submitted uncertain operation may be retried with its original identifier after its eligibility is checked.

Do not promise draft recovery after refresh or browser restart. Persisting drafts would be a different privacy choice requiring explicit design.

## 18. UI and interaction specification

### Visual direction

Use the supplied messaging references as mood references for hierarchy and polish. The supplied image proxy links were unavailable during preparation of this guide; the following design is an original proposed direction and does not claim to reproduce their exact visuals.

Aim for warm neutral surfaces, a restrained violet accent, generous spacing, rounded but compact bubbles, clear typography, and subtle motion. Keep message text the most prominent content.

### Suggested visual tokens

| Element | Proposed treatment |
| --- | --- |
| Main page | Very light neutral background, approximately #F6F7FB. |
| Sidebar and panels | White surfaces with light borders. |
| Primary action | Violet near #6D4AFF with a tested accessible foreground. |
| Primary text | Dark slate near #182033. |
| Secondary text | Muted slate selected for sufficient contrast. |
| Outgoing bubble | Accent-tinted or solid accent surface with readable text. |
| Incoming bubble | Neutral raised surface. |
| Danger state | Restrained red text or border with an explicit label. |
| Spacing | Four-, eight-, twelve-, sixteen-, twenty-four-, and thirty-two-pixel steps. |
| Panel corners | Sixteen to twenty-four pixels. |
| Bubble corners | Approximately sixteen pixels, with direction conveyed by placement. |
| Body typography | System font stack, comfortable line height, sixteen-pixel mobile input. |

These colors are starting points, not accessibility certification. Verify contrast in each actual foreground/background pairing. Build a consistent light theme first; a fully tested dark theme is an optional polish step.

### Screen A: Welcome and guest entry

Show the BlinkChat name, one sentence explaining temporary chat, the display-name field, and Create chat. For visitors arriving through an invitation, make Join chat the main action.

Suggested copy: “A private chat. Messages stay until the room ends.” Include a small, readable explanation that the server processes messages and that participants can still copy them.

Avoid presenting display-name entry as a password-protected account login.

### Screen B: Create and waiting room

The waiting view says “No messages yet” and provides an Invite button. The chat lasts until its creator ends it or its fixed lifetime of at most twenty-four hours expires; messages remain available for that entire time. Keep invitation management in the chat menu and keep the raw link out of persistent conversation previews.

Disable the composer until the second participant joins. Show an inviting empty state instead of an empty message list with unexplained disabled controls.

### Screen C: Desktop shell

At widths around 1024 pixels and above, use a sidebar roughly 280 to 320 pixels wide and a flexible conversation panel. Keep the central reading column comfortable on large monitors rather than stretching bubbles across the entire display.

The sidebar contains the current guest, Create chat, active and waiting rooms, unread counts, and a small settings or profile control. Use generic previews such as “New message” instead of message text.

The conversation contains a header, scrollable message area, reserved typing-indicator area, and composer. Room end time and member details belong in chat details; room actions belong in an overflow menu.

Do not put essential actions behind hover-only controls.

### Screen D: Mobile

Below approximately 768 pixels, show either the room list or the conversation as a full-screen view. A back control returns to rooms. Intermediate widths may use a collapsible sidebar.

Keep the header and composer within the visible viewport when the software keyboard opens. Account for mobile safe areas and dynamic browser bars. Use one main conversation scroll container.

Provide touch targets of at least approximately forty-four pixels. Long text and unbroken strings must wrap without creating horizontal page scrolling.

### Composer

Use a multiline text input with a bounded growth height, an obvious Send button, and a remaining-character indicator near the limit. Disable Send for blank text, over-limit content, disconnected state, or unavailable rooms.

On desktop, Enter sends and Shift+Enter inserts a line break. Do not send while an input-method composition is active. On mobile, prioritize the visible Send button and allow the keyboard's newline behavior.

Avoid attachment and microphone buttons that imply unimplemented features.

### Message bubbles and scrolling

- Align outgoing and incoming messages consistently and show clear accessible status labels.
- Use subtle status text for Sending, Sent, Delivered, Seen, and Failed.
- Auto-scroll when the user is already near the bottom or sends a message.
- If the user is reading older content, preserve their position and show a New messages control.
- Keep scrolling stable as new messages arrive.
- Keep message bodies until the room ends, then clear the conversation.

### Motion

Use short transitions, approximately 120 to 200 milliseconds, for bubble appearance, panel changes, and button feedback. Avoid bounce animations for ordinary messages.

At expiry, remove the text immediately from application state and the DOM. Any decorative collapse animation should operate on a content-free shell and should not extend the readable deadline. Respect reduced-motion preferences.

### Accessibility

Support keyboard-only navigation, visible focus, semantic controls, labeled inputs, readable contrast, and zoom. Restore focus after dialogs close and preserve composer focus after sending.

Announce useful new-message and connection events with a restrained live region. Do not announce every countdown second or every presence heartbeat. Status icons need readable labels; color alone must not communicate delivery or failure.

## 19. Optional same-person device linking

Core cross-device chat needs no identity transfer: one participant opens the room on a phone and the other on a laptop. Multiple tabs in one browser share its guest cookie.

If the same participant needs both their laptop and phone to share one identity, implement a dedicated pairing flow after the core release. Reusing the room invitation is incorrect because it grants a participant slot, not an existing identity.

### Proposed pairing flow

1. The already-authenticated device selects Link another device.
2. The server creates a separate high-entropy, single-use pairing secret with a two-minute expiry.
3. The second device opens the pairing link and requests association.
4. The original device shows the requesting device and a matching confirmation phrase.
5. The user explicitly approves from the original authenticated device.
6. The server atomically consumes the pairing request and issues a separate browser credential for the same guest.
7. Both devices receive room events for that identity.

Never reveal the first device's cookie to the second. Rate-limit pairing, allow cancellation, cap linked devices, and support per-device credential revocation. New credentials cannot extend the guest's absolute lifetime.

If one linked recipient device views a message, that counts for the participant's view status. The message remains available on other devices until the room ends.

## 20. Security requirements for the first public release

These controls implement private chat; they are part of the feature, even without registered accounts.

### Request and message authorization

- Authenticate every private HTTP request and socket connection.
- Check membership for each snapshot, send, receipt, typing event, and room operation.
- Authorize subscriptions and sends separately, defaulting to rejection.
- Derive identities and deadlines from server state.
- Expire and revoke active sockets, rather than only refusing future handshakes.
- Restrict outbound publication to currently valid credentials and authorized memberships.

### Browser and transport protection

- Use HTTPS and secure WebSocket connections in hosted environments.
- Keep frontend and backend on one origin and allow only expected handshake origins.
- Retain CSRF protection for cookie-authenticated mutations and the STOMP connection flow.
- Render messages as plain text, never as interpreted HTML.
- Apply a restrictive content-security policy and avoid third-party scripts on private views.
- Use a no-referrer policy for invitation handling and keep secrets out of query strings and logs.
- Keep the H2 web console disabled in hosted environments.

Origin checks, SameSite cookies, authentication, and CSRF protection address different parts of the browser threat model; do not treat one as a substitute for all the others.

### Resource and data protection

Apply limits to anonymous guest creation, invitations, join attempts, socket connections, sends, and receipt batches. Bound server executors, outgoing buffers, frame sizes, snapshot sizes, and cleanup batches. Disconnect persistently slow consumers rather than accumulating unlimited message bodies in memory.

Keep credentials and private text out of access logs, exception messages, socket frame tracing, analytics, and diagnostic dumps. Restrict public diagnostics to minimal health information. Store database files outside static resources and source control.

No username directory, public room enumeration, or user-search endpoint is needed for this release.

## 21. Project organization without implementation code

Use com.blinkchat as the root package. Keep controllers thin, lifecycle decisions in services, and persistence access in repositories.

| Package | Suggested files or components | Responsibility |
| --- | --- | --- |
| config | WebSocketConfig.java, SecurityConfig.java, SchedulingConfig.java | Transport, guest security, scheduling, and application settings. |
| identity | GuestIdentityService.java, GuestAuthenticationFilter.java, GuestPrincipal.java | Establish and resolve guest identity. |
| controller | GuestController.java, RoomController.java, InviteController.java, ChatController.java | HTTP and STOMP entry points. |
| service | RoomService.java, InvitationService.java, MessageService.java, ReceiptService.java | Durable business operations. |
| presence | PresenceService.java, TypingService.java, ConnectionRegistry.java | Live session counts and short-lived typing state. |
| lifecycle | MessageExpiryPolicy.java, MessageCleanupService.java, RoomCleanupService.java | Deadline decisions, content deletion, and metadata purge. |
| messaging | ChatEventPublisher.java, ChatCommandAuthorizer.java | Private event publication and command permissions. |
| model | Guest.java, GuestCredential.java, Room.java, Membership.java, Invitation.java, MessageRecord.java, MessageContent.java | Persistence models and states. |
| repository | A repository for each durable aggregate | Database operations and constrained lookups. |
| dto | Requests, responses, snapshots, commands, events, and error objects | Explicit external contracts. |
| exception | Domain errors and shared exception handlers | Consistent safe error responses. |

### Frontend files

| File or area | Responsibility |
| --- | --- |
| index.html | Accessible application shell and entry screens. |
| styles.css | Layout, tokens, components, responsive behavior, and reduced-motion rules. |
| app.js | Initialize application state and screen navigation. |
| api.js | HTTP requests, CSRF handling, and consistent errors. |
| socket.js | STOMP lifecycle, subscriptions, reconnection, and command transport. |
| state.js | Canonical client state, message merging, revisions, and pending operations. |
| chat-view.js | Conversation rendering and scroll behavior. |
| visibility.js | Active-room and message-visibility detection. |
| expiry.js | Server-time estimation and content removal scheduling. |
| assets | Original or properly licensed icons and static visual assets. |

Use ordinary browser modules to divide responsibilities without introducing a frontend framework. Do not create a large utility layer before repeated concrete needs appear.

## 22. Development roadmap with completion gates

The order below preserves the user's UI-first goal while introducing authorization before real private traffic. Work in milestones and verify each gate before expanding scope.

### Milestone 1: Product rules and project foundation

Define the room policy, default timings, error categories, and data-retention boundary. Create the Spring Boot project using Java 21, Spring Web, WebSocket, validation, Spring Data JPA, H2, Spring Security, and the normal test support.

Choose either Gradle or Maven; Gradle is a reasonable match for the user's existing Java projects. Use the wrapper and a stable Spring Boot release whose documentation supports Java 21. Let Spring Boot manage dependency compatibility and pin the selected application and client versions.

The [Spring Boot system requirements](https://docs.spring.io/spring-boot/system-requirements.html) are the reference for checking compatibility when generating the project. Avoid treating an unversioned documentation page as a permanently fixed release number.

Deliverable: the app serves a static page and exposes a minimal health result.

Completion gate: the same Java version runs the build and application, and separate development, test, and hosted settings exist.

### Milestone 2: Polished static UI

Build the guest entry, room creation, waiting room, room list, desktop conversation, mobile conversation, and ended-room screens. Use clearly labeled fictional sample content during development.

Include pending bubbles, receipts, typing, countdown, empty state, long-text rendering, connection banner, and error dialogs. No real message content is persisted yet.

Deliverable: every main screen and state can be reviewed at phone and desktop widths.

Completion gate: no horizontal overflow at a 360-pixel viewport; keyboard navigation works; composer and software keyboard behavior are usable on a real phone.

### Milestone 3: Guest identity, rooms, and H2

Implement guest credentials, room creation, membership constraints, invitation creation, atomic redemption, room listing, and snapshots. Establish authenticated principal handling before enabling private socket traffic.

Persist identity and room records in file-based H2. Keep the database outside the application package and static resources. Use disposable isolated databases for tests.

Deliverable: two independent browsers can join one room, while a third cannot enter it.

Completion gate: refresh retains authorized membership; matching display names confer no access; concurrent joins allocate only one final slot; valid credentials work after a controlled restart.

### Milestone 4: Real-time text and acceptance

Connect the STOMP client, authorize personal subscriptions, and implement message acceptance with sequences and client operation identifiers. Save each accepted message before publication.

Add optimistic bubbles, accepted-state replacement, recipient acknowledgments, safe errors, and cross-device routing. Keep controllers focused on delegating to services.

Deliverable: two devices exchange text immediately, and the sender sees Sent only after commit.

Completion gate: database failure produces no successful message event; a lost acceptance followed by retry produces one canonical message.

### Milestone 5: Room-end retention

Implement visibility-based Seen, message retention until room end, content deletion on room closure or expiry, and startup cleanup. Add client room-end handling and content-free removal events.

Deliverable: both participants retain messages until the room ends, and ended room content cannot be fetched again.

Completion gate: a delayed cleanup worker does not expose ended room content; receipts never change retention; refresh and reconnect never restore removed content.

### Milestone 6: Recovery, presence, and typing

Implement subscription-before-snapshot recovery, revisions, pagination consistency, foreground reconciliation, heartbeat-based presence, typing leases, and reconnect backoff.

Deliverable: network interruption has a clear UI and converges to authoritative server state after recovery.

Completion gate: closing one of several tabs does not mark a participant offline; missed publication is repaired; stale events cannot resurrect content.

### Milestone 7: Interface refinement and security verification

Review spacing, typography, transitions, accessibility, focus management, mobile keyboard behavior, long content, loading states, and End chat confirmation. Test authentication and destination permissions with deliberately manipulated requests.

Deliverable: a coherent, usable first release with predictable failures.

Completion gate: all first-release acceptance cases in Section 24 pass, and public diagnostics reveal no private data.

### Milestone 8: Deployment and demonstration

Deploy one application instance, verify secure sockets and storage behavior, and test from two separate networks. Prepare a concise README, screenshots with fictional content, and a short demo.

Deliverable: a live URL that supports a complete private ephemeral conversation.

Completion gate: a controlled restart behaves according to the selected storage mode and clients reconnect without replaying expired bodies.

Add same-person device linking only after these gates pass, if it is still useful.

## 23. Testing strategy

This project has meaningful concurrency, authorization, and time-based behavior. Test those rules directly instead of writing tests that merely mirror getters or framework wiring.

### Unit tests

Use a controllable application clock for room-end calculations. Cover message retention after viewing and while unread, the 200-message cap, automatic room expiry, duplicate Seen, and closure precedence. Test recipient authorization and the separation between delivery state and content availability.

Avoid real multi-minute waits; advance the test clock and inspect the result.

### Database integration tests

Verify membership uniqueness, room sequence uniqueness, retry uniqueness, transaction rollback, content deletion, startup cleanup, and credential recovery. Exercise two concurrent join attempts and two concurrent retries using separate transactions.

Use the actual H2 persistence mode where filesystem restart behavior matters, within a disposable directory. Do not run destructive tests against the development database.

### HTTP and STOMP integration tests

Check unauthenticated requests, CSRF failures, origin rejection, unauthorized subscription, direct broker sends, forged sender fields, non-member receipts, expired credentials on existing sockets, and safe error responses.

Do not equate a connected socket with an authorized client. Test command and subscription permissions independently.

### Browser verification

Use two independent browser profiles for separate guests. Use multiple tabs in one profile to test shared identity. Test a phone and laptop, hidden tabs, scrolled-away messages, slow networks, reconnection, long text, input-method composition, reduced motion, and keyboard navigation.

### Small load exercise

As a proposed demonstration target, try fifty concurrent sockets and ten accepted messages per second across several rooms on the chosen host. Record hardware, settings, latency, errors, and cleanup lag. This is a test target, not an advertised capacity claim.

Watch database lock waits, socket buffers, memory use, and cleanup duration. Stop increasing load when the purpose of the exercise has been met; optimize only a demonstrated bottleneck.

## 24. Acceptance checklist

| Scenario | Required outcome |
| --- | --- |
| Same display name used by two guests | Separate identities and permissions. |
| Third guest guesses a room identifier | No room content or membership access. |
| Two guests claim the same invitation simultaneously | Exactly one new participant is admitted. |
| Invitation link is previewed | It is not consumed until Join is submitted. |
| Original member repeats Join after a lost response | Existing membership is returned. |
| Recipient offline | Sender sees Sent; message is recoverable until room end. |
| Recipient receives a socket frame without application acknowledgment | No false Delivered status. |
| Message arrives in a background tab | Delivered may update; Seen does not. |
| Message is below the visible scroll area | Seen waits for actual visible display. |
| Sender's extra tab receives the message | It cannot generate recipient receipts. |
| Recipient reports Seen twice | One first-seen time; retention is unchanged. |
| Recipient reads a message | Content remains available until room end. |
| Room ends while recipient is offline | Reconnect returns no body. |
| Cleanup job is delayed after room end | All read paths still omit room content. |
| Socket acceptance is lost | Retrying the same operation creates no duplicate. |
| Old send is retried after room end | Metadata may return; body is never recreated. |
| Commit succeeds but publication fails | Reconciliation discovers the committed state. |
| Events arrive out of order | Revision handling or a fresh snapshot restores correct state. |
| Snapshot is paged while room changes | Client restarts reconciliation instead of mixing versions. |
| One of several tabs closes | Guest remains online through remaining valid connections. |
| Network drops without a clean disconnect | Heartbeat timeout eventually clears stale presence. |
| A guest's credential expires with an open socket | Private commands and delivery stop; socket closes. |
| Message contains HTML-like text | It appears as text and executes nothing. |
| Oversized or rapid sends arrive | Bounded rejection without destabilizing other rooms. |
| A participant selects End chat | Both lose content, invitations fail, and new sends stop. |
| Browser refreshes or returns from back-forward cache | Unavailable content is not restored into the live view. |
| Room metadata reaches its purge deadline | Dependent metadata is removed and old operations remain impossible. |
| Application restarts with persistent H2 | Valid identities recover and active room messages remain available. |
| Application restarts in disposable hosted mode | UI explains the lost room and returns to fresh entry. |

## 25. Deployment plan

### Single-origin deployment

Package the frontend with Spring Boot and deploy one Java service, using a Java 21 container image if the hosting service requires it. Configure the host-provided listening port, trusted external origin, credential settings, and data directory through deployment settings rather than source-controlled secrets.

Verify HTTPS, secure WebSocket upgrade, static file delivery, and the socket endpoint from the final public domain. Test on a phone using mobile data so the demonstration is not dependent on a shared local network.

Render supports inbound WebSocket connections on web services and recommends secure WebSocket connections for public clients, heartbeats, and reconnection backoff. Restarts and network events can interrupt existing sockets. See [Render WebSockets](https://render.com/docs/websocket).

### Choose storage mode deliberately

| Mode | Suitable use | Restart behavior |
| --- | --- | --- |
| Local file-based H2 | Development and local demonstration | Survives application restarts when the data directory remains. |
| Hosted file-based H2 on persistent disk | A hosted MVP with recoverable active rooms | Survives service restarts when mounted and configured correctly. |
| Hosted disposable filesystem or in-memory H2 | A demonstration where losing rooms is acceptable | Rooms and identities can disappear on restart or redeploy. |

Render's filesystem is ephemeral by default. Its documentation currently makes persistent disks available for paid services, with persistence limited to the configured mount path. Do not promise restart durability from a file-based database written outside that path. Verify the current service options before deployment. See [Render persistent disks](https://render.com/docs/disks).

Keep one application instance with this H2 and simple-broker architecture. Horizontal scaling needs shared durable storage and cross-instance event routing and is outside this release.

### Retention outside the application

Persistent volumes and hosting providers may retain snapshots after the application deletes content. Render documents automatic disk snapshots. State that retention boundary clearly, and review the provider's current retention behavior before making any stronger privacy claim.

For this ephemeral MVP, avoid application-level message backups. If operational backups are introduced later, define their retention and access, and ensure restored data is filtered against absolute expiry before any private reads.

## 26. Observability and maintenance

Collect counts, timings, and identifiers needed to operate the app without collecting conversation text.

| Signal | Why it matters |
| --- | --- |
| Active sockets and guests | Detect connection growth and stale sessions. |
| Active and waiting rooms | Understand capacity use. |
| Send acceptance latency and failure count | Identify persistence and validation problems. |
| First-delivery latency | Assess real-time responsiveness without equating it with reading. |
| Due content and cleanup lag | Detect retention backlog. |
| Database lock waits | Identify room transaction contention. |
| Reconnect and snapshot failures | Diagnose recovery problems. |
| Authorization and rate-limit rejections | Spot misuse or broken client behavior. |
| Outbound buffer pressure | Detect slow consumers. |

Use correlation identifiers for failures. Avoid putting guest, room, or message identifiers into unbounded metric labels. Keep diagnostic logs short-lived and restrict access.

On startup, establish database availability, perform due-content cleanup, and initialize empty presence state. On shutdown, stop accepting new work, finish short transactions where possible, and close sockets so browsers can reconnect.

## 27. Suggested working schedule

This is a sequencing aid for focused sessions, not a deadline guarantee. Each session can be split according to implementation difficulty.

| Session | Main result |
| --- | --- |
| 1 | Finalize policy, generate project, and serve the static shell. |
| 2 | Build welcome, create, invite, and waiting screens. |
| 3 | Complete desktop and mobile conversation layouts and visual states. |
| 4 | Persist guests and credentials; secure private request access. |
| 5 | Implement rooms, atomic invitation redemption, and membership tests. |
| 6 | Connect authenticated sockets and private text delivery. |
| 7 | Add acceptance, delivery receipts, sequences, and idempotent retries. |
| 8 | Implement Seen, room-end retention, cleanup, and closure. |
| 9 | Implement snapshots, reconnection, presence, and typing. |
| 10 | Verify concurrency, security boundaries, and lifecycle edge cases. |
| 11 | Refine mobile behavior, accessibility, and visual transitions. |
| 12 | Deploy, test across networks, and record the demonstration. |

Keep a short working checklist for the current milestone. Finish a complete vertical flow before adding optional features.

## 28. Demonstration and portfolio explanation

### Three-minute demonstration

1. Open BlinkChat on a laptop and create a room.
2. Join from a phone with a different guest identity.
3. Show online state and a typing indicator.
4. Send a message and show the distinction between Sent, Delivered, and Seen.
5. Show that viewed messages remain on both devices.
6. Refresh to demonstrate that retained content returns until the room ends.
7. Briefly disconnect one device, send an unread message, and reconnect before room end.
8. End the chat and show that the invitation and room no longer permit access.

Use fictional content and avoid displaying raw credentials or real private conversation text in screenshots or recordings.

### Engineering points to explain

- How the server routes events between independent devices.
- Why a display name is different from an authenticated identity.
- Why Sent, Delivered, and Seen require different evidence.
- How database transactions handle concurrent joins and duplicate sends.
- How absolute deadlines prevent reconnects from restoring expired content.
- Why H2 is appropriate for this single-instance scope and what would change at larger scale.
- Why application deletion does not promise forensic erasure or end-to-end encryption.

### Documentation to maintain during the build

Maintain a short product overview, local setup instructions, exact selected dependency versions, environment-setting names, API and event reference, test instructions, known limits, and deployment behavior. Once implementation exists, those separate developer documents may contain code; this build guide remains code-free.

## 29. Common implementation mistakes to avoid

| Mistake | Consequence | Design rule |
| --- | --- | --- |
| Trusting a sender name from the browser | Impersonation | Resolve the caller from a private credential. |
| Letting anyone subscribe to a room topic | Conversation disclosure | Use authenticated personal routing and deny unknown subscriptions. |
| Publishing before persistence commits | False Sent status or ghost messages | Commit first, then publish. |
| Treating broker publication as delivery | Misleading receipts | Require recipient application acknowledgment. |
| Marking all received messages Seen | Background tabs consume messages | Apply active-room and visible-message rules. |
| Resetting expiry on retry or later view | Indefinite retention | Preserve first acceptance and first view. |
| Deleting only from the screen | Bodies remain retrievable | Enforce server availability and database cleanup. |
| Waiting only for cleanup to hide content | Expired text leaks between batches | Filter deadlines on every body access. |
| Removing idempotency metadata with the body | Retries recreate messages | Retain bounded content-free operation records. |
| Restoring browser message caches | Disappeared text returns | Keep bodies in memory and replace state from snapshots. |
| One online boolean per guest | Closing one tab marks all devices offline | Aggregate valid connections. |
| Persisting typing flags | Stale indicators survive restart | Keep short leases in memory. |
| Assuming file-based H2 always persists in hosting | Restart unexpectedly loses rooms | Use an appropriate persistent mount or label the mode disposable. |
| Adding multiple application instances | Routing and embedded-storage inconsistency | Stay single-instance for this architecture. |
| Adding accounts and attachments early | Delays lifecycle correctness | Complete the first-release gates first. |

## 30. Definition of done

BlinkChat's first release is complete when two independent guests can join a private two-person room, exchange text across devices, understand its delivery and visibility state, and retain messages until the room ends.

Refreshes, retries, duplicate receipts, socket interruptions, delayed cleanup, and application restarts must obey that policy. Unauthorized guests must not read, join, subscribe to, or send into an existing private conversation.

The interface must work on a real phone and desktop browser with accessible controls, stable scrolling, clear loading and error states, and no misleading privacy promises. Deployment must state its actual durability behavior.

## 31. Primary documentation references

These references support the framework and hosting behavior mentioned above. The product rules, package plan, timing defaults, and milestone sequence are proposed specifically for BlinkChat. Check documentation for the exact pinned versions at implementation time.

- [Spring Boot system requirements](https://docs.spring.io/spring-boot/system-requirements.html)
- [Spring Framework STOMP overview](https://docs.spring.io/spring-framework/reference/web/websocket/stomp.html)
- [Spring simple broker](https://docs.spring.io/spring-framework/reference/web/websocket/stomp/handle-simple-broker.html)
- [Spring user destinations](https://docs.spring.io/spring-framework/reference/web/websocket/stomp/user-destination.html)
- [Spring message ordering](https://docs.spring.io/spring-framework/reference/web/websocket/stomp/ordered-messages.html)
- [Spring Security WebSocket integration](https://docs.spring.io/spring-security/reference/servlet/integrations/websocket.html)
- [H2 features and connection modes](https://h2database.com/html/features.html)
- [Render WebSocket hosting](https://render.com/docs/websocket)
- [Render persistent disks](https://render.com/docs/disks)
