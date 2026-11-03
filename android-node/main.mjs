import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

if (!process.env.BAND_ROOM_DATA_DIR) throw new Error('缺少 BAND_ROOM_DATA_DIR');
if (!process.env.BAND_ROOM_SHUTDOWN_TOKEN) throw new Error('缺少 BAND_ROOM_SHUTDOWN_TOKEN');
process.env.BAND_ROOM_ANDROID = '1';
process.env.NODE_ENV = 'production';

const videosDir = join(process.env.BAND_ROOM_DATA_DIR, 'videos');
try {
  for (const file of await readdir(videosDir)) {
    if (file.endsWith('.upload') || file.endsWith('.tmp')) await rm(join(videosDir, file), { force: true });
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const { serverReady } = await import('./server/index.js');
await serverReady;
