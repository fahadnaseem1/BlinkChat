package com.blinkchat.identity;

import java.security.Principal;

/** Stable guest identity; display names are never used to authorize access. */
public record GuestPrincipal(String guestId, String credentialDigest) implements Principal {
    public String getName() {
        return guestId;
    }
}
