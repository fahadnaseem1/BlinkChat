package com.blinkchat.controller;

import com.blinkchat.config.Policy;
import com.blinkchat.identity.*;
import com.blinkchat.messaging.Connections;
import com.blinkchat.service.*;
import jakarta.servlet.http.*;
import java.util.*;
import org.springframework.http.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.*;

/** HTTP endpoints for guest sessions, invitations, and conversation snapshots. */
@RestController
@RequestMapping("/api")
public class ApiController {

    private final GuestIdentityService identity;
    private final ChatService chat;
    private final Policy policy;
    private final Connections connections;
    private final RateLimits rates;

    public ApiController(
        GuestIdentityService i,
        ChatService c,
        Policy p,
        Connections x,
        RateLimits r
    ) {
        identity = i;
        chat = c;
        policy = p;
        connections = x;
        rates = r;
    }

    public record Name(String displayName) {}

    public record Create(long ttlSeconds, String title, Long readGraceSeconds) {}

    public record Invite(String secret) {}

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "ok");
    }

    @GetMapping("/csrf")
    public Map<String, String> csrf(CsrfToken t) {
        return Map.of("token", t.getToken(), "headerName", t.getHeaderName());
    }

    @PostMapping("/guests")
    public Map<String, Object> guest(
        @AuthenticationPrincipal GuestPrincipal p,
        @RequestBody Name body,
        HttpServletResponse response,
        HttpServletRequest request
    ) {
        rates.check("guest-ip:" + request.getRemoteAddr(), 30);
        var result = identity.establish(p, body.displayName());
        if (result.secret() != null) {
            response.addHeader(
                HttpHeaders.SET_COOKIE,
                ResponseCookie.from("BLINK_GUEST", result.secret())
                    .httpOnly(true)
                    .secure(policy.secureCookie)
                    .sameSite("Strict")
                    .path("/")
                    .maxAge(policy.credentialLifetime)
                    .build()
                    .toString()
            );
        }
        return identity.me(result.principal());
    }

    @GetMapping("/me")
    public Map<String, Object> me(@AuthenticationPrincipal GuestPrincipal p) {
        return identity.me(p);
    }

    @PatchMapping("/me")
    public Map<String, Object> rename(
        @AuthenticationPrincipal GuestPrincipal p,
        @RequestBody Name n
    ) {
        return identity.rename(p, n.displayName());
    }

    @PostMapping("/logout")
    public Map<String, Boolean> logout(
        @AuthenticationPrincipal GuestPrincipal p,
        HttpServletResponse res
    ) {
        identity.revoke(p);
        connections.revoke(p.credentialDigest());
        res.addHeader(
            HttpHeaders.SET_COOKIE,
            ResponseCookie.from("BLINK_GUEST", "")
                .path("/")
                .maxAge(0)
                .httpOnly(true)
                .secure(policy.secureCookie)
                .sameSite("Strict")
                .build()
                .toString()
        );
        return Map.of("ok", true);
    }

    @GetMapping("/rooms")
    public Object rooms(@AuthenticationPrincipal GuestPrincipal p) {
        return chat.list(p);
    }

    @PostMapping("/rooms")
    public Object create(@AuthenticationPrincipal GuestPrincipal p, @RequestBody Create c) {
        return chat.create(p, c.ttlSeconds(), c.title(), c.readGraceSeconds());
    }

    @GetMapping({ "/rooms/{id}", "/rooms/{id}/messages" })
    public Object snapshot(
        @AuthenticationPrincipal GuestPrincipal p,
        @PathVariable String id,
        @RequestParam(defaultValue = "0") long after,
        @RequestParam(required = false) Long revision
    ) {
        Map<String, Object> out = chat.snapshot(p, id, after, revision);
        out.put("online", connections.online(id));
        return out;
    }

    @PostMapping("/rooms/{id}/invites")
    public Object invite(@AuthenticationPrincipal GuestPrincipal p, @PathVariable String id) {
        return chat.invite(p, id);
    }

    @PostMapping("/invites/preview")
    public Object preview(@RequestBody Invite invitation, HttpServletRequest request) {
        rates.check("preview-ip:" + request.getRemoteAddr(), 60);
        return chat.previewInvitation(invitation.secret());
    }

    @GetMapping("/rooms/{id}/operations/{operationId}")
    public Object operationStatus(
        @AuthenticationPrincipal GuestPrincipal principal,
        @PathVariable String id,
        @PathVariable String operationId
    ) {
        return chat.operationStatus(principal, id, operationId);
    }

    @PostMapping("/invites/redeem")
    public Object redeem(@AuthenticationPrincipal GuestPrincipal p, @RequestBody Invite i) {
        return chat.redeem(p, i.secret());
    }

    @PostMapping("/rooms/{id}/leave")
    public Object leave(@AuthenticationPrincipal GuestPrincipal p, @PathVariable String id) {
        chat.leave(p, id);
        return Map.of("ok", true);
    }

    @PostMapping("/rooms/{id}/close")
    public Object close(@AuthenticationPrincipal GuestPrincipal p, @PathVariable String id) {
        chat.close(p, id);
        return Map.of("ok", true);
    }
}
