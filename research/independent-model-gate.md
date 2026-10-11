# Independent model research gate (Differ + Rise/Fall)

This document is a research-only validation gate. It does not change Deriv connections, purchases, stake, DEMO/REAL, or production behavior.

## Prior art evaluated
- River: prequential predict-then-learn evaluation and ADWIN drift detection. Port concepts to Node only after independent tests.
- MAPIE: uncertainty / conformal prediction. Coverage claims require appropriate exchangeability or adaptive time-series assumptions; do not assert coverage from untested tick data.
- Probability calibration: assess Brier, log-loss, reliability by risk bins, and uncertainty of observed rates.

## Required candidate-versus-baseline experiment
1. Freeze existing production model and research candidate versions; use identical chronological tick sequences and contract pricing.
2. Differ: score each digit distribution before observing the next digit; compare against uniform 0.10, previous production model and candidate using multiclass log-loss, Brier, observed MATCH frequency, Wilson confidence intervals and net payout-aware EV.
3. Rise/Fall: score 1T/2T/3T/5T separately before observing each outcome; handle overlapping horizons, compare with unconditional direction frequencies and production, record multiclass log-loss/Brier, directional accuracy, turnover of AUTO choices and net EV using actual quote payouts.
4. Run rolling chronological holdouts, embargo overlapping horizons and reserve untouched final holdout. Report sample sizes, uncertainty intervals and all attempted models to mitigate selection bias.
5. Monitor rolling prediction residuals for drift (ADWIN-like detector), but do not treat a drift alert as proof of a trading signal.
6. Require positive net EV and robust out-of-sample advantage after accounting for repeated candidate selection. If inconclusive, preserve production and report no verified edge.
7. Require Node syntax/test checks and Railway deployment health before any release. Never promote based solely on training fit, short winning streaks or a single favorable audit window.

## Current state
Research methodology only. No successful OOS validation, profitability or production deployment is asserted by this file.
