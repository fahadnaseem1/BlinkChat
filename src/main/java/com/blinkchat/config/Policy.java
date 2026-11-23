package com.blinkchat.config;

import java.time.*;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.*;

/** Limits and lifetimes bound from the blink.* application properties. */
@Configuration
@ConfigurationProperties(prefix = "blink")
public class Policy {

    public Duration roomLifetime = Duration.ofHours(24);
    public Duration credentialLifetime = Duration.ofHours(24);
    public Duration inviteLifetime = Duration.ofMinutes(15);
    public Duration metadataRetention = Duration.ofHours(1);
    public int maxRooms = 5;
    public int maxMessages = 200;
    public int maxSends = 2000;
    public int sendsPerMinute = 30;
    public int maxConnections = 5;
    public int maxParticipants = 20;
    public boolean secureCookie = false;
    public String origin = "http://localhost:8080";
    public void setOrigin(String origin) {
        this.origin = origin;
    }

    public void setSecureCookie(boolean secureCookie) {
        this.secureCookie = secureCookie;
    }

    public void setRoomLifetime(Duration roomLifetime) {
        this.roomLifetime = roomLifetime;
    }

    public void setCredentialLifetime(Duration credentialLifetime) {
        this.credentialLifetime = credentialLifetime;
    }

    public void setInviteLifetime(Duration inviteLifetime) {
        this.inviteLifetime = inviteLifetime;
    }

    public void setMetadataRetention(Duration metadataRetention) {
        this.metadataRetention = metadataRetention;
    }

    public void setMaxRooms(int maxRooms) {
        this.maxRooms = maxRooms;
    }

    public void setMaxMessages(int maxMessages) {
        this.maxMessages = maxMessages;
    }

    public void setMaxSends(int maxSends) {
        this.maxSends = maxSends;
    }

    public void setSendsPerMinute(int sendsPerMinute) {
        this.sendsPerMinute = sendsPerMinute;
    }

    public void setMaxConnections(int maxConnections) {
        this.maxConnections = maxConnections;
    }

    public void setMaxParticipants(int maxParticipants) {
        if (maxParticipants < 2 || maxParticipants > 100) {
            throw new IllegalArgumentException("max-participants must be between 2 and 100");
        }
        this.maxParticipants = maxParticipants;
    }

    @Bean
    public Clock clock() {
        return Clock.systemUTC();
    }
}
