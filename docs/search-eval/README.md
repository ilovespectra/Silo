# Silo search evaluation

This harness measures Silo's offline CLIP search against 50 fixed photo queries and a deterministic 500-image sample from COCO 2017 validation. The measured confidence default is **23**: higher slider values apply a stricter score floor. On the 500-image run, setting 23 produced 57.00% precision@10, 77.41% recall, and no empty searches; it was the strictest integer setting that kept at least ten results for every query.

## Run it

1. Install the repository dependencies with `npm install`.
2. Place the offline model cache at `.model-test-cache/Xenova/clip-vit-base-patch32` with the model files listed in `scripts/search-eval.cjs`. The harness does not download a model.
3. Run `npm run search-eval`. It downloads COCO annotation metadata and the selected photos into `work/search-eval/`, indexes them through Silo's `SemanticIndexer`, sweeps slider positions 0–100, and writes `work/search-eval/report.md`. The dataset and temporary index are ignored by Git.
4. Run `npm run test:search-eval` for the metric and slider mapping unit tests.

The fixture selects image-license id 4 (CC BY 2.0) using metadata embedded in COCO's annotation files. Ground truth is derived from the COCO object categories and human captions using the per-query rules in `test/fixtures/search-eval-queries.json`; it is an annotation-based relevance set, not a separate manual review of each image. The query-balanced sample is deterministic for a fixed fixture and seed.
