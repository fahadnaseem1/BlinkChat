package com.blinkchat.identity;

import com.blinkchat.config.Policy;
import com.blinkchat.model.Records.*;
import com.blinkchat.repository.ChatRepository;
import com.blinkchat.service.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.time.*;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional
public class GuestIdentityService {

    private final ChatRepository db;
    private final Clock clock;
    private final Policy policy;

    public GuestIdentityService(ChatRepository d, Clock c, Policy p) {
        db = d;
        clock = c;
        policy = p;
    }

    public static String secret() {
        byte[] b = new byte[32];
        new SecureRandom().nextBytes(b);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    // Store hashes rather than the reusable secrets carried by guest cookies and invitations.
    public static String digest(String raw) {
        try {
            return HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(raw.getBytes(StandardCharsets.UTF_8))
            );
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public GuestPrincipal resolve(String raw) {
        return raw == null ? null : byDigest(digest(raw));
    }

    public GuestPrincipal byDigest(String hash) {
        Credential c = db.find(Credential.class, hash);
        if (c == null || c.revokedAt != null || !c.expiresAt.isAfter(clock.instant())) {
            return null;
        }
        Guest g = db.find(Guest.class, c.guestId);
        return g != null && g.expiresAt.isAfter(clock.instant())
            ? new GuestPrincipal(g.id, c.digest)
            : null;
    }

    public void require(GuestPrincipal p) {
        if (p == null || byDigest(p.credentialDigest()) == null) {
            throw new Problem(
                401,
                "session_expired",
                "Your guest session has ended. Choose a name to start again."
            );
        }
    }

    public record Established(GuestPrincipal principal, String secret) {}

    public Established establish(GuestPrincipal p, String name) {
        if (p != null) {
            require(p);
            return new Established(p, null);
        }
        name = validateName(name);
        Instant now = clock.instant();
        Guest g = new Guest();
        g.id = UUID.randomUUID().toString();
        g.displayName = name;
        g.createdAt = now;
        g.expiresAt = now.plus(policy.credentialLifetime);
        db.save(g);
        String raw = secret();
        Credential c = new Credential();
        c.digest = digest(raw);
        c.guestId = g.id;
        c.expiresAt = g.expiresAt;
        db.save(c);
        return new Established(new GuestPrincipal(g.id, c.digest), raw);
    }

    public Map<String, Object> me(GuestPrincipal p) {
        require(p);
        Guest g = db.find(Guest.class, p.guestId());
        return Map.of("id", g.id, "displayName", g.displayName, "expiresAt", g.expiresAt);
    }

    public Map<String, Object> rename(GuestPrincipal p, String name) {
        require(p);
        db.find(Guest.class, p.guestId()).displayName = validateName(name);
        return me(p);
    }

    public void revoke(GuestPrincipal p) {
        require(p);
        db.find(Credential.class, p.credentialDigest()).revokedAt = clock.instant();
    }

    private String validateName(String n) {
        if (n == null) {
            throw Problem.invalid("Choose a display name.");
        }
        n = n.strip();
        if (
            n.codePointCount(0, n.length()) < 2 ||
            n.codePointCount(0, n.length()) > 30 ||
            n
                .codePoints()
                .anyMatch(
                    c -> Character.isISOControl(c) || Character.getType(c) == Character.FORMAT
                )
        ) {
            throw Problem.invalid("Use 2–30 visible characters for your name.");
        }
        return n;
    }
}
