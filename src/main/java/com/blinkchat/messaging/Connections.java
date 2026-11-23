package com.blinkchat.messaging;

import com.blinkchat.config.Policy;
import com.blinkchat.identity.*;
import com.blinkchat.service.*;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.*;

@Component
public class Connections {

    // Presence and typing are transient; durable membership belongs to ChatService.
    private record Live(WebSocketSession socket, GuestPrincipal guest) {}

    private record Typing(String room, String guest, long until) {}

    private final Map<String, Live> sessions = new ConcurrentHashMap<>();
    private final Map<String, Typing> typing = new ConcurrentHashMap<>();
    private final GuestIdentityService identity;
    private final Policy policy;
    private final ChatService chat;
    private final ChatEventPublisher events;
    private final Clock clock;
    private final RateLimits rates;

    public Connections(
        GuestIdentityService i,
        Policy p,
        ChatService c,
        ChatEventPublisher e,
        Clock clock,
        RateLimits rates
    ) {
        identity = i;
        policy = p;
        chat = c;
        events = e;
        this.clock = clock;
        this.rates = rates;
    }

    public static GuestPrincipal principal(java.security.Principal p) {
        return p instanceof Authentication a && a.getPrincipal() instanceof GuestPrincipal g
            ? g
            : null;
    }

    public synchronized void add(WebSocketSession s) throws Exception {
        GuestPrincipal p = principal(s.getPrincipal());
        identity.require(p);
        if (
            sessions
                .values()
                .stream()
                .filter(v -> v.guest.guestId().equals(p.guestId()))
                .count() >= policy.maxConnections
        ) {
            s.close(CloseStatus.POLICY_VIOLATION);
            return;
        }
        sessions.put(s.getId(), new Live(s, p));
        presence(p);
    }

    public void remove(String id) {
        Live l = sessions.remove(id);
        Set<String> affected = new HashSet<>();
        typing.entrySet().removeIf(e -> {
            if (e.getKey().startsWith(id + ":")) {
                affected.add(e.getValue().room);
                return true;
            }
            return false;
        });
        affected.forEach(this::publishTyping);
        if (l != null) {
            presence(l.guest);
        }
    }

    public void limitCommand(String session, boolean send) {
        Live live = sessions.get(session);
        if (live == null) {
            throw new Problem(401, "session_expired", "Reconnect to continue.");
        }
        String ip =
            live.socket.getRemoteAddress() == null
                ? "unknown"
                : live.socket.getRemoteAddress().getAddress().getHostAddress();
        rates.check((send ? "send-ip:" : "command-ip:") + ip, send ? 300 : 1800);
    }

    public boolean canDeliverBody(String session, String room, String message) {
        Live live = sessions.get(session);
        return live != null && chat.canPublishBody(live.guest, room, message);
    }

    public void reject(String id) {
        Live live = sessions.get(id);
        if (live != null) {
            try {
                live.socket.close(CloseStatus.POLICY_VIOLATION);
            } catch (Exception ignored) {}
            remove(id);
        }
    }

    public boolean valid(String id) {
        Live l = sessions.get(id);
        return l != null && identity.byDigest(l.guest.credentialDigest()) != null;
    }

    public List<String> online(String room) {
        return chat
            .participants(room)
            .stream()
            .filter(g ->
                sessions
                    .values()
                    .stream()
                    .anyMatch(
                        s ->
                            s.guest.guestId().equals(g) &&
                            identity.byDigest(s.guest.credentialDigest()) != null
                    )
            )
            .toList();
    }

    private void presence(GuestPrincipal p) {
        if (identity.byDigest(p.credentialDigest()) == null) {
            return;
        }
        for (Map<String, Object> r : chat.list(p)) {
            String id = (String) r.get("id");
            events.transientEvent(
                chat.participants(id),
                "presence.changed",
                id,
                Map.of("online", online(id))
            );
        }
    }

    public void typing(GuestPrincipal p, String session, String room, boolean active) {
        var authorized = chat.authorized(p, room);
        if (
            !authorized.state.equals("active") ||
            authorized.closedAt != null ||
            !authorized.expiresAt.isAfter(clock.instant())
        ) {
            throw Problem.unavailable();
        }
        String key = session + ":" + room;
        if (active) {
            typing.put(key, new Typing(room, p.guestId(), clock.millis() + 4000));
        } else {
            typing.remove(key);
        }
        publishTyping(room);
    }

    private void publishTyping(String room) {
        List<String> guests = typing
            .values()
            .stream()
            .filter(t -> t.room.equals(room) && t.until > clock.millis())
            .map(t -> t.guest)
            .distinct()
            .toList();
        events.transientEvent(
            chat.participants(room),
            "typing.changed",
            room,
            Map.of("guests", guests)
        );
    }

    @Scheduled(fixedDelay = 1000)
    public void expire() {
        for (var e : sessions.entrySet()) {
            if (identity.byDigest(e.getValue().guest.credentialDigest()) == null) {
                try {
                    e.getValue().socket.close(CloseStatus.POLICY_VIOLATION);
                } catch (Exception ignored) {}
                remove(e.getKey());
            }
        }
        Set<String> rooms = new HashSet<>();
        typing.entrySet().removeIf(e -> {
            if (e.getValue().until <= clock.millis()) {
                rooms.add(e.getValue().room);
                return true;
            }
            return false;
        });
        rooms.forEach(this::publishTyping);
    }

    public void revoke(String digest) {
        for (var e : sessions.entrySet()) {
            if (e.getValue().guest.credentialDigest().equals(digest)) {
                try {
                    e.getValue().socket.close(CloseStatus.POLICY_VIOLATION);
                } catch (Exception ignored) {}
                remove(e.getKey());
            }
        }
    }
}
