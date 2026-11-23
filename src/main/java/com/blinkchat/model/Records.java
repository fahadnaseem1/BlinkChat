package com.blinkchat.model;

import jakarta.persistence.*;
import java.time.Instant;

/** Persistence entities. Message bodies are stored separately so cleanup can erase them first. */
public final class Records {

    @Entity(name = "Guest")
    @Table(name = "guests")
    public static class Guest {

        @Id
        public String id;

        public String displayName;
        public Instant createdAt;
        public Instant expiresAt;

        public Guest() {}
    }

    @Entity(name = "Credential")
    @Table(name = "credentials")
    public static class Credential {

        @Id
        public String digest;

        public String guestId;
        public Instant expiresAt;
        public Instant revokedAt;

        public Credential() {}
    }

    @Entity(name = "Room")
    @Table(name = "rooms")
    public static class Room {

        @Id
        public String id;

        public String creatorId;
        public String state;

        @Column(length = 80)
        public String title;

        public Instant createdAt;
        public Instant expiresAt;
        public Instant closedAt;
        public long ttlSeconds;
        public long graceSeconds;
        public long revision;
        public long nextSequence = 1;
        public long acceptedCount;

        public Room() {}
    }

    @Entity(name = "Membership")
    @Table(
        name = "memberships",
        uniqueConstraints = {
            @UniqueConstraint(columnNames = { "roomId", "guestId" }),
            @UniqueConstraint(columnNames = { "roomId", "slot" }),
        }
    )
    public static class Membership {

        @Id
        public String id;

        @Column(nullable = false)
        public String roomId;

        @Column(nullable = false)
        public String guestId;

        @Column(nullable = false)
        public int slot;

        public Instant joinedAt;

        public Membership() {}
    }

    @Entity(name = "Invitation")
    @Table(name = "invitations")
    public static class Invitation {

        @Id
        public String digest;

        public String roomId;
        public String consumedBy;
        public Instant expiresAt;
        public Instant consumedAt;
        public Instant revokedAt;

        public Invitation() {}
    }

    @Entity(name = "MessageRecord")
    @Table(
        name = "message_records",
        uniqueConstraints = {
            @UniqueConstraint(columnNames = { "roomId", "senderId", "operationId" }),
            @UniqueConstraint(columnNames = { "roomId", "sequence" }),
        }
    )
    public static class MessageRecord {

        @Id
        public String id;

        @Column(nullable = false)
        public String roomId;

        @Column(nullable = false)
        public String senderId;

        @Column(nullable = false)
        public String operationId;

        @Column(nullable = false)
        public long sequence;

        public Instant acceptedAt;
        public Instant hardExpiry;
        public Instant disappearsAt;
        public Instant deliveredAt;
        public Instant seenAt;
        public Instant removedAt;
        public String removalReason;
        public long revision;

        public MessageRecord() {}
    }

    @Entity(name = "MessageRecipient")
    @Table(
        name = "message_recipients",
        uniqueConstraints = @UniqueConstraint(columnNames = { "messageId", "guestId" })
    )
    public static class MessageRecipient {

        @Id
        public String id;

        @Column(nullable = false)
        public String messageId;

        @Column(nullable = false)
        public String guestId;

        public Instant deliveredAt;
        public Instant seenAt;

        public MessageRecipient() {}
    }

    @Entity(name = "MessageContent")
    @Table(name = "message_content")
    public static class MessageContent {

        @Id
        public String id;

        @Lob
        public String body;

        public MessageContent() {}
    }
}
