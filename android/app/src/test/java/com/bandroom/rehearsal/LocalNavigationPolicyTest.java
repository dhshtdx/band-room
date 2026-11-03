package com.bandroom.rehearsal;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class LocalNavigationPolicyTest {

    private final LocalNavigationPolicy policy = new LocalNavigationPolicy(4173);

    @Test
    public void allowsLocalHostConsole() {
        assertTrue(policy.isAllowed("http://127.0.0.1:4173/host"));
        assertTrue(policy.isAllowed("http://127.0.0.1:4173/join?room=1234567"));
        assertTrue(policy.isAllowed("http://localhost:4173/host"));
    }

    @Test
    public void rejectsWrongPort() {
        assertFalse(policy.isAllowed("http://127.0.0.1:4174/host"));
    }

    @Test
    public void rejectsLanAndExternalHosts() {
        assertFalse(policy.isAllowed("http://192.168.1.7:4173/host"));
        assertFalse(policy.isAllowed("http://example.com/"));
        assertFalse(policy.isAllowed("https://127.0.0.1:4173/host"));
    }

    @Test
    public void rejectsFileAndContentSchemes() {
        assertFalse(policy.isAllowed("file:///etc/passwd"));
        assertFalse(policy.isAllowed("content://com.android.providers/1"));
        assertFalse(policy.isAllowed("javascript:alert(1)"));
    }

    @Test
    public void blankAndDataUrlsPassThrough() {
        assertTrue(policy.shouldNavigate("about:blank"));
        assertTrue(policy.shouldNavigate("data:text/plain,hi"));
        assertTrue(policy.shouldNavigate(null));
    }

    @Test
    public void buildsHostUrlFromPort() {
        assertTrue(policy.hostUrl().equals("http://127.0.0.1:4173/host"));
    }
}
