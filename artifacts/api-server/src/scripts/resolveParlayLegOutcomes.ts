/**
 * resolveParlayLegOutcomes.ts
 *
 * Fills in actual_winner_id on parlay_leg_outcomes rows where the match has
 * since appeared in historical_matches.
 *
 * Matching logic:
 *   A historical_matches row is linked to a parlay leg when:
 *     - One player pair matches (either orientation: sel/opp or opp/sel), AND
 *     - The match was scheduled AFTER the leg was created (avoids back-filling
 *       past history as the "outcome" of a future pick).
 *
 * Run daily, or on-demand:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/resolveParlayLegOutcomes.ts
 *
 * Safe to run multiple times — already-resolved rows are skipped.
 */

import { pool } from "@workspace/db";

interface UnresolvedLeg {
  id: number;
  selected_player_id: string;
  opponent_id: string;
  selected_player_name: string;
  opponent_name: string;
  created_at: Date;
}

interface MatchRow {
  player1_id: string;
  player2_id: string;
  winner_id: string;
  scheduled_start_at: Date | null;
  player1_name: string;
  player2_name: string;
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    // ── 1. Load all unresolved legs ─────────────────────────────────────────
    const { rows: legs } = await client.query<UnresolvedLeg>(`
      SELECT id, selected_player_id, opponent_id,
             selected_player_name, opponent_name, created_at
      FROM parlay_leg_outcomes
      WHERE actual_winner_id IS NULL
      ORDER BY created_at ASC
    `);

    if (legs.length === 0) {
      console.log("No unresolved legs — nothing to do.");
      return;
    }

    console.log(`Found ${legs.length} unresolved leg(s). Looking for matches…`);

    // ── 2. Collect all unique player-pair combinations ──────────────────────
    // Normalise pair as (lesser_id, greater_id) so one query covers both orientations.
    const pairSet = new Set<string>();
    for (const leg of legs) {
      const a = leg.selected_player_id < leg.opponent_id ? leg.selected_player_id : leg.opponent_id;
      const b = leg.selected_player_id < leg.opponent_id ? leg.opponent_id : leg.selected_player_id;
      pairSet.add(`${a}::${b}`);
    }

    // Build arrays for the ANY(...) IN query
    const p1s: string[] = [];
    const p2s: string[] = [];
    for (const pair of pairSet) {
      const [a, b] = pair.split("::");
      p1s.push(a!);
      p2s.push(b!);
    }

    // Find all historical_matches for those pairs (either orientation in the DB)
    const { rows: matches } = await client.query<MatchRow>(`
      SELECT player1_id, player2_id, winner_id, scheduled_start_at,
             player1_name, player2_name
      FROM historical_matches
      WHERE
        (player1_id = ANY($1::text[]) AND player2_id = ANY($2::text[]))
        OR
        (player1_id = ANY($2::text[]) AND player2_id = ANY($1::text[]))
      ORDER BY scheduled_start_at ASC
    `, [p1s, p2s]);

    console.log(`  Found ${matches.length} candidate historical match(es) for those player pairs.`);

    // ── 3. Resolve each unresolved leg ──────────────────────────────────────
    let resolved = 0;
    let ambiguous = 0;
    let unmatched = 0;

    for (const leg of legs) {
      const legCreatedAt = new Date(leg.created_at);

      // All matches between this leg's players that occurred AFTER the leg was created
      const candidates = matches.filter(m => {
        const isThisPair =
          (m.player1_id === leg.selected_player_id && m.player2_id === leg.opponent_id) ||
          (m.player1_id === leg.opponent_id && m.player2_id === leg.selected_player_id);
        if (!isThisPair) return false;

        // Only consider matches that happened after the leg was logged.
        // Allow up to a 1-hour buffer to handle slight clock skew between
        // when the leg was written and when the fixture was actually played.
        if (m.scheduled_start_at == null) return false;
        const matchDate = new Date(m.scheduled_start_at);
        return matchDate >= new Date(legCreatedAt.getTime() - 60 * 60 * 1000);
      });

      if (candidates.length === 0) {
        unmatched++;
        continue;
      }

      if (candidates.length > 1) {
        // Multiple matches between the same pair after the leg was created.
        // Use the chronologically earliest one (the next match after the leg).
        candidates.sort((a, b) => {
          const da = a.scheduled_start_at ? new Date(a.scheduled_start_at).getTime() : 0;
          const db = b.scheduled_start_at ? new Date(b.scheduled_start_at).getTime() : 0;
          return da - db;
        });
        ambiguous++;
        console.log(`  Leg ${leg.id} (${leg.selected_player_name} vs ${leg.opponent_name}): ` +
          `${candidates.length} candidate matches — using earliest (${candidates[0]!.scheduled_start_at?.toISOString().slice(0, 10)})`);
      }

      const match = candidates[0]!;
      await client.query(
        `UPDATE parlay_leg_outcomes
         SET actual_winner_id = $1, resolved_at = now()
         WHERE id = $2`,
        [match.winner_id, leg.id]
      );
      resolved++;
      console.log(`  ✓ Leg ${leg.id}: ${leg.selected_player_name} vs ${leg.opponent_name} → winner_id=${match.winner_id}`);
    }

    // ── 4. Summary ──────────────────────────────────────────────────────────
    console.log(`\nDone.`);
    console.log(`  Resolved:    ${resolved}`);
    console.log(`  Unmatched:   ${unmatched} (match not yet in historical_matches)`);
    console.log(`  Ambiguous:   ${ambiguous} (multiple matches found — picked earliest)`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error("Resolution job failed:", err);
  process.exit(1);
});
