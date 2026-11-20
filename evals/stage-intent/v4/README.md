# StageIntent v4

The active offline corpus adds twelve spectrum-family prompts to the unchanged 160-line v3 prefix: 172 cases, 127 development and 45 holdout. The contract includes `towers-flat` (a planar implementation) and `towers` (perspective). Parameters still come from the original CreativeGL scene definitions. Two additions describe a planar background for the existing text/lyrics overlay; they do not claim an AI text-rendering scene.

Mechanical validation checks all 97 candidate labels against the current contract and materializes them through CreativeStage. All 75 refusal labels must be critical and must not conflict structurally with the rule compiler. A separate boundary fixture exercises an artifact with all numeric slots through the real prepare/share codec, accepting a whitespace-padded 16 KiB JSON and rejecting one extra byte. This transport boundary fixture is not semantic model evidence. The new cross-scene refusal explicitly forbids scene substitution and field omission; ambiguous requests remain subject to the documented last-scene-wins rule. Holdout cases have received structural checks, but no provider evaluation or production tuning. Independent semantic review remains required.

Run without credentials or a service:

```powershell
node scripts/evaluate-ai-stage.js --validate --corpus v4
node scripts/check-stage-evaluation.js
node scripts/check-stage-intent-label-review.js
node scripts/evaluate-ai-stage.js --baseline --corpus v4 --split development --out output/evals/stage-intent-v4-baseline
node scripts/review-stage-intent-labels.js --export --corpus v4 --out output/evals/stage-intent-v4-label-review
```

The review bundle omits authored labels and split identifiers. Keep its sibling private mapping away from the reviewer. Complete independent annotations, model rounds and actual visual/device reviews remain required; tool fixtures never set `releaseEligible=true`. Earlier corpora and reports retain their original bytes and must be reproduced with their historical evaluator and contract revisions.
