import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("news_decision_shadow", ROOT / "scripts" / "news_decision_shadow.py")
shadow = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(shadow)


def scores(label, value=0.98):
    return {key: value if key == label else 0.01 for key in shadow.LABELS}


class DecisionShadowTests(unittest.TestCase):
    def test_fixed_labels_margin_symmetry_and_abstention(self):
        strong = scores("same_copy")
        self.assertEqual(shadow.decide(strong, strong, shadow.DEFAULT_THRESHOLDS)[0], "same_copy")
        self.assertEqual(shadow.decide(strong, strong, shadow.DEFAULT_THRESHOLDS, incomplete=True)[0], "uncertain")
        self.assertEqual(shadow.decide(strong, scores("same_event"), shadow.DEFAULT_THRESHOLDS)[1], "order_disagreement")
        ambiguous = dict(strong, same_event=0.95)
        self.assertEqual(shadow.decide(ambiguous, ambiguous, shadow.DEFAULT_THRESHOLDS)[0], "uncertain")
        weak = scores("same_copy", 0.4)
        self.assertEqual(shadow.decide(weak, weak, shadow.DEFAULT_THRESHOLDS)[0], "uncertain")

    def test_unknown_missing_or_nonfinite_scores_fail_closed(self):
        for invalid in [dict(scores("same_copy"), invented=0.9),
                        {"same_copy": 0.99},
                        dict(scores("same_copy"), same_event=float("nan"))]:
            with self.assertRaises(ValueError):
                shadow.validate_scores(invalid)

    def test_fixtures_are_disjoint_and_holdout_cannot_calibrate(self):
        path = ROOT / "shared" / "news-pair-cases.json"
        calibration = shadow.load_cases(path, "calibration")
        holdout = shadow.load_cases(path, "holdout")
        self.assertGreaterEqual(len(holdout), 16)
        self.assertFalse({item["family"] for item in calibration} & {item["family"] for item in holdout})
        with self.assertRaises(ValueError):
            shadow.calibrate([{"split": "holdout", "expected": "same_copy"}])

    def test_false_merges_are_counted_separately_from_syndication_errors(self):
        results = [
            {"id": "false", "expected": "related_different", "rawLabel": "same_event", "decision": "same_event"},
            {"id": "type", "expected": "same_event", "rawLabel": "same_copy", "decision": "same_copy"},
            {"id": "positive", "expected": "same_copy", "rawLabel": "same_copy", "decision": "same_copy"},
        ]
        result = shadow.metrics(results)
        self.assertEqual(result["falseMergePairIds"], ["false"])
        self.assertEqual(result["copyVsIndependentErrors"], 1)

    def test_calibration_never_approves_production_or_calibrated_probabilities(self):
        result = shadow.calibrate([{
            "id": "cal", "split": "calibration", "expected": "same_copy", "rawLabel": "same_copy",
            "scores": scores("same_copy"), "reverseScores": scores("same_copy"), "incomplete": False,
            "inputFingerprint": "example",
        }])
        self.assertFalse(result["productionApproved"])
        self.assertFalse(result["calibratedProbabilities"])

    def test_bad_input_and_family_leakage_are_rejected_without_loading_a_model(self):
        fixture = json.loads((ROOT / "shared" / "news-pair-cases.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "pairs.json"
            fixture["cases"][8]["family"] = fixture["cases"][0]["family"]
            path.write_text(json.dumps(fixture), encoding="utf-8")
            with self.assertRaises(ValueError):
                shadow.load_cases(path, "holdout")

    def test_identical_reversed_holdout_is_rejected_before_loading_a_model(self):
        case = shadow.load_cases(ROOT / "shared" / "news-pair-cases.json", "calibration")[0]
        fingerprints = [shadow.fingerprint(shadow.documents(case))]
        for holdout in [dict(case, split="holdout"), dict(case, split="holdout", a=case["b"], b=case["a"])]:
            with self.assertRaises(ValueError):
                shadow.validate_holdout([holdout], fingerprints)
        shadow.validate_holdout([case], fingerprints)

    def test_family_leakage_across_files_is_rejected(self):
        case = shadow.load_cases(ROOT / "shared" / "news-pair-cases.json", "holdout")[0]
        with self.assertRaises(ValueError):
            shadow.validate_holdout([case], [], [case["family"]])

    def test_fresh_confirmation_has_separate_inputs_and_story_families(self):
        earlier = shadow.load_cases(ROOT / "shared" / "news-pair-cases.json", "all")
        fresh = shadow.load_cases(ROOT / "shared" / "news-pair-confirmation.json", "holdout")
        self.assertEqual(len(fresh), 12)
        self.assertFalse({item["family"] for item in earlier} & {item["family"] for item in fresh})
        shadow.validate_holdout(fresh, [shadow.fingerprint(shadow.documents(case)) for case in earlier])
        self.assertEqual(set(shadow.HYPOTHESES), set(shadow.LABELS))

    def test_binary_logits_and_nli_head_order_are_explicit(self):
        self.assertEqual(shadow.binary_score(0, 0), 0.5)
        self.assertEqual(shadow.binary_score(-1000, 1000), 1)
        self.assertEqual(shadow.binary_score(1000, -1000), 0)
        self.assertAlmostEqual(shadow.binary_score(1, 2) + shadow.binary_score(2, 1), 1)
        with self.assertRaises(ValueError):
            shadow.binary_score(float("nan"), 1)
        self.assertEqual(shadow.nli_label_ids({"neutral": 0, "CONTRADICTION": 1, "entailment": 2}), (1, 2))
        for labels in [{"LABEL_0": 0, "LABEL_1": 1}, {"entailment": 0, "contradiction": 0}]:
            with self.assertRaises(ValueError):
                shadow.nli_label_ids(labels)

    def test_thresholds_are_bound_to_model_revision_and_scoring_protocol(self):
        calibration = [{
            "id": "cal", "family": "cal-story", "split": "calibration", "expected": "same_copy",
            "rawLabel": "same_copy", "scores": scores("same_copy"), "reverseScores": scores("same_copy"),
            "incomplete": False, "inputFingerprint": "example",
        }]
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "thresholds.json"
            for model in shadow.MODELS:
                report = shadow.calibrate(calibration, model)
                path.write_text(json.dumps(report), encoding="utf-8")
                thresholds, fingerprints, families = shadow.load_thresholds(path, model)
                self.assertEqual(thresholds, report["thresholds"])
                self.assertEqual(fingerprints, ["example"])
                self.assertEqual(families, ["cal-story"])
                with patch.object(shadow, "MAX_TOKENS", shadow.MAX_TOKENS + 1):
                    with self.assertRaises(ValueError):
                        shadow.load_thresholds(path, model)
                other = "mdeberta" if model == "gliclass" else "gliclass"
                with self.assertRaises(ValueError):
                    shadow.load_thresholds(path, other)
                report["revision"] = "unapproved-revision"
                path.write_text(json.dumps(report), encoding="utf-8")
                with self.assertRaises(ValueError):
                    shadow.load_thresholds(path, model)
            legacy = shadow.calibrate(calibration)
            legacy["version"] = 1
            legacy.pop("protocolFingerprint")
            legacy.pop("calibrationFamilies")
            path.write_text(json.dumps(legacy), encoding="utf-8")
            self.assertEqual(shadow.load_thresholds(path)[1:], (["example"], []))

    def test_reranker_uses_relationship_criteria_not_generic_search_relevance(self):
        text = "Report A: example\nReport B: unrelated example"
        request = shadow.reranker_input(text, shadow.HYPOTHESES["same_event"])
        self.assertIn("Shared topic is not event identity", request)
        self.assertIn(shadow.HYPOTHESES["same_event"], request)
        self.assertTrue(request.endswith(text))
        self.assertFalse(any(name.endswith((".bin", ".py")) for name in shadow.MODEL_FILES))

    def test_nli_adapter_scores_five_hypotheses_with_the_named_heads(self):
        tokenizer, model = MagicMock(), MagicMock()
        tokenizer.encode.return_value = [1] * 37
        tokenizer.return_value = {"input_ids": "test-tokens"}
        model.config.label2id = {"neutral": 0, "contradiction": 1, "entailment": 2}
        model.return_value.logits.__getitem__.return_value.float.return_value.tolist.return_value = [99, -2, 2]
        with patch.dict(sys.modules, {"torch": MagicMock()}):
            result, count = shadow.score_text(shadow.MODELS["minilm"], tokenizer, model, None, "reports")
        self.assertEqual(count, 37)
        self.assertEqual(set(result), set(shadow.LABELS))
        self.assertTrue(all(value == shadow.binary_score(-2, 2) for value in result.values()))
        self.assertEqual(model.call_count, 5)
        for call, hypothesis in zip(tokenizer.call_args_list, shadow.HYPOTHESES.values()):
            self.assertEqual(call.args, ("reports", hypothesis))
            self.assertEqual(call.kwargs, {"truncation": "only_first", "max_length": 512, "return_tensors": "pt"})

    def test_reranker_keeps_answer_suffix_and_reports_untruncated_length(self):
        tokenizer, model, torch = MagicMock(), MagicMock(), MagicMock()
        fragments = {"yes": [10], "no": [11], shadow.RERANK_PREFIX: [20] * 4, shadow.RERANK_SUFFIX: [30] * 3}
        tokenizer.encode.side_effect = lambda text, **_: fragments.get(text, [99] * 517)
        model.return_value.logits.__getitem__.return_value.float.return_value = {10: 2, 11: -2}
        with patch.dict(sys.modules, {"torch": torch}):
            result, count = shadow.score_text(shadow.MODELS["qwen3-reranker"], tokenizer, model, None, "reports")
        self.assertEqual(count, 524)
        self.assertTrue(all(value == shadow.binary_score(-2, 2) for value in result.values()))
        self.assertEqual(model.call_count, 5)
        for call in torch.tensor.call_args_list:
            tokens = call.args[0][0]
            self.assertEqual(len(tokens), 512)
            self.assertEqual(tokens[:4], [20] * 4)
            self.assertEqual(tokens[-3:], [30] * 3)
        for call in model.call_args_list:
            self.assertFalse(call.kwargs["use_cache"])
            self.assertEqual(call.kwargs["logits_to_keep"], 1)
        model.generate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
