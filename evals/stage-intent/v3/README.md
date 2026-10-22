# StageIntent v3

v3 is the active offline evaluation corpus for the current stage contract. Its 160 prompt and label lines are byte-identical to v2; only the contract fingerprint and corpus version changed. The current contract adds the `lyric scene` alias. The mechanical audit checked all 89 candidate labels and materialized all 89. It found no structural conflict among 71 refusal labels. Independent semantic review is still required, and the 40-item holdout remains same-source synthetic data. Reports keep `releaseEligible=false`.

The compiler now refuses explicit timed scene changes and timeline requests with `unsupported_timeline`. This closes the v2 holdout case `hold-time-01`, which previously produced a partial static scene despite explicitly rejecting a static result.

The 2026-10-20 offline rules baseline is recorded in [baseline-20261020.json](./baseline-20261020.json): 101/120 automatic matches, 52/70 expected candidates matched, 0 false acceptances, 18 false rejections, and 0 critical failures. Human semantic score is null and `releaseEligible` is false. Refusal outcomes are now counted when the compiler explicitly fails closed; ordinary `no_match` remains a distinct outcome.

The evaluator defaults to v3. Validation and rule baselines are offline and do not call a model:

```powershell
node scripts/evaluate-ai-stage.js --validate --corpus v3
node scripts/check-stage-evaluation.js
node scripts/evaluate-ai-stage.js --baseline --corpus v3 --split development --out output/evals/stage-intent-v3-baseline
node scripts/evaluate-ai-stage.js --report output/evals/stage-intent-v3-baseline --corpus v3
```

Prepare a blind semantic label review without showing authored labels to the reviewer:

```powershell
node scripts/review-stage-intent-labels.js --export --corpus v3 --out output/evals/stage-intent-v3-label-review
```

Share the generated bundle directory only; its sibling `.private.json` mapping is for the verifier and must not be sent with the blind packet. The reviewer fills `annotations.template.jsonl` and saves a copy, then the owner verifies it:

```powershell
node scripts/review-stage-intent-labels.js --verify --corpus v3 `
  --bundle output/evals/stage-intent-v3-label-review `
  --answers output/evals/stage-intent-v3-label-review/answers.jsonl `
  --reviewer "Reviewer name" `
  --out output/evals/stage-intent-v3-label-review/report.json
```

The verifier requires all 160 opaque IDs exactly once, checks scene and parameter labels against the active contract, and records case-level disagreements. Reviewer identity is self-reported; this report does not update the frozen manifest or make the corpus release-eligible. Resolve disagreements in a new corpus version.

v2 and its checked-in 2026-10-20 baseline remain historical evidence under the previous contract fingerprint. v1 is also historical. Reproducing either baseline requires its original evaluator revision.

Model evaluation remains opt-in and local-only through the Ollama CLI adapter. No cloud call is made by validation, rule baseline generation, or reporting.
