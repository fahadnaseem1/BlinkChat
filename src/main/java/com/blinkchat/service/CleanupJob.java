package com.blinkchat.service;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class CleanupJob implements ApplicationRunner {

    private final ChatService chat;

    public CleanupJob(ChatService c) {
        chat = c;
    }

    public void run(ApplicationArguments args) {
        chat.migrateGroupReceipts();
        clean();
    }

    // Isolate room failures so one bad cleanup does not block the rest of the batch.
    @Scheduled(fixedDelayString = "${blink.cleanup-ms:5000}")
    public void clean() {
        for (String id : chat.roomIds()) {
            try {
                chat.cleanupRoom(id);
            } catch (RuntimeException e) {
                org.slf4j.LoggerFactory.getLogger(getClass()).warn(
                    "Room cleanup failed; retrying next batch"
                );
            }
        }
        chat.cleanupIdentities();
    }
}
