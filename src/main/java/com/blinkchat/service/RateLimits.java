package com.blinkchat.service;

import java.time.Clock;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

@Component
public class RateLimits {

    private record Window(long minute, int count) {}

    private final ConcurrentHashMap<String, Window> windows = new ConcurrentHashMap<>();
    private final Clock clock;

    public RateLimits(Clock c) {
        clock = c;
    }

    public void check(String key, int limit) {
        long minute = clock.millis() / 60000;
        // Update each key atomically so concurrent requests cannot bypass its minute limit.
        windows.compute(key, (k, w) -> {
            if (w == null || w.minute != minute) {
                return new Window(minute, 1);
            }
            if (w.count >= limit) {
                throw new Problem(429, "rate_limited", "Too many requests. Try again in a minute.");
            }
            return new Window(minute, w.count + 1);
        });
        if (windows.size() > 10000) {
            windows.entrySet().removeIf(e -> e.getValue().minute < minute);
        }
    }
}
