package com.blinkchat;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.blinkchat.config.Policy;
import com.blinkchat.identity.*;
import com.blinkchat.model.Records.*;
import com.blinkchat.repository.ChatRepository;
import com.blinkchat.service.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.*;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@SpringBootTest(properties = "blink.cleanup-ms=3600000")
@AutoConfigureMockMvc
class ChatIntegrationTests {

    // Advance time explicitly to test expiry without waiting for real timers.
    static class MutableClock extends Clock {

        volatile Instant time = Instant.parse("2026-11-23T00:00:00Z");

        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        public Clock withZone(ZoneId z) {
            return this;
        }

        public Instant instant() {
            return time;
        }
    }

    @TestConfiguration
    static class Config {

        @Bean
        @Primary
        MutableClock testClock() {
            return new MutableClock();
        }
    }

    @Autowired
    GuestIdentityService identity;

    @Autowired
    ChatService chat;

    @Autowired
    MutableClock clock;

    @Autowired
    Policy policy;

    @Autowired
    MockMvc mvc;

    @Autowired
    ChatRepository db;

    @Autowired
    PlatformTransactionManager txManager;

    GuestPrincipal a;
    GuestPrincipal b;
    String room;
    String secret;

    @BeforeEach
    void setup() {
        policy.maxParticipants = 20;
        clock.time = Instant.parse("2026-11-23T00:00:00Z");
        a = identity.establish(null, "Same Name").principal();
        b = identity.establish(null, "Same Name").principal();
        Map<String, Object> created = chat.create(a, null);
        room = (String) ((Map<?, ?>) created.get("room")).get("id");
        secret = (String) ((Map<?, ?>) created.get("invite")).get("secret");
    }

    @Test
    void onlyCreatorCanCloseAndLeavingRevokesEveryAccessPath() {
        join();
        var message = send();
        assertThatThrownBy(() -> chat.close(b, room)).isInstanceOfSatisfying(Problem.class, e ->
            assertThat(e.status).isEqualTo(403)
        );
        chat.leave(b, room);
        assertThat(chat.list(b)).isEmpty();
        assertThat(chat.participants(room)).containsExactly(a.guestId());
        assertThatThrownBy(() -> chat.snapshot(b, room, 0, null)).isInstanceOf(Problem.class);
        assertThatThrownBy(() ->
            chat.send(b, room, UUID.randomUUID().toString(), "no")
        ).isInstanceOf(Problem.class);
        assertThatThrownBy(() ->
            chat.receipt(b, room, (String) message.get("id"), true)
        ).isInstanceOf(Problem.class);
        assertThat(chat.canPublishBody(b, room, (String) message.get("id"))).isFalse();
        assertThatThrownBy(() -> chat.redeem(b, secret)).isInstanceOfSatisfying(Problem.class, e ->
            assertThat(e.category).isEqualTo("already_left")
        );
        assertThat((List<?>) chat.snapshot(a, room, 0, null).get("messages")).hasSize(1);
        assertThatThrownBy(this::send).isInstanceOf(Problem.class);
    }

    @Test
    void creatorLeaveTransfersOwnershipAndRevokesInvitation() {
        join();
        chat.leave(a, room);
        assertThat(chat.list(a)).isEmpty();
        assertThat(
            ((Map<?, ?>) chat.snapshot(b, room, 0, null).get("room")).get("creatorId")
        ).isEqualTo(b.guestId());
        assertThatThrownBy(() -> chat.previewInvitation(secret)).isInstanceOf(Problem.class);
        String replacement = (String) chat.invite(b, room).get("secret");
        var c = identity.establish(null, "New friend").principal();
        chat.redeem(c, replacement);
        assertThat(chat.participants(room)).containsExactly(b.guestId(), c.guestId());
        chat.send(c, room, UUID.randomUUID().toString(), "new audience");
        chat.close(b, room);
    }

    @Test
    void leavingFinalMemberClosesAndErasesChat() {
        join();
        var m = send();
        chat.leave(b, room);
        chat.leave(a, room);
        assertThat(chat.participants(room)).isEmpty();
        assertThatThrownBy(() -> chat.previewInvitation(secret)).isInstanceOf(Problem.class);
        new TransactionTemplate(txManager).executeWithoutResult(tx -> {
            assertThat(db.find(MessageContent.class, (String) m.get("id"))).isNull();
        });
    }

    @Test
    void messagesStayUntilRoomEndsRegardlessOfReceipts() {
        var created = chat.create(a, "Long-lived messages");
        String id = (String) ((Map<?, ?>) created.get("room")).get("id");
        Instant roomEndsAt = (Instant) ((Map<?, ?>) created.get("room")).get("expiresAt");
        chat.redeem(b, (String) ((Map<?, ?>) created.get("invite")).get("secret"));
        var m = chat.send(a, id, UUID.randomUUID().toString(), "hello");
        assertThat(m.get("roomEndsAt")).isEqualTo(roomEndsAt);
        clock.time = clock.time.plusSeconds(3601);
        var viewed = chat.receipt(b, id, (String) m.get("id"), true);
        assertThat(viewed.get("roomEndsAt")).isEqualTo(roomEndsAt);
        assertThat((List<?>) chat.snapshot(b, id, 0, null).get("messages")).hasSize(1);
    }

    @Test
    void repliesReferenceAnAvailableMessageInTheSameRoom() {
        join();
        Map<String, Object> original = send();
        Map<String, Object> reply = chat.send(
            a,
            room,
            UUID.randomUUID().toString(),
            "A reply",
            (String) original.get("id")
        );
        assertThat(reply).containsEntry("replyToId", original.get("id"));
        assertThat((List<?>) chat.snapshot(a, room, 0, null).get("messages")).hasSize(2);
        List<?> recipientMessages = (List<?>) chat.snapshot(b, room, 0, null).get("messages");
        Map<?, ?> visibleReply = (Map<?, ?>) recipientMessages.get(1);
        assertThat(visibleReply.get("replyToId")).isEqualTo(original.get("id"));
        assertThat(visibleReply.get("body")).isEqualTo("A reply");

        assertThatThrownBy(() ->
            chat.send(
                a,
                room,
                UUID.randomUUID().toString(),
                "Wrong chat",
                UUID.randomUUID().toString()
            )
        ).isInstanceOfSatisfying(Problem.class, e ->
            assertThat(e.category).isEqualTo("invalid_input")
        );
    }

    @Test
    void seenMessagesStillCountTowardTheRoomLimit() {
        join();
        policy.maxMessages = 1;
        try {
            var message = send();
            chat.receipt(b, room, (String) message.get("id"), true);
            assertThatThrownBy(() ->
                chat.send(a, room, UUID.randomUUID().toString(), "second message")
            ).isInstanceOfSatisfying(Problem.class, e ->
                assertThat(e.category).isEqualTo("capacity_reached")
            );
            assertThat((List<?>) chat.snapshot(a, room, 0, null).get("messages")).hasSize(1);
        } finally {
            policy.maxMessages = 200;
        }
    }

    void join() {
        chat.redeem(b, secret);
    }

    Map<String, Object> send() {
        return chat.send(a, room, UUID.randomUUID().toString(), "hello <script>alert(1)</script>");
    }

    @Test
    void displayNamesDoNotGrantAccess() {
        assertThat(a.guestId()).isNotEqualTo(b.guestId());
        assertThatThrownBy(() -> chat.snapshot(b, room, 0, null)).isInstanceOf(Problem.class);
        assertThat(chat.list(b)).isEmpty();
    }

    @Test
    void chatNamesAndCodesMatchForBothParticipants() {
        var created = chat.create(a, "  Weekend plans  ");
        var details = (Map<?, ?>) created.get("room");
        String namedRoom = (String) details.get("id");
        var invitation = (Map<?, ?>) created.get("invite");
        var joined = chat.redeem(b, (String) invitation.get("secret"));
        assertThat(details.get("title")).isEqualTo("Weekend plans");
        assertThat(joined.get("title")).isEqualTo(details.get("title"));
        assertThat(joined.get("code")).isEqualTo(details.get("code"));
        assertThat((String) details.get("code")).matches("[0-9A-F]{6}");
        assertThat(
            ((Map<?, ?>) chat.snapshot(a, namedRoom, 0, null).get("room")).get("title")
        ).isEqualTo("Weekend plans");
    }

    @Test
    void invalidChatNamesDoNotAllocateRooms() {
        int count = chat.list(a).size();
        assertThatThrownBy(() -> chat.create(a, "a".repeat(41))).isInstanceOf(Problem.class);
        assertThatThrownBy(() -> chat.create(a, "Misleading\nname")).isInstanceOf(
            Problem.class
        );
        assertThat(chat.list(a)).hasSize(count);
    }

    @Test
    void sameInvitationAdmitsConcurrentGuests() throws Exception {
        GuestPrincipal c = identity.establish(null, "Third").principal();
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            List<Future<Boolean>> results = List.of(
                pool.submit(() -> claim(b, start)),
                pool.submit(() -> claim(c, start))
            );
            start.countDown();
            int wins = 0;
            for (Future<Boolean> f : results) {
                if (f.get(10, TimeUnit.SECONDS)) {
                    wins++;
                }
            }
            assertThat(wins).isEqualTo(2);
            assertThat(chat.participants(room)).hasSize(3);
        } finally {
            pool.shutdownNow();
        }
    }

    boolean claim(GuestPrincipal g, CountDownLatch start) throws Exception {
        start.await();
        try {
            chat.redeem(g, secret);
            return true;
        } catch (Problem e) {
            return false;
        }
    }

    @Test
    void invitationPreviewAndCreatorDoNotConsumeIt() {
        assertThat(chat.participants(room)).hasSize(1);
        chat.redeem(a, secret);
        join();
        chat.redeem(b, secret);
        assertThat(chat.participants(room)).hasSize(2);
    }

    @Test
    void regeneratingInvitationInvalidatesOldSecret() {
        chat.invite(a, room);
        assertThatThrownBy(() -> chat.redeem(b, secret)).isInstanceOf(Problem.class);
    }

    @Test
    void onlyOneGuestCanTakeTheFinalGroupSlot() throws Exception {
        policy.maxParticipants = 3;
        join();
        GuestPrincipal c = identity.establish(null, "Third").principal(),
            d = identity.establish(null, "Fourth").principal();
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            var first = pool.submit(() -> claim(c, start));
            var second = pool.submit(() -> claim(d, start));
            start.countDown();
            int wins =
                (first.get(10, TimeUnit.SECONDS) ? 1 : 0) +
                (second.get(10, TimeUnit.SECONDS) ? 1 : 0);
            assertThat(wins).isEqualTo(1);
            assertThat(chat.participants(room)).hasSize(3);
            chat.redeem(b, secret);
            assertThat(chat.participants(room)).hasSize(3);
        } finally {
            pool.shutdownNow();
            policy.maxParticipants = 20;
        }
    }

    @Test
    void groupMessagesRemainAfterAllOriginalRecipientsHaveViewed() {
        join();
        GuestPrincipal c = identity.establish(null, "Third").principal();
        chat.redeem(c, secret);
        Instant roomEndsAt = (Instant) ((Map<?, ?>) chat.summary(chat.authorized(a, room)))
            .get("expiresAt");
        var message = send();
        String id = (String) message.get("id");
        assertThat(message.get("recipientCount")).isEqualTo(2);
        assertThat(message.get("roomEndsAt")).isEqualTo(roomEndsAt);
        var first = chat.receipt(b, room, id, true);
        assertThat(first.get("seenCount")).isEqualTo(1L);
        assertThat(first.get("seenAt")).isNull();
        assertThat(first.get("roomEndsAt")).isEqualTo(roomEndsAt);
        clock.time = clock.time.plusSeconds(20);
        assertThat((List<?>) chat.snapshot(c, room, 0, null).get("messages")).hasSize(1);
        var last = chat.receipt(c, room, id, true);
        assertThat(last.get("seenCount")).isEqualTo(2L);
        assertThat(last.get("roomEndsAt")).isEqualTo(roomEndsAt);
        clock.time = clock.time.plusSeconds(4);
        assertThat(chat.receipt(b, room, id, true).get("roomEndsAt")).isEqualTo(roomEndsAt);
        clock.time = clock.time.plusSeconds(7);
        for (GuestPrincipal guest : List.of(a, b, c)) {
            assertThat((List<?>) chat.snapshot(guest, room, 0, null).get("messages")).hasSize(1);
        }
    }

    @Test
    void laterMembersCannotReadOrAcknowledgeEarlierMessages() {
        join();
        var earlier = send();
        GuestPrincipal later = identity.establish(null, "Later").principal();
        chat.redeem(later, secret);
        assertThat((List<?>) chat.snapshot(later, room, 0, null).get("messages")).isEmpty();
        assertThat(chat.canPublishBody(later, room, (String) earlier.get("id"))).isFalse();
        assertThatThrownBy(() ->
            chat.receipt(later, room, (String) earlier.get("id"), true)
        ).isInstanceOf(Problem.class);
        assertThat(
            chat.receipt(b, room, (String) earlier.get("id"), true).get("recipientCount")
        ).isEqualTo(1);
        var next = send();
        assertThat(next.get("recipientCount")).isEqualTo(2);
        assertThat((List<?>) chat.snapshot(later, room, 0, null).get("messages")).hasSize(1);
    }

    @Test
    void activeGroupInvitationCanBeReplacedAndExpires() {
        join();
        var next = chat.invite(a, room);
        GuestPrincipal c = identity.establish(null, "Third").principal();
        assertThatThrownBy(() -> chat.redeem(c, secret)).isInstanceOf(Problem.class);
        chat.redeem(c, (String) next.get("secret"));
        GuestPrincipal d = identity.establish(null, "Fourth").principal();
        clock.time = clock.time.plusSeconds(901);
        assertThatThrownBy(() -> chat.redeem(d, (String) next.get("secret"))).isInstanceOf(
            Problem.class
        );
        assertThatThrownBy(() -> chat.invite(b, room)).isInstanceOf(Problem.class);
    }

    @Test
    void legacyPairReceiptsAreMigratedWithoutAddingLaterMembers() {
        join();
        var message = send();
        String id = (String) message.get("id");
        chat.receipt(b, room, id, true);
        new TransactionTemplate(txManager).executeWithoutResult(tx ->
            db
                .entityManager()
                .createQuery("delete from MessageRecipient where messageId=:id")
                .setParameter("id", id)
                .executeUpdate()
        );
        GuestPrincipal c = identity.establish(null, "Later").principal();
        chat.redeem(c, secret);
        chat.migrateGroupReceipts();
        chat.migrateGroupReceipts();
        var snapshot = chat.snapshot(a, room, 0, null);
        var record = (Map<?, ?>) ((List<?>) snapshot.get("messages")).getFirst();
        assertThat(record.get("recipientCount")).isEqualTo(1);
        assertThat(record.get("seenCount")).isEqualTo(1L);
        assertThat(record.get("roomEndsAt")).isEqualTo(
            ((Map<?, ?>) snapshot.get("room")).get("expiresAt")
        );
        assertThat((List<?>) chat.snapshot(c, room, 0, null).get("messages")).isEmpty();
    }

    @Test
    void metadataPurgeAlsoRemovesGroupRecipients() {
        join();
        var message = send();
        chat.close(a, room);
        clock.time = clock.time.plusSeconds(3601);
        chat.cleanupRoom(room);
        new TransactionTemplate(txManager).executeWithoutResult(tx -> {
            assertThat(db.find(MessageRecord.class, (String) message.get("id"))).isNull();
            assertThat(db.recipients((String) message.get("id"))).isEmpty();
        });
    }

    @Test
    void concurrentRetriesProduceOneCanonicalMessage() throws Exception {
        join();
        String op = UUID.randomUUID().toString();
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            var f1 = pool.submit(() -> chat.send(a, room, op, "first"));
            var f2 = pool.submit(() -> chat.send(a, room, op, "first"));
            assertThat(f1.get().get("id")).isEqualTo(f2.get().get("id"));
            assertThat((List<?>) chat.snapshot(a, room, 0, null).get("messages")).hasSize(1);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void unreadMessagesRemainUntilRoomEnds() {
        join();
        Map<String, Object> m = send();
        Instant roomEndsAt = (Instant) chat.summary(chat.authorized(a, room)).get("expiresAt");
        clock.time = clock.time.plusSeconds(3601);
        assertThat((List<?>) chat.snapshot(b, room, 0, null).get("messages")).hasSize(1);
        Map<String, Object> retry = chat.send(a, room, (String) m.get("operationId"), "resurrect");
        assertThat(retry.get("body")).isEqualTo(m.get("body"));
        assertThat(retry.get("available")).isEqualTo(true);
        chat.cleanupRoom(room);
        assertThat((List<?>) chat.snapshot(a, room, 0, null).get("messages")).hasSize(1);
        clock.time = roomEndsAt.minusSeconds(1);
        assertThat((List<?>) chat.snapshot(a, room, 0, null).get("messages")).hasSize(1);
        clock.time = roomEndsAt;
        chat.cleanupRoom(room);
        new TransactionTemplate(txManager).executeWithoutResult(t ->
            assertThat(db.find(MessageContent.class, (String) m.get("id"))).isNull()
        );
    }

    @Test
    void duplicateSeenNeverChangesRoomEndAndSenderCannotReceipt() {
        join();
        Map<String, Object> m = send();
        String id = (String) m.get("id");
        assertThat(m.get("deliveredAt")).isNull();
        assertThatThrownBy(() -> chat.receipt(a, room, id, true)).isInstanceOf(Problem.class);
        var first = chat.receipt(b, room, id, true);
        assertThat(first.get("deliveredAt")).isNotNull();
        clock.time = clock.time.plusSeconds(5);
        var second = chat.receipt(b, room, id, true);
        assertThat(second.get("roomEndsAt")).isEqualTo(first.get("roomEndsAt"));
        clock.time = clock.time.plusSeconds(6);
        assertThat((List<?>) chat.snapshot(a, room, 0, null).get("messages")).hasSize(1);
    }

    @Test
    void viewReceiptDoesNotShortenMessageLifetime() {
        join();
        var m = send();
        clock.time = clock.time.plusSeconds(3598);
        assertThat(chat.receipt(b, room, (String) m.get("id"), true).get("roomEndsAt")).isEqualTo(
            m.get("roomEndsAt")
        );
        assertThat((List<?>) chat.snapshot(b, room, 0, null).get("messages")).hasSize(1);
    }

    @Test
    void closureRemovesBodiesAndOldRetryOnlyReturnsMetadata() {
        join();
        var m = send();
        chat.close(a, room);
        assertThat((List<?>) chat.snapshot(a, room, 0, null).get("messages")).isEmpty();
        assertThat(chat.send(a, room, (String) m.get("operationId"), "retry")).doesNotContainKey(
            "body"
        );
        assertThatThrownBy(this::send).isInstanceOf(Problem.class);
    }

    @Test
    void changedRevisionRejectsPagination() {
        join();
        long revision = ((Number) chat.snapshot(a, room, 0, null).get("revision")).longValue();
        send();
        assertThatThrownBy(() -> chat.snapshot(a, room, 0, revision)).isInstanceOf(Problem.class);
    }

    @Test
    void revokedAndExpiredCredentialsCannotAccess() {
        identity.revoke(a);
        assertThatThrownBy(() -> chat.snapshot(a, room, 0, null)).isInstanceOf(Problem.class);
        clock.time = clock.time.plusSeconds(86401);
        assertThatThrownBy(() -> identity.me(b)).isInstanceOf(Problem.class);
    }

    @Test
    void bodyLengthUsesUnicodeCodePoints() {
        join();
        chat.send(a, room, UUID.randomUUID().toString(), "😀".repeat(2000));
        assertThatThrownBy(() ->
            chat.send(a, room, UUID.randomUUID().toString(), "a".repeat(2001))
        ).isInstanceOf(Problem.class);
    }

    @Test
    void sendCommandCanOmitUnrelatedTypingField() {
        var c = new tools.jackson.databind.json.JsonMapper().readValue(
            "{\"roomId\":\"room\",\"operationId\":\"operation\",\"body\":\"hello\"}",
            com.blinkchat.controller.ChatController.Command.class
        );
        assertThat(c.body()).isEqualTo("hello");
        assertThat(c.typing()).isNull();
    }

    @Test
    void privateHttpAndCsrfAreProtected() throws Exception {
        mvc.perform(get("/api/rooms")).andExpect(status().isUnauthorized());
        mvc.perform(
            post("/api/guests")
                .contentType("application/json")
                .content("{\"displayName\":\"Visitor\"}")
        ).andExpect(status().isForbidden());
        mvc.perform(
            post("/api/guests")
                .with(csrf())
                .contentType("application/json")
                .content("{\"displayName\":\"Visitor\"}")
        )
            .andExpect(status().isOk())
            .andExpect(cookie().httpOnly("BLINK_GUEST", true));
        mvc.perform(get("/api/health"))
            .andExpect(status().isOk())
            .andExpect(content().json("{\"status\":\"ok\"}"));
    }

    @Test
    void validCredentialSurvivesIdentityServiceRecreation() {
        var e = identity.establish(null, "Recover");
        var other = new GuestIdentityService(db, clock, policy);
        new TransactionTemplate(txManager).executeWithoutResult(t ->
            assertThat(other.resolve(e.secret()).guestId()).isEqualTo(e.principal().guestId())
        );
    }

    @Test
    void invitationPreviewRevealsOnlyMetadataAndDoesNotJoin() {
        long revision = (
            (Number) chat.summary(chat.authorized(a, room)).get("revision")
        ).longValue();
        var preview = chat.previewInvitation(secret);
        assertThat(preview).containsEntry("participantCount", 1);
        assertThat(preview).doesNotContainKeys("ttlSeconds", "readGraceSeconds");
        assertThat(preview).doesNotContainKeys(
            "participants",
            "messages",
            "creatorId",
            "id",
            "secret"
        );
        assertThat(chat.participants(room)).hasSize(1);
        assertThat(chat.list(b)).isEmpty();
        assertThat(chat.snapshot(a, room, 0, null).get("revision")).isEqualTo(revision);
        join();
        assertThat(chat.previewInvitation(secret)).containsEntry("participantCount", 2);
    }

    @Test
    void unavailableInvitationsCannotBePreviewed() {
        assertThatThrownBy(() -> chat.previewInvitation(null)).isInstanceOf(Problem.class);
        assertThatThrownBy(() -> chat.previewInvitation("wrong-secret")).isInstanceOf(
            Problem.class
        );
        String current = (String) chat.invite(a, room).get("secret");
        assertThatThrownBy(() -> chat.previewInvitation(secret)).isInstanceOf(Problem.class);
        clock.time = clock.time.plusSeconds(901);
        assertThatThrownBy(() -> chat.previewInvitation(current)).isInstanceOf(Problem.class);
        var next = chat.invite(a, room);
        chat.close(a, room);
        assertThatThrownBy(() -> chat.previewInvitation((String) next.get("secret"))).isInstanceOf(
            Problem.class
        );
    }

    @Test
    void previewIsPublicButStillRequiresCsrf() throws Exception {
        String body = "{\"secret\":\"" + secret + "\"}";
        mvc.perform(
            post("/api/invites/preview").contentType("application/json").content(body)
        ).andExpect(status().isForbidden());
        mvc.perform(
            post("/api/invites/preview").with(csrf()).contentType("application/json").content(body)
        )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.participantCount").value(1))
            .andExpect(jsonPath("$.participants").doesNotExist())
            .andExpect(jsonPath("$.messages").doesNotExist());
        mvc.perform(get("/api/rooms/" + room + "/operations/" + UUID.randomUUID())).andExpect(
            status().isUnauthorized()
        );
    }

    @Test
    void operationLookupIsSenderScopedAndRetainsUntilRoomEnds() {
        join();
        String operation = UUID.randomUUID().toString();
        assertThat(chat.operationStatus(a, room, operation)).containsEntry("accepted", false);
        assertThat((List<?>) chat.snapshot(a, room, 0, null).get("messages")).isEmpty();
        var sent = chat.send(a, room, operation, "A temporary message");
        var accepted = chat.operationStatus(a, room, operation);
        assertThat(accepted).containsEntry("accepted", true);
        assertThat(((Map<?, ?>) accepted.get("message")).containsKey("body")).isTrue();
        assertThat(chat.operationStatus(b, room, operation)).containsEntry("accepted", false);
        GuestPrincipal outsider = identity.establish(null, "Outsider").principal();
        assertThatThrownBy(() -> chat.operationStatus(outsider, room, operation)).isInstanceOf(
            Problem.class
        );
        clock.time = clock.time.plusSeconds(3601);
        var retained = chat.operationStatus(a, room, operation);
        assertThat(retained).containsEntry("accepted", true);
        var metadata = (Map<?, ?>) retained.get("message");
        assertThat(metadata.get("id")).isEqualTo(sent.get("id"));
        assertThat(metadata.get("available")).isEqualTo(true);
        assertThat(metadata.get("body")).isEqualTo(sent.get("body"));
    }
}
