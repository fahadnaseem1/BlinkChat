# BlinkChat 24-Hour Push Plan

## Scope and guardrails

This plan covers the 35 project paths reported as modified, intent-to-add, or
untracked on `main` at 02:06 local time on 2026-11-23. Files already tracked
and unchanged on `origin/main` do not need to be pushed again.

Push only the listed files in each batch; do not use `git add .` because the
working tree contains changes across multiple areas. Keep the existing delayed
push for `src/main/resources/static/index.html`, scheduled for about 02:33.
That timer commits and pushes only that file. The remaining batches are planned
at approximately 05:07, 10:07, 16:07, and 22:07 local time, completing within
24 hours of the request. Each commit should represent a genuine logical group;
the schedule does not imply the files were authored at those times.

## Schedule

| Approx. local time | Batch | Files | Gate before pushing |
| --- | --- | --- | --- |
| 02:33 | Existing timer: static entry page | `src/main/resources/static/index.html` | Timer commits and pushes this path only. |
| 05:07 | Project setup and runtime configuration | `package.json`, app bootstrap, security/WebSocket configuration, model, application profiles, logging, and this plan | Review the staged path list and run `git diff --cached --check`. |
| 10:07 | Backend behavior | Controllers, identity, messaging, repository, and services | Run `./gradlew test`; push only if it passes. |
| 16:07 | Browser client and bundled client library | Remaining static JavaScript/CSS and the STOMP distribution/license | Review the client diff and run `git diff --check`. Do not edit the vendor bundle. |
| 22:07 | Browser checks, integration tests, and build guide | Test sources, browser scripts, and detailed build guide | Run `./gradlew test` and review the browser scripts; run browser checks when the app and Playwright are available. |

These are proposed time slots, not a guarantee of successful pushes. Each
scheduled push should stop if its required validation fails, the target file
list has changed unexpectedly, or Git reports an error. Check `git status`
after each push and confirm the remote branch before continuing.

## File-by-file notes

### Setup and runtime configuration

- [package.json](./package.json) — Node package metadata and Playwright-based browser test commands.
- [BlinkChatApplication.java](./src/main/java/com/blinkchat/BlinkChatApplication.java) — Spring Boot application entry point.
- [Policy.java](./src/main/java/com/blinkchat/config/Policy.java) — Central application policy and configurable limits.
- [SecurityConfig.java](./src/main/java/com/blinkchat/config/SecurityConfig.java) — HTTP security, guest access, and request protection configuration.
- [WebSocketConfig.java](./src/main/java/com/blinkchat/config/WebSocketConfig.java) — WebSocket/STOMP transport and broker configuration.
- [Records.java](./src/main/java/com/blinkchat/model/Records.java) — Persistence model records/entities for chat data.
- [application.properties](./src/main/resources/application.properties) — Default Spring application settings.
- [application-dev.properties](./src/main/resources/application-dev.properties) — Local development profile settings.
- [application-hosted.properties](./src/main/resources/application-hosted.properties) — Hosted deployment profile settings.
- [logback-spring.xml](./src/main/resources/logback-spring.xml) — Logging configuration.

### Backend behavior

- [ApiController.java](./src/main/java/com/blinkchat/controller/ApiController.java) — HTTP API endpoints for chat and identity operations.
- [ChatController.java](./src/main/java/com/blinkchat/controller/ChatController.java) — STOMP chat commands and user-scoped socket errors.
- [Errors.java](./src/main/java/com/blinkchat/controller/Errors.java) — HTTP exception-to-response handling.
- [GuestIdentityService.java](./src/main/java/com/blinkchat/identity/GuestIdentityService.java) — Guest identity creation, resolution, and lifecycle.
- [GuestPrincipal.java](./src/main/java/com/blinkchat/identity/GuestPrincipal.java) — Authenticated guest principal representation.
- [ChatEventPublisher.java](./src/main/java/com/blinkchat/messaging/ChatEventPublisher.java) — Publication of chat and presence events.
- [ChatRepository.java](./src/main/java/com/blinkchat/repository/ChatRepository.java) — JPA persistence queries and entity access.
- [ChatService.java](./src/main/java/com/blinkchat/service/ChatService.java) — Core room, invitation, message, and receipt behavior.
- [CleanupJob.java](./src/main/java/com/blinkchat/service/CleanupJob.java) — Scheduled cleanup of expired chat data.
- [Problem.java](./src/main/java/com/blinkchat/service/Problem.java) — Structured application error representation.
- [RateLimits.java](./src/main/java/com/blinkchat/service/RateLimits.java) — Per-operation rate limiting.

### Browser client and bundled library

- [api.js](./src/main/resources/static/api.js) — Browser-side HTTP API requests.
- [app.js](./src/main/resources/static/app.js) — Main browser application behavior and UI wiring.
- [socket.js](./src/main/resources/static/socket.js) — Browser WebSocket/STOMP client handling.
- [styles.css](./src/main/resources/static/styles.css) — Chat interface styling.
- [visibility.js](./src/main/resources/static/visibility.js) — Browser page visibility/focus behavior.
- [stomp-7.2.1.min.js](./src/main/resources/static/vendor/stomp-7.2.1.min.js) — Bundled minified STOMP client dependency; preserve as supplied.
- [STOMP-LICENSE.txt](./src/main/resources/static/vendor/STOMP-LICENSE.txt) — License notice for the bundled STOMP client.

### Tests, scripts, and documentation

- [ChatIntegrationTests.java](./src/test/java/com/blinkchat/ChatIntegrationTests.java) — Spring integration tests for identity, chat, expiry, security, and concurrency behavior.
- [application.properties](./src/test/resources/application.properties) — Test-specific Spring configuration.
- [browser-smoke.cjs](./scripts/browser-smoke.cjs) — Browser smoke-test scenario.
- [group-chat.cjs](./scripts/group-chat.cjs) — Browser scenario for group chat behavior.
- [room-navigation.cjs](./scripts/room-navigation.cjs) — Browser scenario for room navigation.
- [BlinkChat_Detailed_Build_Guide.md](./src/main/resources/BlinkChat_Detailed_Build_Guide.md) — Detailed build and project operation guide.
