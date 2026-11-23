# Architecture Diagram

BlinkChat is a single-instance Spring Boot monolith that serves a vanilla JavaScript frontend, REST APIs, and STOMP-over-WebSocket events. File-based H2 is the authoritative recovery store; the simple broker and browser state handle live delivery and reconnection.

## Application Architecture

<!-- mermaid-checked: no \n, no em-dash/en-dash, no {} in labels, subgraphs are id["label"], arrows are -->|"label"|, all subgraphs closed by end, ids unique -->
~~~mermaid
flowchart TD
    subgraph Client["Browser Client"]
        UI["HTML CSS and JavaScript"]
        HTTP["Fetch REST Client"]
        Socket["STOMP WebSocket Client"]
    end
    subgraph App["Spring Boot 4.2 Monolith"]
        Security["Spring Security"]
        Controllers["REST and STOMP Controllers"]
        Services["Identity and Chat Services"]
        Events["Event Publisher"]
        Scheduler["Cleanup and Presence Jobs"]
    end
    subgraph Data["Data and Persistence"]
        JPA["Jakarta Persistence"]
        H2[("H2 File Database")]
    end
    subgraph Realtime["In Process Messaging"]
        Broker["Spring Simple STOMP Broker"]
    end
    subgraph Host["Deployment"]
        Proxy["HTTPS Reverse Proxy"]
    end

    UI -->|"REST and CSRF"| HTTP
    UI -->|"STOMP commands"| Socket
    HTTP -->|"HTTP requests"| Security
    Socket -->|"native WebSocket"| Proxy
    Proxy -->|"forwarded request"| Security
    Security -->|"authorized calls"| Controllers
    Controllers -->|"domain operations"| Services
    Services -->|"transactional reads and writes"| JPA
    JPA -->|"SQL"| H2
    Services -->|"commit events"| Events
    Events -->|"private destinations"| Broker
    Broker -->|"live events"| Socket
    Scheduler -->|"expiry and cleanup"| Services
~~~

### Technology Stack Summary

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| Runtime | Java | 21 | Application language and runtime |
| Server framework | Spring Boot | 4.2.0 | REST, security, WebSocket, scheduling, JPA |
| Build | Gradle Wrapper | 9.9.2 | Build and test automation |
| Web API | Spring MVC and Validation | Managed by Spring Boot | HTTP endpoints and request handling |
| Realtime | STOMP over native WebSocket | STOMP 1.2 | Live send, receipt, typing, and presence events |
| Broker | Spring simple broker | In process | Private queue routing and heartbeats |
| Persistence | Jakarta Persistence and H2 | Managed versions | Entities and file-based durable state |
| Security | Spring Security | Managed by Spring Boot | CSRF, cookies, request and STOMP authorization |
| Frontend | HTML, CSS and vanilla JavaScript modules | Browser native | Responsive UI and client state |
| Browser STOMP | stompjs | 7.2.1 | STOMP client and reconnection |
| Testing | JUnit 5, Spring test, AssertJ, MockMvc | Managed versions | Integration and HTTP security tests |
| Browser testing | Playwright | 1.58.2 | End-to-end browser flows |
| Deployment | Docker and Render | Project configuration | Hosted container and persistent disk |

### Data Storage & External Services

BlinkChat uses a file-based H2 database for guests, credentials, rooms, memberships, invitations, messages, message recipients, and message content. The H2 password and data directory are environment-configurable. The hosted profile requires a stable disk-backed database directory and is intentionally designed for one application instance. It has no Redis, Kafka, external database, SMTP provider, object store, or other third-party application service. Render HTTPS or a reverse proxy is the only required hosted infrastructure.

### Key Architectural Decisions

- HTTP owns setup and authoritative snapshots, while WebSocket carries live commands and events.
- Rooms, receipts, operation retries, and message deadlines are enforced through transactional database locks and JPA state.
- Transient presence and typing are process-local, while durable application state remains in H2 for reconciliation after reconnect or restart.

## Component Relationships

<!-- mermaid-checked: no \n, no em-dash/en-dash, no {} in labels, subgraphs are id["label"], arrows are -->|"label"|, all subgraphs closed by end, ids unique -->
~~~mermaid
flowchart LR
    subgraph cPresentation["Presentation"]
        cApi["ApiController"]
        cChat["ChatController"]
        cBrowser["Browser Modules"]
    end
    subgraph cBusiness["Business Logic"]
        cIdentity["GuestIdentityService"]
        cChatService["ChatService"]
        cRates["RateLimits"]
        cCleanup["CleanupJob"]
    end
    subgraph cData["Data Access"]
        cRepo["ChatRepository"]
        cEntities["JPA Records"]
    end
    subgraph cInfrastructure["Infrastructure and Cross Cutting"]
        cSecurity["SecurityConfig"]
        cSocket["WebSocketConfig"]
        cConnections["Connections"]
        cPublisher["ChatEventPublisher"]
        cPolicy["Policy"]
        cErrors["Errors"]
    end

    cBrowser -->|"REST calls"| cApi
    cBrowser -->|"STOMP commands"| cChat
    cApi -->|"identity and chat operations"| cIdentity
    cApi -->|"rooms and snapshots"| cChatService
    cChat -->|"send and receipts"| cChatService
    cChat -->|"typing and command limits"| cConnections
    cIdentity -->|"credential persistence"| cRepo
    cChatService -->|"room and message persistence"| cRepo
    cRepo -->|"JPA entities"| cEntities
    cSecurity -.->|"authenticate requests"| cApi
    cSocket -.->|"authorize STOMP channels"| cChat
    cConnections -.->|"presence and typing"| cPublisher
    cChatService -.->|"durable events"| cPublisher
    cCleanup -.->|"scheduled lifecycle cleanup"| cChatService
    cPolicy -.->|"limits and lifetimes"| cIdentity
    cPolicy -.->|"limits and origins"| cSocket
    cErrors -.->|"safe error responses"| cApi
~~~

### Component Inventory

| Component | Layer | Type | Responsibility |
|---|---|---|---|
| ApiController | Presentation | REST controller | Guest sessions, CSRF, room, invitation, snapshot, and close endpoints |
| ChatController | Presentation | STOMP controller | Send, delivered, seen, typing, and socket error commands |
| Browser modules | Presentation | Vanilla JavaScript | Rendering, local pending state, recovery, reconnection, and socket subscriptions |
| GuestIdentityService | Business Logic | Service | Guest creation, SHA-256 credential lookup, naming, expiry, and logout |
| ChatService | Business Logic | Transactional service | Room membership, invitations, message lifecycle, receipts, snapshots, and cleanup |
| RateLimits | Business Logic | In-memory limiter | IP and participant command limits |
| CleanupJob | Business Logic | Scheduled component | Periodic room and identity cleanup |
| ChatRepository | Data Access | JPA repository | Entity lookup, room locks, queries, persistence, and queries with EntityManager |
| JPA Records | Data Access | Entity models | Guest, credential, room, membership, invitation, message, recipient, and content records |
| SecurityConfig | Infrastructure | Security configuration | Guest-cookie resolution, CSRF, route authorization, and secure headers |
| WebSocketConfig | Infrastructure | STOMP configuration | Broker, endpoints, transport limits, inbound validation, and outbound body filtering |
| Connections | Infrastructure | WebSocket presence component | Live sessions, limits, online status, typing leases, and revoke handling |
| ChatEventPublisher | Infrastructure | Event publisher | After-commit and transient private STOMP event delivery |
| Policy | Infrastructure | Configuration properties | Limits, TTLs, cookie, origin, and cleanup settings |
| Errors | Infrastructure | REST advice | Map domain failures to safe status and payload responses |
