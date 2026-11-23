package com.blinkchat.controller;

import com.blinkchat.identity.GuestPrincipal;
import com.blinkchat.messaging.Connections;
import com.blinkchat.service.*;
import java.security.Principal;
import java.util.*;
import org.springframework.messaging.handler.annotation.*;
import org.springframework.messaging.simp.annotation.SendToUser;
import org.springframework.stereotype.Controller;

/** Routes authenticated socket commands through the same service rules as HTTP. */
@Controller
public class ChatController {

    private final ChatService chat;
    private final Connections connections;
    private final RateLimits rates;

    public ChatController(ChatService c, Connections x, RateLimits r) {
        chat = c;
        connections = x;
        rates = r;
    }

    public record Command(
        String roomId,
        String operationId,
        String body,
        String messageId,
        Boolean typing
    ) {}

    @MessageMapping("/chat.send")
    public void send(Command c, Principal p) {
        chat.send(Connections.principal(p), c.roomId(), c.operationId(), c.body());
    }

    @MessageMapping("/chat.delivered")
    public void delivered(Command c, Principal p) {
        chat.receipt(Connections.principal(p), c.roomId(), c.messageId(), false);
    }

    @MessageMapping("/chat.seen")
    public void seen(Command c, Principal p) {
        chat.receipt(Connections.principal(p), c.roomId(), c.messageId(), true);
    }

    @MessageMapping("/chat.typing")
    public void typing(Command c, Principal p, @Header("simpSessionId") String session) {
        GuestPrincipal g = Connections.principal(p);
        rates.check("typing:" + g.guestId(), 60);
        connections.typing(g, session, c.roomId(), Boolean.TRUE.equals(c.typing()));
    }

    @MessageExceptionHandler
    @SendToUser(value = "/queue/errors", broadcast = false)
    public Map<String, Object> error(Exception e) {
        if (!(e instanceof Problem)) {
            org.slf4j.LoggerFactory.getLogger(getClass()).warn(
                "Socket command failed: {} at {}",
                e.getClass().getSimpleName(),
                java.util.Arrays.stream(e.getStackTrace())
                    .filter(f -> f.getClassName().startsWith("com.blinkchat"))
                    .findFirst()
                    .orElse(null)
            );
        }
        return e instanceof Problem p
            ? p.payload()
            : new Problem(
                  400,
                  "command_failed",
                  "The command could not be completed. Refresh and try again."
              ).payload();
    }
}
