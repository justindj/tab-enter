import { detectClaude, detectRtk } from '@tab-enter/claude';
import { saveToolStatus, type Db } from '@tab-enter/db';

export async function detectTools(db: Db): Promise<void> {
  const [claude, rtk] = await Promise.all([detectClaude(), detectRtk()]);
  await saveToolStatus(db, claude);
  await saveToolStatus(db, rtk);
}
