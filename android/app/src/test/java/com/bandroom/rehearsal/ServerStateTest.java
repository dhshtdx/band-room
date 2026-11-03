package com.bandroom.rehearsal;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ServerStateTest {

    @Test
    public void startsFromIdle() {
        ServerState state = new ServerState();
        assertEquals(ServerState.State.IDLE, state.get());
        assertTrue(state.beginStart());
        assertEquals(ServerState.State.STARTING, state.get());
    }

    @Test
    public void suppressesDuplicateStart() {
        ServerState state = new ServerState();
        assertTrue(state.beginStart());
        assertFalse(state.beginStart());
        assertTrue(state.markRunning());
        assertFalse(state.beginStart());
    }

    @Test
    public void onlyStartingCanBecomeRunning() {
        ServerState state = new ServerState();
        assertFalse(state.markRunning());
        state.beginStart();
        assertTrue(state.markRunning());
        assertEquals(ServerState.State.RUNNING, state.get());
    }

    @Test
    public void failureIsRetryable() {
        ServerState state = new ServerState();
        state.beginStart();
        assertTrue(state.markFailed());
        assertEquals(ServerState.State.FAILED, state.get());
        assertTrue(state.beginStart());
    }

    @Test
    public void stopThenRestart() {
        ServerState state = new ServerState();
        state.beginStart();
        state.markRunning();
        assertTrue(state.markStopped());
        assertEquals(ServerState.State.STOPPED, state.get());
        assertTrue(state.beginStart());
        assertTrue(state.markRunning());
    }

    @Test
    public void activeOnlyDuringStartOrRun() {
        ServerState state = new ServerState();
        assertFalse(state.isActive());
        state.beginStart();
        assertTrue(state.isActive());
        state.markRunning();
        assertTrue(state.isActive());
        state.markStopped();
        assertFalse(state.isActive());
    }
}
