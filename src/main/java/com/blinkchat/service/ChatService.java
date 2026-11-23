package com.blinkchat.service;

import com.blinkchat.config.Policy;
import com.blinkchat.identity.*;
import com.blinkchat.messaging.ChatEventPublisher;
import com.blinkchat.model.Records.*;
import com.blinkchat.repository.ChatRepository;
import java.time.*;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Enforces membership, frozen message audiences, and expiry within room transactions. */
@Service
@Transactional
public class ChatService {

    private final ChatRepository db;
    private final GuestIdentityService identity;
    private final Policy policy;
    private final Clock clock;
    private final ChatEventPublisher events;
    private final RateLimits rates;

    public ChatService(
        ChatRepository d,
        GuestIdentityService i,
        Policy p,
        Clock c,
        ChatEventPublisher e,
        RateLimits rates
    ) {
        db = d;
        identity = i;
        policy = p;
        clock = c;
        events = e;
        this.rates = rates;
    }

    public List<String> participants(String room) {
        return db
            .members(room)
            .stream()
            .map(m -> m.guestId)
            .toList();
    }

    public Room authorized(GuestPrincipal p, String id) {
        identity.require(p);
        Room r = db.room(id);
        identity.require(p);
        if (r == null || !participants(id).contains(p.guestId())) {
            throw Problem.unavailable();
        }
        return r;
    }

    private boolean live(Room r) {
        return r.closedAt == null && r.expiresAt.isAfter(clock.instant());
    }

    private void active(Room r) {
        if (!live(r)) {
            throw new Problem(410, "room_closed", "This conversation has ended.");
        }
    }

    private void capacity(GuestPrincipal p) {
        db.lock(Guest.class, p.guestId());
        if (db.rooms(p.guestId()).stream().filter(this::live).count() >= policy.maxRooms) {
            throw new Problem(409, "capacity_reached", "You can have at most five active rooms.");
        }
    }

    private void member(Room r, String guest, int slot) {
        Membership m = new Membership();
        m.id = UUID.randomUUID().toString();
        m.roomId = r.id;
        m.guestId = guest;
        m.slot = slot;
        m.joinedAt = clock.instant();
        db.save(m);
    }

    public Map<String, Object> create(GuestPrincipal p, long ttl) {
        return create(p, ttl, null);
    }

    public Map<String, Object> create(GuestPrincipal p, long ttl, String title) {
        return create(p, ttl, title, null);
    }

    public Map<String, Object> create(GuestPrincipal p, long ttl, String title, Long grace) {
        identity.require(p);
        if (grace != null && !Set.of(10L, 30L, 60L).contains(grace)) {
            throw Problem.invalid("Choose a read countdown of 10, 30, or 60 seconds.");
        }
        if (title != null) {
            title = title.strip();
            if (
                title.codePointCount(0, title.length()) > 40 ||
                title
                    .codePoints()
                    .anyMatch(
                        c -> Character.isISOControl(c) || Character.getType(c) == Character.FORMAT
                    )
            ) {
                throw Problem.invalid("Use up to 40 visible characters for the chat name.");
            }
        }
        if (!policy.ttls.contains(ttl)) {
            throw Problem.invalid("Choose a supported message lifetime.");
        }
        capacity(p);
        Room r = new Room();
        r.id = UUID.randomUUID().toString();
        r.creatorId = p.guestId();
        r.title = title == null || title.isBlank() ? null : title;
        r.state = "waiting";
        r.createdAt = clock.instant();
        r.expiresAt = r.createdAt.plus(policy.roomLifetime);
        r.ttlSeconds = ttl;
        r.graceSeconds = grace == null ? policy.readGrace.toSeconds() : grace;
        r.revision = 1;
        db.save(r);
        member(r, p.guestId(), 1);
        var result = Map.<String, Object>of("room", summary(r), "invite", inviteInternal(r));
        emit(r, "room.updated", Map.of());
        return result;
    }

    public Map<String, Object> invite(GuestPrincipal p, String room) {
        Room r = authorized(p, room);
        active(r);
        if (!r.creatorId.equals(p.guestId())) {
            throw Problem.unavailable();
        }
        rates.check("invite:" + p.guestId(), 10);
        return inviteInternal(r);
    }

    private Map<String, Object> inviteInternal(Room r) {
        db.entityManager()
            .createQuery("update Invitation set revokedAt=:n where roomId=:r and revokedAt is null")
            .setParameter("n", clock.instant())
            .setParameter("r", r.id)
            .executeUpdate();
        String raw = GuestIdentityService.secret();
        Invitation i = new Invitation();
        i.digest = GuestIdentityService.digest(raw);
        i.roomId = r.id;
        i.expiresAt = min(clock.instant().plus(policy.inviteLifetime), r.expiresAt);
        db.save(i);
        return Map.of("secret", raw, "expiresAt", i.expiresAt);
    }

    /** A bearer invitation reveals only a preview, without creating a guest or membership. */
    public Map<String, Object> previewInvitation(String raw) {
        if (raw == null || raw.length() > 100) throw inviteError();
        Invitation invitation = db.find(Invitation.class, GuestIdentityService.digest(raw));
        if (invitation == null) throw inviteError();
        Room room = db.room(invitation.roomId);
        if (
            room == null ||
            !live(room) ||
            invitation.revokedAt != null ||
            !invitation.expiresAt.isAfter(clock.instant())
        ) throw inviteError();
        return Map.of(
            "title",
            room.title == null ? "Private chat" : room.title,
            "participantCount",
            db.members(room.id).size(),
            "maxParticipants",
            policy.maxParticipants,
            "ttlSeconds",
            room.ttlSeconds,
            "readGraceSeconds",
            room.graceSeconds,
            "roomExpiresAt",
            room.expiresAt,
            "inviteExpiresAt",
            invitation.expiresAt
        );
    }

    /** Look up only this sender's operation before the client offers an uncertain send again. */
    public Map<String, Object> operationStatus(
        GuestPrincipal principal,
        String roomId,
        String operationId
    ) {
        Room room = authorized(principal, roomId);
        if (operationId == null || !operationId.matches("[A-Za-z0-9-]{16,80}")) {
            throw Problem.invalid("A valid operation identifier is required.");
        }
        MessageRecord message = db.operation(roomId, principal.guestId(), operationId);
        if (message == null) return Map.of("accepted", false);
        return Map.of("accepted", true, "message", view(room, message, principal.guestId()));
    }

    public Map<String, Object> redeem(GuestPrincipal p, String raw) {
        identity.require(p);
        rates.check("join:" + p.guestId(), 20);
        if (raw == null || raw.length() > 100) {
            throw inviteError();
        }
        Invitation found = db.find(Invitation.class, GuestIdentityService.digest(raw));
        if (found == null) {
            throw inviteError();
        }
        Room r = db.room(found.roomId);
        Invitation invitation = db.lock(Invitation.class, found.digest);
        if (r == null || !live(r)) {
            throw inviteError();
        }
        List<Membership> members = db.members(r.id);
        if (members.stream().anyMatch(m -> m.guestId.equals(p.guestId()))) {
            return summary(r);
        }
        if (invitation.revokedAt != null || !invitation.expiresAt.isAfter(clock.instant())) {
            throw inviteError();
        }
        if (members.size() >= policy.maxParticipants) {
            throw new Problem(
                409,
                "room_full",
                "This chat has reached its limit of " + policy.maxParticipants + " people."
            );
        }
        if (
            !db
                .entityManager()
                .createQuery("from Membership where roomId=:r and guestId=:g", Membership.class)
                .setParameter("r", r.id)
                .setParameter("g", p.guestId())
                .getResultList()
                .isEmpty()
        ) {
            throw new Problem(
                409,
                "already_left",
                "You left this chat. Use a new guest session to rejoin."
            );
        }
        capacity(p);
        identity.require(p);
        // Allocate the next slot under the room lock. The same link remains usable by other guests.
        int nextSlot =
            db
                .entityManager()
                .createQuery(
                    "select coalesce(max(slot), 0) from Membership where roomId=:r",
                    Integer.class
                )
                .setParameter("r", r.id)
                .getSingleResult() + 1;
        member(r, p.guestId(), nextSlot);
        if (invitation.consumedAt == null) {
            invitation.consumedAt = clock.instant();
            invitation.consumedBy = p.guestId();
        }
        r.state = "active";
        r.revision++;
        emit(r, "room.updated", Map.of());
        return summary(r);
    }

    private Problem inviteError() {
        return new Problem(
            409,
            "invite_unavailable",
            "This invitation is unavailable. Ask the creator for a new one."
        );
    }

    public List<Map<String, Object>> list(GuestPrincipal p) {
        identity.require(p);
        return db.rooms(p.guestId()).stream().filter(this::live).map(this::summary).toList();
    }

    public Map<String, Object> summary(Room r) {
        List<Map<String, Object>> members = db
            .members(r.id)
            .stream()
            .map(m -> {
                Guest g = db.find(Guest.class, m.guestId);
                return Map.<String, Object>of("id", g.id, "displayName", g.displayName);
            })
            .toList();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", r.id);
        out.put("title", r.title == null ? "" : r.title);
        out.put("code", r.id.substring(0, 6).toUpperCase(Locale.ROOT));
        out.put("creatorId", r.creatorId);
        out.put("maxParticipants", policy.maxParticipants);
        out.put("state", live(r) ? r.state : r.closedAt == null ? "expired" : "closed");
        out.put("participants", members);
        out.put("expiresAt", r.expiresAt);
        out.put("ttlSeconds", r.ttlSeconds);
        out.put("readGraceSeconds", r.graceSeconds);
        out.put("revision", r.revision);
        return out;
    }

    public Map<String, Object> snapshot(GuestPrincipal p, String id, long after, Long revision) {
        Room r = authorized(p, id);
        backfillRecipients(r);
        if (revision != null && revision != r.revision) {
            throw new Problem(
                409,
                "resynchronize",
                "The conversation changed. Refreshing its state."
            );
        }
        List<MessageRecord> available = db
            .messages(id)
            .stream()
            .filter(m -> available(r, m) && eligible(m, p.guestId()))
            .toList();
        List<MessageRecord> page = available
            .stream()
            .filter(m -> m.sequence > after)
            .limit(100)
            .toList();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("room", summary(r));
        out.put("serverTime", clock.instant());
        out.put("revision", r.revision);
        out.put("availableCount", available.size());
        out.put(
            "messages",
            page
                .stream()
                .map(m -> view(r, m, p.guestId()))
                .toList()
        );
        long end = page.isEmpty() ? after : page.getLast().sequence;
        out.put("nextCursor", available.stream().anyMatch(m -> m.sequence > end) ? end : null);
        return out;
    }

    public Map<String, Object> send(GuestPrincipal p, String room, String operation, String body) {
        Room r = authorized(p, room);
        backfillRecipients(r);
        if (operation == null || !operation.matches("[A-Za-z0-9-]{16,80}")) {
            throw Problem.invalid("A valid operation identifier is required.");
        }
        // Retrying an operation returns its original result, even after its body has expired.
        MessageRecord old = db.operation(room, p.guestId(), operation);
        if (old != null) {
            Map<String, Object> v = view(r, old, p.guestId());
            events.publish(List.of(p.guestId()), "message.accepted", room, r.revision, v);
            return v;
        }
        active(r);
        if (!r.state.equals("active") || participants(room).size() < 2) {
            throw new Problem(409, "waiting", "Wait for someone to join before sending.");
        }
        if (body == null || body.isBlank() || body.codePointCount(0, body.length()) > 2000) {
            throw Problem.invalid("Messages must contain 1–2000 characters.");
        }
        if (
            r.acceptedCount >= policy.maxSends ||
            db
                .messages(room)
                .stream()
                .filter(m -> available(r, m))
                .count() >= policy.maxMessages
        ) {
            throw new Problem(
                409,
                "capacity_reached",
                "Message capacity reached. Wait for messages to disappear."
            );
        }
        rates.check("send:" + p.guestId(), policy.sendsPerMinute + 5);
        MessageRecord m = new MessageRecord();
        m.id = UUID.randomUUID().toString();
        m.roomId = room;
        m.senderId = p.guestId();
        m.operationId = operation;
        m.sequence = r.nextSequence++;
        m.acceptedAt = clock.instant();
        m.hardExpiry = min(m.acceptedAt.plusSeconds(r.ttlSeconds), r.expiresAt);
        m.disappearsAt = m.hardExpiry;
        m.revision = ++r.revision;
        r.acceptedCount++;
        db.save(m);
        captureRecipients(r, m, false);
        MessageContent content = new MessageContent();
        content.id = m.id;
        content.body = body;
        db.save(content);
        Map<String, Object> v = view(r, m, p.guestId());
        emitMessage(r, m, "message.accepted", v);
        return v;
    }

    public Map<String, Object> receipt(GuestPrincipal p, String room, String id, boolean seen) {
        Room r = authorized(p, room);
        MessageRecord m = db.find(MessageRecord.class, id);
        if (m == null || !m.roomId.equals(room) || m.senderId.equals(p.guestId())) {
            throw Problem.unavailable();
        }
        backfillRecipients(r);
        List<MessageRecipient> audience = db.recipients(id);
        MessageRecipient receipt = audience
            .stream()
            .filter(a -> a.guestId.equals(p.guestId()))
            .findFirst()
            .orElseThrow(Problem::unavailable);
        if (!available(r, m)) {
            return Map.of("id", id, "available", false);
        }
        boolean changed = false;
        if (receipt.deliveredAt == null) {
            receipt.deliveredAt = clock.instant();
            changed = true;
            if (m.deliveredAt == null) {
                m.deliveredAt = receipt.deliveredAt;
            }
        }
        if (seen && receipt.seenAt == null) {
            receipt.seenAt = clock.instant();
            changed = true;
        }
        // Later joins never change this frozen audience or extend an existing deadline.
        if (
            m.seenAt == null &&
            !audience.isEmpty() &&
            audience.stream().allMatch(a -> a.seenAt != null)
        ) {
            m.seenAt = clock.instant();
            m.disappearsAt = min(m.hardExpiry, m.seenAt.plusSeconds(r.graceSeconds));
        }
        if (changed) {
            m.revision = ++r.revision;
            emitMessage(r, m, seen ? "message.seen" : "message.delivered", metadata(m));
        }
        return view(r, m, p.guestId());
    }

    public void leave(GuestPrincipal p, String id) {
        Room r = authorized(p, id);
        backfillRecipients(r);
        Membership membership = db
            .members(id)
            .stream()
            .filter(m -> m.guestId.equals(p.guestId()))
            .findFirst()
            .orElseThrow();
        membership.leftAt = clock.instant();
        db.entityManager().flush();
        List<Membership> remaining = db.members(id);
        r.revision++;
        events.publish(List.of(p.guestId()), "room.left", id, r.revision, Map.of());
        if (remaining.isEmpty()) {
            r.closedAt = clock.instant();
            r.state = "closed";
            removeAll(r, "room_closed");
            db.entityManager()
                .createQuery("update Invitation set revokedAt=:n where roomId=:r")
                .setParameter("n", clock.instant())
                .setParameter("r", id)
                .executeUpdate();
        } else {
            if (r.creatorId.equals(p.guestId())) {
                r.creatorId = remaining.getFirst().guestId;
                // The new creator can issue their own invitation.
                db.entityManager()
                    .createQuery("update Invitation set revokedAt=:n where roomId=:r")
                    .setParameter("n", clock.instant())
                    .setParameter("r", id)
                    .executeUpdate();
            }
            emit(r, "room.updated", Map.of());
        }
    }

    public void close(GuestPrincipal p, String id) {
        Room r = authorized(p, id);
        if (!r.creatorId.equals(p.guestId())) {
            throw new Problem(
                403,
                "creator_required",
                "Only the creator can end this chat for everyone."
            );
        }
        if (r.closedAt == null) {
            r.closedAt = clock.instant();
            r.state = "closed";
            r.revision++;
            removeAll(r, "room_closed");
            db.entityManager()
                .createQuery(
                    "update Invitation set revokedAt=:n where roomId=:r and revokedAt is null"
                )
                .setParameter("n", clock.instant())
                .setParameter("r", id)
                .executeUpdate();
            emit(r, "room.closed", Map.of());
        }
    }

    private boolean available(Room r, MessageRecord m) {
        return live(r) && m.removedAt == null && m.disappearsAt.isAfter(clock.instant());
    }

    private Map<String, Object> metadata(MessageRecord m) {
        List<MessageRecipient> recipients = db.recipients(m.id);
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("id", m.id);
        v.put("roomId", m.roomId);
        v.put("senderId", m.senderId);
        v.put("operationId", m.operationId);
        v.put("sequence", m.sequence);
        v.put("acceptedAt", m.acceptedAt);
        v.put("disappearsAt", m.disappearsAt);
        v.put("deliveredAt", m.deliveredAt);
        v.put("seenAt", m.seenAt);
        v.put("revision", m.revision);
        v.put(
            "recipientIds",
            recipients
                .stream()
                .map(a -> a.guestId)
                .toList()
        );
        v.put(
            "deliveredGuestIds",
            recipients
                .stream()
                .filter(a -> a.deliveredAt != null)
                .map(a -> a.guestId)
                .toList()
        );
        v.put(
            "seenGuestIds",
            recipients
                .stream()
                .filter(a -> a.seenAt != null)
                .map(a -> a.guestId)
                .toList()
        );
        v.put("recipientCount", recipients.size());
        v.put(
            "deliveredCount",
            recipients
                .stream()
                .filter(a -> a.deliveredAt != null)
                .count()
        );
        v.put(
            "seenCount",
            recipients
                .stream()
                .filter(a -> a.seenAt != null)
                .count()
        );
        return v;
    }

    private Map<String, Object> view(Room r, MessageRecord m, String guest) {
        Map<String, Object> v = metadata(m);
        boolean a = available(r, m) && eligible(m, guest);
        MessageContent c = a ? db.find(MessageContent.class, m.id) : null;
        v.put("available", a && c != null);
        if (a && c != null) {
            v.put("body", c.body);
        }
        return v;
    }

    private boolean eligible(MessageRecord m, String guest) {
        return (
            m.senderId.equals(guest) ||
            db
                .recipients(m.id)
                .stream()
                .anyMatch(a -> a.guestId.equals(guest))
        );
    }

    // Freeze recipients at send time; legacy pair messages belong only to the first two slots.
    private void captureRecipients(Room r, MessageRecord m, boolean legacy) {
        for (Membership member : db.members(r.id)) {
            if (!member.guestId.equals(m.senderId) && (!legacy || member.slot <= 2)) {
                MessageRecipient receipt = new MessageRecipient();
                receipt.id = UUID.randomUUID().toString();
                receipt.messageId = m.id;
                receipt.guestId = member.guestId;
                if (legacy) {
                    receipt.deliveredAt = m.deliveredAt;
                    receipt.seenAt = m.seenAt;
                }
                db.save(receipt);
            }
        }
    }

    private void backfillRecipients(Room r) {
        for (MessageRecord m : db.messages(r.id)) {
            if (db.recipients(m.id).isEmpty()) {
                captureRecipients(r, m, true);
            }
        }
    }

    public void migrateGroupReceipts() {
        List<String> ids = db
            .entityManager()
            .createQuery(
                "select r.id from Room r where exists (select m.id from MessageRecord m where m.roomId=r.id and not exists (select a.id from MessageRecipient a where a.messageId=m.id)) order by r.id",
                String.class
            )
            .getResultList();
        for (String id : ids) {
            Room r = db.room(id);
            if (r != null) {
                backfillRecipients(r);
            }
        }
    }

    private void emitMessage(Room r, MessageRecord m, String type, Map<String, Object> data) {
        List<String> audience = new ArrayList<>(
            db
                .recipients(m.id)
                .stream()
                .map(a -> a.guestId)
                .toList()
        );
        audience.add(m.senderId);
        audience.retainAll(participants(r.id));
        events.publish(audience, type, r.id, r.revision, data);
        List<String> others = participants(r.id)
            .stream()
            .filter(g -> !audience.contains(g))
            .toList();
        if (!others.isEmpty()) {
            events.publish(others, "room.updated", r.id, r.revision, Map.of());
        }
    }

    private void emit(Room r, String type, Map<String, Object> data) {
        events.publish(participants(r.id), type, r.id, r.revision, data);
    }

    private Instant min(Instant a, Instant b) {
        return a.isBefore(b) ? a : b;
    }

    // Erase content immediately, retaining metadata briefly for retries and removal events.
    private void remove(Room r, MessageRecord m, String reason) {
        MessageContent c = db.find(MessageContent.class, m.id);
        if (c != null) {
            db.entityManager().remove(c);
        }
        if (m.removedAt == null) {
            m.removedAt = clock.instant();
            m.removalReason = reason;
            m.revision = ++r.revision;
            emitMessage(r, m, "message.removed", Map.of("id", m.id, "reason", reason));
        }
    }

    private void removeAll(Room r, String reason) {
        for (MessageRecord m : db.messages(r.id)) {
            remove(r, m, reason);
        }
    }

    @Transactional(
        readOnly = true,
        propagation = org.springframework.transaction.annotation.Propagation.REQUIRES_NEW
    )
    public boolean canPublishBody(GuestPrincipal p, String room, String message) {
        if (p == null || identity.byDigest(p.credentialDigest()) == null) {
            return false;
        }
        Room r = db.find(Room.class, room);
        MessageRecord m = db.find(MessageRecord.class, message);
        return (
            r != null &&
            m != null &&
            m.roomId.equals(room) &&
            participants(room).contains(p.guestId()) &&
            eligible(m, p.guestId()) &&
            available(r, m)
        );
    }

    public List<String> roomIds() {
        return db
            .entityManager()
            .createQuery(
                "select r.id from Room r where r.closedAt<=:purge or r.expiresAt<=:purge or (r.expiresAt<=:now and r.state<>'expired') or exists (select m.id from MessageRecord m where m.roomId=r.id and m.removedAt is null and m.disappearsAt<=:now)",
                String.class
            )
            .setParameter("now", clock.instant())
            .setParameter("purge", clock.instant().minus(policy.metadataRetention))
            .setMaxResults(1000)
            .getResultList();
    }

    public void cleanupRoom(String id) {
        Room r = db.room(id);
        if (r == null) {
            return;
        }
        if (!live(r)) {
            if (r.closedAt == null && !r.state.equals("expired")) {
                r.state = "expired";
                r.revision++;
                emit(r, "room.closed", Map.of());
            }
            removeAll(r, "room_expired");
            Instant end = r.closedAt == null ? r.expiresAt : r.closedAt;
            if (!end.plus(policy.metadataRetention).isAfter(clock.instant())) {
                for (String entity : List.of(
                    "MessageContent",
                    "MessageRecipient",
                    "MessageRecord",
                    "Invitation",
                    "Membership"
                )) {
                    String query = entity.equals("MessageContent")
                        ? "delete from MessageContent where id in (select id from MessageRecord where roomId=:r)"
                        : entity.equals("MessageRecipient")
                          ? "delete from MessageRecipient where messageId in (select id from MessageRecord where roomId=:r)"
                          : "delete from " + entity + " where roomId=:r";
                    db.entityManager().createQuery(query).setParameter("r", id).executeUpdate();
                }
                db.entityManager().remove(r);
            }
        } else {
            for (MessageRecord m : db.messages(id)) {
                if (!m.disappearsAt.isAfter(clock.instant())) {
                    remove(r, m, m.seenAt == null ? "ttl_expired" : "read_complete");
                }
            }
        }
    }

    public void cleanupIdentities() {
        Instant now = clock.instant();
        db.entityManager()
            .createQuery("delete from Invitation where consumedAt is null and expiresAt<=:n")
            .setParameter("n", now)
            .executeUpdate();
        db.entityManager()
            .createQuery("delete from Credential where expiresAt<=:n or revokedAt is not null")
            .setParameter("n", now)
            .executeUpdate();
        db.entityManager()
            .createQuery(
                "delete from Guest where expiresAt<=:n and id not in (select guestId from Membership)"
            )
            .setParameter("n", now)
            .executeUpdate();
    }
}
