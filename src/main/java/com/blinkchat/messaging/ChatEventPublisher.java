package com.blinkchat.messaging;

import java.time.*;
import java.util.*;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.*;

@Component
public class ChatEventPublisher {

    public record Committed(List<String> guests, Map<String, Object> event) {}

    private final ApplicationEventPublisher events;
    private final SimpMessagingTemplate socket;
    private final Clock clock;

    public ChatEventPublisher(
        ApplicationEventPublisher e,
        @org.springframework.context.annotation.Lazy SimpMessagingTemplate s,
        Clock c
    ) {
        events = e;
        socket = s;
        clock = c;
    }

    public void publish(
        List<String> guests,
        String type,
        String room,
        long revision,
        Map<String, Object> data
    ) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("eventId", UUID.randomUUID().toString());
        event.put("type", type);
        event.put("roomId", room);
        event.put("revision", revision);
        event.put("serverTime", clock.instant());
        event.put("data", data);
        events.publishEvent(new Committed(List.copyOf(guests), event));
    }

    // Publish durable changes only after commit, when snapshots can see the same state.
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void committed(Committed e) {
        deliver(e);
    }

    public void deliver(Committed e) {
        for (String guest : e.guests()) {
            try {
                socket.convertAndSendToUser(guest, "/queue/events", e.event());
            } catch (RuntimeException ignored) {
                // A reconnecting client recovers committed changes from a snapshot.
            }
        }
    }

    public void transientEvent(
        List<String> guests,
        String type,
        String room,
        Map<String, Object> data
    ) {
        deliver(
            new Committed(
                guests,
                Map.of("type", type, "roomId", room, "serverTime", clock.instant(), "data", data)
            )
        );
    }
}
