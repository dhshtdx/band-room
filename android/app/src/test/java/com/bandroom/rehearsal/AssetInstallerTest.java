package com.bandroom.rehearsal;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AssetInstallerTest {

    @Test
    public void runtimeDirIsVersioned() {
        assertEquals("run-1.0.4-10004", AssetInstaller.runtimeDirName("1.0.4", 10004));
    }

    @Test
    public void versionNameIsSanitized() {
        assertEquals("run-1.0.4_beta-7", AssetInstaller.runtimeDirName("1.0.4/beta", 7));
        assertEquals("run-0-0", AssetInstaller.runtimeDirName(null, 0));
    }

    @Test
    public void differentVersionsYieldDifferentDirectories() {
        assertFalse(AssetInstaller.runtimeDirName("1.0.4", 10004)
                .equals(AssetInstaller.runtimeDirName("1.0.5", 10005)));
    }
}
