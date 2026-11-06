import copy
from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import news_evidence as evidence
import news_decision_ablation as ablation
import news_decision_shadow as shadow


BODY = ("Larch releases Harbor version 1.2 for financial services. "
        "The package includes request scheduling, memory management, detailed diagnostics, and installation instructions.")


def document(title="Larch releases Harbor version 1.2", excerpt=BODY, **extra):
    return dict(title=title, excerpt=excerpt, publishedAt="2025-03-12", url="https://example.test/news", **extra)


def pair(a=None, b=None, **extra):
    return dict(id="test-pair", family="test-family", split="calibration", expected="same_copy",
                a=a or document(), b=b or document(), **extra)


def scores(label):
    return {name: 0.999 if name == label else 0.0001 for name in shadow.LABELS}


class FakeRuntime:
    load_seconds = 0

    def __init__(self, label="same_event", probabilities=None, tokens=50):
        self.label = label
        self.probabilities = probabilities or {"entailment": 0.999, "neutral": 0.0005, "contradiction": 0.0005}
        self.tokens = tokens
        self.classified = []
        self.inferred = []

    def classify(self, text):
        self.classified.append(text)
        return scores(self.label), self.tokens

    def infer(self, premise, hypothesis):
        self.inferred.append((premise, hypothesis))
        return (None if self.tokens > 512 else self.probabilities.copy()), self.tokens


class EvidenceTests(unittest.TestCase):
    def test_exact_spans_immutable_sources_and_plain_normalization(self):
        original = document(excerpt="  " + BODY + "\n")
        before = copy.deepcopy(original)
        card = evidence.prepare(original)
        self.assertTrue(evidence.validate_card(original, card))
        self.assertEqual(original, before)
        frame = next(frame for frame in card["frames"] if frame["application"])
        self.assertEqual(frame["actor"]["quote"], "Larch")
        self.assertEqual(frame["object"]["quote"], "Harbor version 1.2")
        self.assertEqual(frame["version"]["quote"], "version 1.2")
        self.assertEqual(frame["application"]["value"], "financial services")
        frame["object"]["quote"] = "invented"
        self.assertFalse(evidence.validate_card(original, card))
        self.assertEqual(evidence.normalized("e\u0301  \t x\n y"), "\u00e9 x y")
        self.assertNotEqual(evidence.normalized("x\u00b2"), evidence.normalized("x2"))
        self.assertNotEqual(evidence.normalized("-1.2"), evidence.normalized("1.2"))

    def test_decimal_boundaries_and_whitespace_offsets(self):
        original = document(excerpt="  Larch releases Harbor version 1.2.  Further details follow!\n")
        lines = evidence.sentences(original)
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]["quote"], "Larch releases Harbor version 1.2.")
        self.assertTrue(all(evidence.grounded(original, item) for item in lines))

    def test_unknown_first_person_questions_and_modality(self):
        for text in ("We released Harbor version 1.2.", "I release Harbor version 1.2.",
                     "\u6211\u4eec\u5ba3\u5e03\u63a8\u51faHarbor\u7248\u672c1.2\u3002",
                     "Larch may release Harbor version 1.2.", "Will Larch release Harbor version 1.2?",
                     "If Larch releases Harbor version 1.2, users can upgrade.",
                     "Rumor: Larch releases Harbor version 1.2.",
                     "aLarch releases Harbor version 1.2."):
            with self.subTest(text=text):
                card = evidence.prepare(document(title=text, excerpt=text))
                self.assertEqual(card["slotValues"]["actor"], [])
        today = document(title="Today Larch releases Harbor version 1.2", excerpt="")
        card = evidence.prepare(today)
        self.assertEqual(card["slotValues"]["actor"], ["larch"])
        self.assertTrue(evidence.validate_card(today, card))

    def test_ambiguity_and_multiple_actions_do_not_form_a_single_identity(self):
        original = document(excerpt=BODY + " Birch releases Harbor version 1.2.")
        card = evidence.prepare(original)
        self.assertIn("actor", card["ambiguousSlots"])
        self.assertFalse(evidence.identity_ready([card, card]))
        text = "Larch acquires Birch and Birch acquires Cedar."
        self.assertEqual(evidence.prepare(document(title=text, excerpt=text))["frames"], [])

    def test_explicit_dates_are_not_publication_timestamps_or_headers(self):
        plain = evidence.prepare(document())
        self.assertEqual(plain["slotValues"]["event_date"], [])
        for date in ("2025-02-28", "2025-02-30"):
            text = f"Larch releases Harbor on {date}."
            card = evidence.prepare(document(title="Announcement", excerpt=text))
            self.assertEqual(card["slotValues"]["event_date"], [date] if date.endswith("28") else [])
        header = evidence.prepare(document(title="2025-02-28 Larch releases Harbor", excerpt=""))
        self.assertEqual(header["slotValues"]["event_date"], [])

    def test_numbers_are_not_automatically_versions(self):
        for text in ("Larch publishes a throughput result of 1.2 tokens.",
                     "Larch publishes revenue of 1.2 million dollars."):
            self.assertEqual(evidence.prepare(document(title=text, excerpt=""))["slotValues"]["version"], [])
        text = "Larch releases Harbor v1.2.3-beta"
        self.assertEqual(evidence.prepare(document(title=text, excerpt=""))["slotValues"]["version"], ["1.2.3-beta"])

    def test_version_date_application_polarity_and_role_conflicts(self):
        base = "Larch releases Harbor version 1.2 for financial services on 2025-03-12."
        left = evidence.prepare(document(title="Announcement", excerpt=base))
        self.assertEqual(left["slotValues"]["application"], ["financial services"])
        changes = (
            ("1.2", "2.0", "version"), ("2025-03-12", "2025-03-13", "event_date"),
            ("financial services", "biological research", "application"),
            ("releases", "never releases", "polarity"),
        )
        for old, new, slot in changes:
            right = evidence.prepare(document(title="Announcement", excerpt=base.replace(old, new)))
            self.assertIn("different_" + slot, {item["kind"] for item in evidence.conflicts([left, right])})
        a = evidence.prepare(document(title="Announcement", excerpt="Larch acquires Birch."))
        b = evidence.prepare(document(title="Announcement", excerpt="Birch acquires Larch."))
        self.assertEqual(evidence.conflicts([a, b])[0]["kind"], "swapped_actor_object")
        for audience in ("vehicle drivers", "phone users"):
            text = f"Larch releases Harbor version 1.2 for {audience}."
            self.assertEqual(evidence.prepare(document(title="Announcement", excerpt=text))["slotValues"]["application"], [audience])

    def test_chinese_qualifiers_are_grounded_not_guessed_domains(self):
        text = "\u94f6\u674f\u56e2\u961f\u53d1\u5e03Harbor\u7248\u672c1.2\uff0c\u9762\u5411\u91d1\u878d\u670d\u52a1\u3002"
        original = document(title=text, excerpt=text)
        card = evidence.prepare(original)
        self.assertTrue(evidence.validate_card(original, card))
        self.assertEqual(card["slotValues"]["actor"], ["\u94f6\u674f"])
        self.assertEqual(card["slotValues"]["application"], ["\u91d1\u878d\u670d\u52a1"])
        self.assertEqual(card["slotValues"]["version"], ["1.2"])

    def test_late_critical_evidence_and_bounds_are_visible(self):
        text = "Routine background. " * 7 + "Correction: Larch never released Harbor version 1.2."
        card = evidence.prepare(document(excerpt=text))
        self.assertTrue(any("Correction:" in item["quote"] for item in card["claims"]))
        self.assertEqual(card["omittedCriticalCount"], 0)
        many = evidence.prepare(document(excerpt="Correction: the release was cancelled. " * 5))
        self.assertEqual(many["omittedCriticalCount"], 2)
        bounded = evidence.prepare(document(excerpt="Background. " * (evidence.MAX_SENTENCES + 1)))
        self.assertTrue(bounded["scanLimited"])
        self.assertEqual(len(bounded["claims"]), evidence.MAX_CLAIMS)

    def test_copy_rule_preserves_semantics_and_rejects_small_edits(self):
        a = document()
        self.assertTrue(evidence.same_copy([a, document(excerpt=BODY.replace(" ", "  "))]))
        self.assertTrue(evidence.same_copy([a, a]))
        for b in (document(excerpt=BODY.replace("releases", "never releases")),
                  document(excerpt=BODY + " Correction: launch cancelled."),
                  document(excerpt=BODY.replace("1.2", "-1.2")),
                  document(title=a["title"].replace("1.2", "12")),
                  document(title=a["title"] + "?"),
                  document(excerpt="short"),
                  document(excerpt="a" * 200)):
            self.assertFalse(evidence.same_copy([a, b]))
        for changed in ("-1.2", "+1.2", "\u22121.2"):
            self.assertFalse(evidence.same_copy([a, document(title=a["title"].replace("1.2", changed))]))
        self.assertFalse(evidence.same_copy([document(title="Short"), document(title="Short")]))

    def test_identity_needs_explicit_anchor_compatible_roles_and_qualifiers(self):
        a = evidence.prepare(document())
        self.assertTrue(evidence.identity_ready([a, a]))
        unanchored = evidence.prepare(document(title="Larch releases Harbor", excerpt="Larch releases Harbor."))
        self.assertFalse(evidence.identity_ready([unanchored, unanchored]))
        missing_application = evidence.prepare(document(excerpt="Larch releases Harbor version 1.2."))
        self.assertFalse(evidence.identity_ready([a, missing_application]))
        a = evidence.prepare(document(title="Notice", excerpt="Larch releases Harbor 1.2 on 2025-03-12."))
        b = evidence.prepare(document(title="Notice", excerpt="Larch releases Harbor 12 on 2025-03-12."))
        self.assertFalse(evidence.identity_ready([a, b]))

    def test_repeated_title_and_body_facts_keep_their_individual_provenance(self):
        text = "Larch releases Harbor version 1.2"
        card = evidence.prepare(document(title=text, excerpt=text))
        self.assertEqual(len(card["frames"]), 2)
        self.assertTrue(evidence.claim_has_identity(card, card["claims"][0]))

    def test_native_softmax_keeps_neutral_and_validates_head_mapping(self):
        heads = {"NEUTRAL": 0, "entailment": 2, "contradiction": 1}
        result = evidence.nli_probabilities([1000, 0, 0], heads)
        self.assertEqual(result["neutral"], 1)
        self.assertAlmostEqual(sum(result.values()), 1)
        for logits, labels in (([0, 1], heads), ([0, float("nan"), 1], heads),
                               ([1, 2, 3], {"entailment": 0, "neutral": 0, "contradiction": 2}),
                               ([1, 2, 3], {"LABEL_0": 0, "LABEL_1": 1, "LABEL_2": 2})):
            with self.assertRaises(ValueError):
                evidence.nli_probabilities(logits, labels)


class AblationTests(unittest.TestCase):
    def test_document_references_annotations_and_unknown_ids(self):
        data = {"documents": {"a": document(expectedSlots={"actor": ["larch"], "event_date": None})},
                "cases": [dict(pair(), a="a", b="a")]}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "pairs.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            cases = ablation.load_pairs(path, "calibration")
            self.assertEqual(cases[0]["a"]["expectedSlots"]["actor"], ["larch"])
            data["cases"][0]["b"] = "absent"
            path.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(ValueError):
                ablation.load_pairs(path, "calibration")
            data["cases"][0]["b"] = "a"
            data["documents"]["a"]["expectedSlots"]["actor"] = "not-a-list"
            path.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(ValueError):
                ablation.load_pairs(path, "calibration")

    def test_public_fixture_is_disjoint_bounded_and_separates_constructed_controls(self):
        path = ROOT / "shared" / "news-pair-public-confirmation.json"
        calibration, development, confirmation = ablation.load_experiment(
            ROOT / "shared" / "news-pair-cases.json",
            [ROOT / "shared" / "news-pair-cases.json", ROOT / "shared" / "news-pair-confirmation.json"],
            path,
        )
        self.assertEqual([len(calibration), len(development), len(confirmation)], [8, 28, 13])
        self.assertEqual(sum(not case.get("isControl", False) for case in confirmation), 10)
        data = json.loads(path.read_text(encoding="utf-8"))
        counts = {}
        for name, original in data["documents"].items():
            text = original["title"] + " " + original["excerpt"]
            counts[name] = len(evidence.re.findall(
                r"[\u3400-\u9fff]|[A-Za-z0-9]+(?:['\u2019.-][A-Za-z0-9]+)*", text,
            ))
            self.assertLessEqual(counts[name], 90)
        self.assertLessEqual(counts["qwen3"] + counts["qwen3-zh"], 90)

    def test_partition_leakage_ids_and_total_budget(self):
        calibration = ablation.load_pairs(ROOT / "shared" / "news-pair-cases.json", "calibration")
        development = ablation.load_pairs(ROOT / "shared" / "news-pair-cases.json", "holdout")
        confirmation = ablation.load_pairs(ROOT / "shared" / "news-pair-confirmation.json", "holdout")
        ablation.validate_partitions(calibration, development, confirmation)
        leaked = copy.deepcopy(confirmation)
        leaked[0]["a"] = dict(calibration[0]["a"], url="https://changed.test", publishedAt=None)
        with self.assertRaises(ValueError):
            ablation.validate_partitions(calibration, development, leaked)
        leaked = copy.deepcopy(confirmation)
        leaked[0]["family"] = calibration[0]["family"]
        with self.assertRaises(ValueError):
            ablation.validate_partitions(calibration, development, leaked)
        with self.assertRaises(ValueError):
            ablation.validate_partitions(calibration, development + development, confirmation)
        with patch.object(shadow, "MAX_PAIRS", 35):
            with self.assertRaises(ValueError):
                ablation.validate_partitions(calibration, development, confirmation)

    def test_combined_file_budget_fails_before_parsing(self):
        path = ROOT / "shared" / "news-pair-cases.json"
        with patch.object(shadow, "MAX_INPUT_BYTES", 1), patch.object(ablation, "load_pairs") as loader:
            with self.assertRaises(ValueError):
                ablation.load_experiment(path, [path], path)
            loader.assert_not_called()

    def test_conflicting_annotations_fail_and_later_reference_is_not_lost(self):
        case = pair(b=document(expectedSlots={"actor": ["larch"]}))
        prediction = ablation.predict_case(case, "clean", FakeRuntime())
        measured = ablation.extraction_metrics([case], [prediction])
        self.assertEqual(measured["knownAnnotatedSlots"], 1)
        self.assertEqual(measured["knownSlotsCorrect"], 1)
        case["a"]["expectedSlots"] = {"actor": ["other"]}
        with self.assertRaises(ValueError):
            ablation.slot_references([case])

    def test_protocol_fingerprint_binds_model_arm_and_token_limit(self):
        current = ablation.protocol_fingerprint("minilm", "raw")
        self.assertNotEqual(current, ablation.protocol_fingerprint("minilm", "clean"))
        self.assertNotEqual(current, ablation.protocol_fingerprint("mdeberta", "raw"))
        with patch.object(shadow, "MAX_TOKENS", 128):
            self.assertNotEqual(current, ablation.protocol_fingerprint("minilm", "raw"))

    def test_gold_annotations_do_not_reach_preparation_or_inference(self):
        original = pair(a=document(expectedSlots={"actor": ["ORACLE_SECRET"]}))
        before = copy.deepcopy(original)
        for protocol in ablation.PROTOCOLS:
            runtime = FakeRuntime()
            result = ablation.predict_case(original, protocol, runtime)
            self.assertNotIn("ORACLE_SECRET", json.dumps(result))
            self.assertNotIn("ORACLE_SECRET", json.dumps(runtime.classified + runtime.inferred))
        self.assertEqual(original, before)

    def test_raw_input_unchanged_clean_input_omits_metadata_and_reverses(self):
        a, b = document(), document(title="Another original title")
        case = pair(a, b)
        runtime = FakeRuntime()
        ablation.predict_case(case, "raw", runtime)
        expected = "Report A:\n" + json.dumps(shadow.documents(case)[0], ensure_ascii=False)
        self.assertTrue(runtime.classified[0].startswith(expected))
        self.assertTrue(runtime.classified[1].startswith("Report A:\n" + json.dumps(shadow.documents(case)[1])))
        runtime = FakeRuntime()
        ablation.predict_case(case, "clean", runtime)
        self.assertNotIn(a["url"], "".join(runtime.classified))
        self.assertNotIn(a["publishedAt"], "".join(runtime.classified))
        self.assertTrue(runtime.classified[1].startswith("Report A:\nAnother original title"))

    def test_copy_and_conflict_shortcuts_have_no_model_attribution(self):
        runtime = FakeRuntime()
        copy_result = ablation.predict_case(pair(), "hierarchical", runtime)
        judged = ablation.judge(copy_result, shadow.DEFAULT_THRESHOLDS)
        self.assertEqual(judged["reason"], "retained_text_copy_rule")
        self.assertFalse(judged["modelUsed"])
        self.assertEqual(judged["modelForwardCalls"], 0)
        a = document(title="Announcement", excerpt="Larch acquires Birch. " + "Detailed source material follows. " * 3)
        b = document(title="Announcement", excerpt="Birch acquires Larch. " + "Other source material follows. " * 3)
        judged = ablation.judge(ablation.predict_case(pair(a, b), "hierarchical", runtime), shadow.DEFAULT_THRESHOLDS)
        self.assertEqual(judged["reason"], "grounded_fact_conflict")
        self.assertEqual(judged["decision"], "related_different")
        self.assertFalse(runtime.inferred or runtime.classified)
        self.assertFalse(judged["canMerge"])

    def test_native_symmetry_neutral_unknown_identity_and_material_guards(self):
        a, b = document(), document(excerpt=BODY + " This report adds separate commentary.")
        case = pair(a, b)
        runtime = FakeRuntime()
        prediction = ablation.predict_case(case, "hierarchical", runtime)
        self.assertTrue(runtime.inferred)
        self.assertEqual(prediction["modelForwardCalls"], len(runtime.inferred))
        for index in range(0, len(runtime.inferred), 2):
            self.assertEqual(runtime.inferred[index], runtime.inferred[index + 1][::-1])
        self.assertEqual(ablation.judge(prediction, shadow.DEFAULT_THRESHOLDS)["decision"], "same_event")
        prediction["reverseScores"] = scores("related_different")
        self.assertEqual(ablation.judge(prediction, shadow.DEFAULT_THRESHOLDS)["reason"], "order_disagreement")
        prediction["reverseScores"] = prediction["scores"].copy()
        prediction["identityReady"] = False
        self.assertEqual(ablation.judge(prediction, shadow.DEFAULT_THRESHOLDS)["reason"], "missing_or_ambiguous_event_identity")
        neutral = FakeRuntime(probabilities={"entailment": 0.001, "neutral": 0.998, "contradiction": 0.001})
        result = ablation.predict_case(case, "hierarchical", neutral)
        self.assertEqual(ablation.judge(result, shadow.DEFAULT_THRESHOLDS)["decision"], "uncertain")
        for protocol in ablation.PROTOCOLS:
            short = ablation.predict_case(pair(b=document(excerpt="tiny")), protocol, FakeRuntime())
            self.assertTrue(short["incomplete"])
            self.assertEqual(ablation.judge(short, shadow.DEFAULT_THRESHOLDS)["decision"], "uncertain")
            overlong = ablation.predict_case(case, protocol, FakeRuntime(tokens=513))
            self.assertTrue(overlong["incomplete"])
            self.assertEqual(ablation.judge(overlong, shadow.DEFAULT_THRESHOLDS)["decision"], "uncertain")

    def test_failed_rule_calibration_is_reported_not_hidden_by_thresholds(self):
        runtime = FakeRuntime()
        prediction = ablation.predict_case(pair(), "hierarchical", runtime)
        prediction["expected"] = "related_different"
        result = ablation.calibrate([prediction], "minilm", "hierarchical")
        self.assertFalse(result["calibrationPolicySatisfied"])
        self.assertEqual(result["calibrationMetrics"]["falseMerges"], 1)
        self.assertFalse(result["productionApproved"])
        prediction["split"] = "holdout"
        with self.assertRaises(ValueError):
            ablation.calibrate([prediction], "minilm", "hierarchical")

    def test_generic_body_entailment_cannot_approve_a_title_only_event_identity(self):
        a = document(excerpt="Readers can find installation instructions and operational documentation on the project website.")
        b = document(excerpt="Readers can find installation instructions and operational documentation on the project website. More details follow.")
        result = ablation.predict_case(pair(a, b), "hierarchical", FakeRuntime())
        self.assertTrue(result["identityReady"])
        self.assertFalse(result["nativeEvidenceAligned"])
        judged = ablation.judge(result, shadow.DEFAULT_THRESHOLDS)
        self.assertEqual(judged["decision"], "uncertain")
        self.assertEqual(judged["reason"], "no_aligned_event_claims")

    def test_extraction_metrics_count_wrong_and_missing_without_oracle_override(self):
        case = pair(a=document(expectedSlots={"actor": ["wrong"], "event_date": ["2025-03-12"],
                                             "version": None, "polarity": ["positive"]}))
        prediction = ablation.predict_case(case, "clean", FakeRuntime())
        result = ablation.extraction_metrics([case], [prediction])
        self.assertEqual(result["uniqueDocuments"], 1)
        self.assertEqual(result["annotatedSlots"], 3)
        self.assertEqual(result["correctSlots"], 1)
        self.assertEqual(result["missingKnownSlots"], 1)
        self.assertEqual(result["wrongOrUnexpectedSlots"], 1)

    def test_persisted_evidence_has_offsets_and_hashes_without_repeated_source_text(self):
        prediction = ablation.predict_case(pair(), "clean", FakeRuntime())
        saved = ablation.persisted_result(prediction)
        self.assertNotIn(BODY, json.dumps(saved))
        self.assertEqual(saved["evidence"][0]["claims"][0]["start"], 0)
        self.assertIn("quoteSha256", saved["evidence"][0]["claims"][0])
        self.assertIn("quote", prediction["evidence"][0]["claims"][0])
        self.assertEqual(saved["inputs"][0]["fingerprint"], shadow.fingerprint(prediction["inputs"][0]))

    def test_public_controls_are_not_natural_pair_metrics(self):
        case = pair(isControl=True)
        prediction = ablation.predict_case(case, "hierarchical", FakeRuntime())
        threshold = ablation.calibrate([prediction], "minilm", "hierarchical")
        with patch.object(ablation.importlib.metadata, "version", return_value="unit-test"):
            result = ablation.report([case], [prediction], threshold, "calibration", FakeRuntime())
        self.assertEqual(result["metrics"]["acceptedSameCopyOrEvent"], 1)
        self.assertEqual(result["nonControlMetrics"]["labeledPairs"], 0)
        self.assertEqual(result["controlMetrics"]["labeledPairs"], 1)
        self.assertIsNone(result["modeledPairsLatencyMedianMs"])
        self.assertTrue(result["calibrationPolicySatisfied"])

    def test_memory_guard_and_native_token_guard_do_not_load_or_call_a_model(self):
        with patch.object(ablation, "available_memory_mib", return_value=100):
            with self.assertRaisesRegex(RuntimeError, "Model not loaded"):
                ablation.NliRuntime("minilm", Path("unused"))
        runtime = ablation.NliRuntime.__new__(ablation.NliRuntime)
        runtime.tokenizer = MagicMock()
        runtime.tokenizer.return_value = {"input_ids": MagicMock(shape=(1, 513))}
        runtime.model = MagicMock()
        self.assertEqual(runtime.infer("premise", "hypothesis"), (None, 513))
        runtime.model.assert_not_called()
        self.assertFalse(runtime.tokenizer.call_args.kwargs["truncation"])

    def test_cli_freezes_all_thresholds_before_evaluation_and_preserves_reports(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "run"
            arguments = [
                "news_decision_ablation.py", "--cache-dir", str(Path(temporary) / "unused-cache"),
                "--calibration-input", str(ROOT / "shared" / "news-pair-cases.json"),
                "--development-input", str(ROOT / "shared" / "news-pair-cases.json"),
                "--development-input", str(ROOT / "shared" / "news-pair-confirmation.json"),
                "--confirmation-input", str(ROOT / "shared" / "news-pair-public-confirmation.json"),
                "--output-dir", str(output),
            ]
            original_predict = ablation.predict_case

            def predict(case, protocol, runtime):
                if case["split"] != "calibration":
                    self.assertTrue(all((output / f"{arm}-thresholds.json").exists() for arm in ablation.PROTOCOLS))
                return original_predict(case, protocol, runtime)

            def load(*_):
                self.assertTrue((output / "manifest.json").exists())
                return FakeRuntime()

            with patch.object(sys, "argv", arguments), patch.object(ablation, "NliRuntime", side_effect=load) as loader, \
                 patch.object(ablation, "predict_case", side_effect=predict), \
                 patch.object(ablation.importlib.metadata, "version", return_value="unit-test"), \
                 redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                ablation.main()
                self.assertEqual(loader.call_count, 1)
                self.assertEqual(len(list(output.glob("*.json"))), 17)
                before = {path: path.read_bytes() for path in output.glob("*.json")}
                with self.assertRaises(SystemExit):
                    ablation.main()
                self.assertEqual(loader.call_count, 1)
                self.assertEqual(before, {path: path.read_bytes() for path in output.glob("*.json")})


if __name__ == "__main__":
    unittest.main()
