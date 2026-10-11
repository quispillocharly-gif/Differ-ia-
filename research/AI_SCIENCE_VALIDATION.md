# Differ IA Cloud — AI science validation gates

This is a research-only proposal. No production logic, Deriv connectivity, DEMO/REAL settings, order execution or buying behavior is changed.

## Differ
- Separate raw forecast, calibrated forecast, and observed MATCH rate. Audit comparable predictions only, on non-overlapping holdout windows.
- Report Brier, log loss, ECE, calibration intercept/slope and uncertainty intervals against the uniform 10% benchmark.
- Treat repeated severeInstability, PAUSA AUTOMÁTICA IA, champion churn, and elevated shadow MATCH as diagnostic events; distinguish user-visible browser events from server logs.
- Treat science-audit digit-uniformity and transition p-values as exploratory; correct for repeated testing and overlapping windows. Do not claim predictability from a small p-value.
- Require universal surrogate lab and forward, strictly out-of-sample improvement with uncertainty bounds before champion promotion; include transaction costs and payout economics when evaluating trading edge.

## Rise/Fall
- Independently evaluate 1T, 2T, 3T and 5T using directionHitEWMA, Brier, log-loss, sample size and confidence intervals.
- Compare AUTO to fixed horizons on identical future observations without look-ahead bias.
- Quantify RISE/FALL/WAIT switching and stability with hysteresis only after offline validation.

## Acceptance gates
1. Run reproducible walk-forward tests on non-overlapping chronological segments.
2. Compare candidate with currently deployed champion and naive baselines using paired metrics.
3. Reject if calibrated risk worsens, champion churn increases, or OOS edge is not demonstrated.
4. Preserve current production deployment and rollback reference. No deployment or purchase changes without explicit approval.
