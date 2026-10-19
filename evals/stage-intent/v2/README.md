# StageIntent v2

This version preserves the 160 v1 sample lines byte-for-byte and updates the contract fingerprint to the current stage contract. It does not change labels. The mechanical audit confirmed all 89 expected candidates validate and materialize, and found no structural conflict in the 71 refusal labels.

Mechanical compatibility does not establish that descriptions match their expected labels. Independent semantic review is still required for all labels. The 40-item holdout remains same-source synthetic data and has not been independently collected, reviewed, or evaluated. Reports must keep `releaseEligible=false`.

The evaluator defaults to v2. Pass `--corpus v2` explicitly when creating, reporting, comparing, or exporting a run:

```powershell
node scripts/evaluate-ai-stage.js --validate --corpus v2
node scripts/check-stage-evaluation.js
node scripts/evaluate-ai-stage.js --baseline --corpus v2 --split development --out output/evals/stage-intent-v2-baseline
node scripts/evaluate-ai-stage.js --report output/evals/stage-intent-v2-baseline --corpus v2
```

The 2026-10-20 offline rule baseline is recorded in [baseline-20261020.json](./baseline-20261020.json): 32/120 automatic expectation matches, 66/70 expected candidates structurally valid and materialized, 31 false acceptances, and 53 critical failures. Human semantic score is null and `releaseEligible` is false. This measures the existing editing rules, not a model.

Prepare a blind semantic label review without showing authored labels to the reviewer:

```powershell
node scripts/review-stage-intent-labels.js --export --corpus v2 --out output/evals/stage-intent-v2-label-review
```

Share the generated bundle directory only; its sibling `.private.json` mapping is for the verifier and must not be sent with the blind packet. The reviewer fills `annotations.template.jsonl` and saves a copy, then the owner verifies it:

```powershell
node scripts/review-stage-intent-labels.js --verify --corpus v2 `
  --bundle output/evals/stage-intent-v2-label-review `
  --answers output/evals/stage-intent-v2-label-review/answers.jsonl `
  --reviewer "Reviewer name" `
  --out output/evals/stage-intent-v2-label-review/report.json
```

The verifier requires all 160 opaque IDs exactly once, checks scene/parameter labels against the current contract, and records case-level disagreements. Reviewer identity is self-reported; this report does not update the frozen manifest or make the corpus release-eligible. Resolve disagreements in a new corpus version and keep v2 unchanged.

Each new `run.json`, `report.json`, comparison, and review bundle identifies the corpus version. A run cannot be loaded against a different corpus or contract. The v1 corpus and its checked-in baseline remain historical evidence; reproducing that baseline requires the original evaluator revision.

Rule baselines are offline and do not call any model. Model evaluation remains opt-in and local-only through the Ollama CLI adapter; no cloud call is made by validation, baseline generation, or reporting.
