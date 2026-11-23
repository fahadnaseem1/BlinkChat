package com.blinkchat.service;

import java.util.*;

/** A client-safe error shared by the HTTP and WebSocket response paths. */
public class Problem extends RuntimeException {

    public final int status;
    public final String category;

    public Problem(int s, String c, String m) {
        super(m);
        status = s;
        category = c;
    }

    public Map<String, Object> payload() {
        return Map.of(
            "category",
            category,
            "message",
            getMessage(),
            "correlationId",
            UUID.randomUUID().toString()
        );
    }

    public static Problem unavailable() {
        return new Problem(404, "unavailable", "This conversation is unavailable.");
    }

    public static Problem invalid(String m) {
        return new Problem(400, "invalid_input", m);
    }
}
