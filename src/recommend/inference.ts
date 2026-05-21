import {
  clamp,
  expectedAchievementFromRating,
  ratingToEstimatedConstant,
} from "./shared";

const RANK_THRESHOLDS = [
  { rank: "SSS+", min: 100.5 },
  { rank: "SSS", min: 100.0 },
  { rank: "SS+", min: 99.5 },
  { rank: "SS", min: 99.0 },
  { rank: "S+", min: 98.0 },
  { rank: "S", min: 97.0 },
  { rank: "AAA", min: 94.0 },
  { rank: "AA", min: 90.0 },
  { rank: "A", min: 80.0 },
  { rank: "B", min: 0 },
];

function getRank(achievement: number): string {
  return RANK_THRESHOLDS.find((r) => achievement >= r.min)?.rank ?? "B";
}

export function buildNmfResponseFromModel(
  modelRecord: any,
  playerKey: string,
  currentRows: any[],
) {
  const payload = modelRecord?.model;
  const players: string[] = payload?.players ?? [];
  const songs: string[] = payload?.songs ?? [];
  const playerFactors: number[][] = payload?.playerFactors ?? [];
  const songFactors: number[][] = payload?.songFactors ?? [];
  const songMeta: Record<string, any> = payload?.song_meta ?? {};
  const playerRatings = new Map<string, number>(
    Object.entries(payload?.player_ratings ?? {}).map(([key, value]) => [
      key,
      Number(value),
    ]),
  );
  const playerIndex = new Map(players.map((id, index) => [id, index]));
  const songIndex = new Map(songs.map((id, index) => [id, index]));
  const userIndex = playerIndex.get(playerKey);

  if (userIndex === undefined) return null;

  const currentScores = new Map<string, number>();
  for (const row of currentRows) {
    if (row.player_id === playerKey)
      currentScores.set(row.song_id, Number(row.achievement));
  }

  const itemCounts = new Map<string, number>();
  for (const row of currentRows) {
    itemCounts.set(row.song_id, (itemCounts.get(row.song_id) ?? 0) + 1);
  }

  const userFactors = playerFactors[userIndex];
  if (!userFactors) return null;

  const predict = (songId: string, expectedAchievement: number) => {
    const index = songIndex.get(songId);
    if (index === undefined) return null;
    const factors = songFactors[index];
    if (!factors) return null;

    let pred = 0;
    for (let f = 0; f < Math.min(userFactors.length, factors.length); f++) {
      pred += userFactors[f] * factors[f];
    }
    return clamp(expectedAchievement + (pred * 8 - 4), 0, 101);
  };

  const playerCount = players.length;
  const candidates = songs
    .map((songId) => {
      const meta = songMeta[songId];
      const index = songIndex.get(songId);
      if (!meta || index === undefined) return null;

      const predicted = predict(
        songId,
        expectedAchievementFromRating(
          playerRatings.get(playerKey) ?? 0,
          Number(meta.chart_constant),
        ),
      );
      if (predicted === null) return null;

      const current = currentScores.get(songId) ?? null;
      const count = itemCounts.get(songId) ?? 0;
      const confidence = clamp(count / Math.max(3, playerCount), 0, 1);
      const songFactorValues = songFactors[index] ?? [];
      const factorTotal =
        songFactorValues.reduce((sum, value) => sum + value, 0) || 1;
      const dominantFactor = songFactorValues.reduce(
        (best, value, factor) =>
          value > best.value ? { index: factor, value } : best,
        { index: 0, value: -Infinity },
      );
      const topFactors = songFactorValues
        .map((value, factor) => ({ factor, value, share: value / factorTotal }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 4)
        .map((item) => ({
          factor: item.factor,
          value: Number(item.value.toFixed(4)),
          share: Number(item.share.toFixed(4)),
        }));

      const skillMatch =
        userFactors[dominantFactor.index] * dominantFactor.value;
      const improvement =
        current == null ? predicted - 97 : predicted - current;
      const score = improvement * 1.5 + skillMatch * 24 + confidence * 3;

      return {
        song_id: songId,
        ...meta,
        current_achievement: current,
        predicted_achievement: Number(predicted.toFixed(4)),
        predicted_rank: getRank(predicted),
        confidence: Number(confidence.toFixed(3)),
        sample_count: count,
        dominant_factor: dominantFactor.index,
        top_factors: topFactors,
        skill_match: Number(skillMatch.toFixed(4)),
        recommendation_score: Number(score.toFixed(3)),
      };
    })
    .filter(
      (entry: any) =>
        entry && entry.sample_count >= 1 && entry.predicted_achievement >= 80,
    )
    .sort((a: any, b: any) => b.recommendation_score - a.recommendation_score);

  const recommendations = candidates
    .filter(
      (entry: any) =>
        entry.sample_count >= 2 && entry.predicted_achievement >= 97,
    )
    .filter(
      (entry: any) =>
        entry.current_achievement == null ||
        entry.predicted_achievement - entry.current_achievement >= -0.5,
    )
    .filter(
      (entry: any) =>
        entry.chart_constant >=
        ratingToEstimatedConstant(playerRatings.get(playerKey) ?? 0) - 1.5,
    )
    .slice(0, 100);

  const factors = Array.from(
    { length: songFactors[0]?.length ?? 0 },
    (_, factor) => {
      const topSongs = songs
        .map((songId) => {
          const index = songIndex.get(songId);
          const meta = songMeta[songId];
          if (index === undefined || !meta) return null;
          return {
            title: meta.title,
            chart_type: meta.chart_type,
            difficulty: meta.difficulty,
            chart_constant: meta.chart_constant,
            image_name: meta.image_name,
            value: Number(songFactors[index][factor].toFixed(4)),
          };
        })
        .filter(Boolean)
        .sort((a: any, b: any) => b.value - a.value)
        .slice(0, 12);

      return {
        factor,
        player_value: Number(userFactors[factor].toFixed(4)),
        top_songs: topSongs,
      };
    },
  );

  return {
    ready: true,
    model: {
      players: playerCount,
      scores: modelRecord.input_score_count ?? 0,
      filtered_out: 0,
      factors: modelRecord.factors ?? songFactors[0]?.length ?? 0,
      trained_at: modelRecord.trained_at,
      source: "cronjob",
    },
    recommendations,
    candidates,
    factors,
  };
}
