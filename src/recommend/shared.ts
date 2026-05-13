export const RATING_TO_CONSTANT_A = 1115.044248
export const RATING_TO_CONSTANT_B = 97.787611
export const EXPECTED_ACHIEVEMENT_GAP_WEIGHT = 3.2

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

export function calcRating(cc: number, achievement: number): number {
  const a = Math.min(achievement, 100.5)
  let multiplier: number
  if (a >= 100.5) multiplier = 22.4
  else if (a >= 100.0) multiplier = 21.6
  else if (a >= 99.5) multiplier = 21.1
  else if (a >= 99.0) multiplier = 20.8
  else if (a >= 98.0) multiplier = 20.3
  else if (a >= 97.0) multiplier = 20.0
  else if (a >= 94.0) multiplier = 16.8
  else if (a >= 90.0) multiplier = 15.2
  else if (a >= 80.0) multiplier = 13.6
  else multiplier = 0
  return Math.floor(cc * multiplier * a / 100)
}

export function ratingToEstimatedConstant(rating: number) {
  return (rating - RATING_TO_CONSTANT_B) / RATING_TO_CONSTANT_A
}

export function expectedAchievementFromRating(rating: number, chartConstant: number) {
  const gap = chartConstant - ratingToEstimatedConstant(rating)
  return clamp(100.5 - gap * EXPECTED_ACHIEVEMENT_GAP_WEIGHT, 80, 101)
}

export function scoreTrainingWeight(row: { chart_constant: unknown, achievement: unknown, fc?: string | null }, playerRating: number) {
  if (!playerRating || row.chart_constant == null || row.achievement == null) return 0

  const achievement = Number(row.achievement)
  const chartConstant = Number(row.chart_constant)
  const easierBy = ratingToEstimatedConstant(playerRating) - chartConstant
  let weight = 1

  if (easierBy >= 2.0 && achievement < 100.0) weight *= 0.15
  else if (easierBy >= 1.5 && achievement < 99.5) weight *= 0.3
  else if (easierBy >= 1.0 && achievement < 99.0) weight *= 0.5

  if (achievement >= 100.5 || row.fc === 'ap' || row.fc === 'app') weight = Math.max(weight, 0.8)
  else if (achievement >= 100.0) weight = Math.max(weight, 0.6)

  return weight
}
