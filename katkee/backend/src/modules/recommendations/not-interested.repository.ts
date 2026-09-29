import { query } from "../../db/psql";

export async function markNotInterested(viewerId: string, creatorId: string): Promise<void> {
  await query(
    `INSERT INTO creator_not_interested (viewer_id, creator_id) VALUES (:'viewer_id', :'creator_id')
     ON CONFLICT (viewer_id, creator_id) DO NOTHING`,
    { viewer_id: viewerId, creator_id: creatorId },
  );
}

export async function listNotInterestedCreatorIds(viewerId: string): Promise<string[]> {
  const rows = await query(`SELECT creator_id FROM creator_not_interested WHERE viewer_id = :'viewer_id'`, {
    viewer_id: viewerId,
  });
  return rows.map((r) => r.creator_id as string);
}
