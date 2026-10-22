# StageIntent v2 (Historical)

v2 is a frozen historical corpus version with schema hash `9eeda3eea3c20f2526c6180269944ae437c9289cc321206e0a1db4ea6754ff6e`. Its 160 sample lines and checked-in 2026-10-20 baseline are preserved as evidence. The active evaluator no longer loads v2 against the current contract; reproduce it with the evaluator revision that created its baseline.

Mechanical compatibility does not establish that descriptions match their expected labels. Independent semantic review is still required for all labels. The 40-item holdout remains same-source synthetic data and has not been independently collected, reviewed, or evaluated. Reports must keep `releaseEligible=false`.

The current contract adds the `lyric scene` alias and is evaluated by [StageIntent v3](../v3/README.md). v3 keeps the v2 prompt and label lines byte-identical, with a new contract fingerprint and an independent mechanical audit. Semantic label review is still pending.
