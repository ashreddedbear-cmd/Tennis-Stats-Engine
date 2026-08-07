export const RECOMMENDATION_LABELS: Record<string, string> = {
  // Current labels (v2 system)
  HIGHEST_CONFIDENCE: "Highest Confidence",
  HIGH_CONFIDENCE: "High Confidence",
  MODERATE_CONFIDENCE: "Moderate Confidence",
  LOW_CONFIDENCE: "Low Confidence",
  INSUFFICIENT_EDGE: "Insufficient Edge",
  DATA_INCOMPLETE: "Data Incomplete",
  // Legacy labels — kept so stored rows from before the rename continue
  // rendering correctly in the ledger, history, and audit pages.
  STRONG_RECOMMENDATION: "Strong Recommendation",
  MODERATE_LEAN: "Moderate Lean",
  HIGH_RISK: "High Risk",
  NO_STRONG_SIGNAL: "No Strong Signal",
  DO_NOT_RECOMMEND: "Do Not Recommend",
}

export const RECOMMENDATION_SHORT_LABELS: Record<string, string> = {
  // Current short labels
  HIGHEST_CONFIDENCE: "TOP CONF",
  HIGH_CONFIDENCE: "HIGH CONF",
  MODERATE_CONFIDENCE: "MODERATE",
  LOW_CONFIDENCE: "LOW CONF",
  INSUFFICIENT_EDGE: "NO EDGE",
  DATA_INCOMPLETE: "DATA INCOMPLETE",
  // Legacy short labels
  STRONG_RECOMMENDATION: "HIGH CONF",
  MODERATE_LEAN: "LEAN",
  HIGH_RISK: "RISK",
  NO_STRONG_SIGNAL: "COIN FLIP",
  DO_NOT_RECOMMEND: "NO REC",
}

export const RECOMMENDATION_DESCRIPTION: Record<string, string> = {
  HIGHEST_CONFIDENCE: "Strong evidence agreement with limited uncertainty.",
  HIGH_CONFIDENCE: "Clear model-supported advantage with manageable risk.",
  MODERATE_CONFIDENCE: "Meaningful advantage, but some evidence is mixed.",
  LOW_CONFIDENCE: "Projected winner, but the advantage is fragile.",
  INSUFFICIENT_EDGE: "Available evidence does not support a reliable advantage.",
  DATA_INCOMPLETE: "One or more contributing model inputs were unavailable and defaulted to neutral.",
}

export function getRecommendationLabel(recommendation: string): string {
  return RECOMMENDATION_LABELS[recommendation] ?? recommendation.replace(/_/g, " ")
}

export function getShortRecommendationLabel(recommendation: string): string {
  return RECOMMENDATION_SHORT_LABELS[recommendation] ?? recommendation.replace(/_/g, " ")
}

export function getRecommendationDescription(recommendation: string): string | undefined {
  return RECOMMENDATION_DESCRIPTION[recommendation]
}
