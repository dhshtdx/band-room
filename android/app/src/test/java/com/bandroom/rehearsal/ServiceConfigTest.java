package com.bandroom.rehearsal;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ServiceConfigTest {

    @Test
    public void portIsStable() {
        assertEquals(4173, ServiceConfig.PORT);
        assertEquals("http://127.0.0.1:4173/api/health", ServiceConfig.healthUrl());
        assertEquals("http://127.0.0.1:4173/api/internal/shutdown", ServiceConfig.shutdownUrl());
        assertEquals("http://127.0.0.1:4173/host", ServiceConfig.hostUrl());
    }

    @Test
    public void shutdownTokensAreRandomAndUrlSafe() {
        String first = ServiceConfig.newShutdownToken();
        String second = ServiceConfig.newShutdownToken();
        assertFalse(first.equals(second));
        assertEquals(43, first.length());
        assertTrue(first.matches("[A-Za-z0-9_-]+"));
    }
}
