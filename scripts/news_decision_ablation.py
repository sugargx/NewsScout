"""Four offline input/task ablations with one pinned NLI checkpoint."""

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import statistics
import time

import news_decision_shadow as shadow
import news_evidence as evidence


PROTOCOLS = ("raw", "clean", "evidence", "hierarchical")
MINIMUM_SCORES = (0.5, 0.7, 0.8, 0.9, 0.95, 0.99)
MINIMUM_MARGINS = (0.1, 0.2, 0.3, 0.5)


def load_pairs(path, split):
    if path.stat().st_size > shadow.MAX_INPUT_BYTES:
        raise ValueError("Input exceeds the bounded local batch size")
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if "documents" in data:
        documents = data["documents"]
        if not isinstance(documents, dict) or len(documents) > 2 * shadow.MAX_PAIRS:
            raise ValueError("Invalid bounded document table")
        cases = []
        for case in data["cases"]:
            if any(not isinstance(case.get(side), str) or case[side] not in documents for side in ("a", "b")):
                raise ValueError("Unknown source-document reference")
            cases.append(dict(case, a=dict(documents[case["a"]]), b=dict(documents[case["b"]])))
        data = dict(data, cases=cases)
    selected = shadow.select_cases(data, split)
    for case in selected:
        if not isinstance(case.get("isControl", False), bool):
            raise ValueError("isControl must be an explicit boolean")
        for side in ("a", "b"):
            reference = case[side].get("expectedSlots", {})
            if not isinstance(reference, dict) or set(reference) - set(evidence.SLOTS):
                raise ValueError("Unknown evidence-slot reference")
            for expected in reference.values():
                if expected is not None and (not isinstance(expected, list) or
                    any(not isinstance(value, str) for value in expected) or len(set(expected)) != len(expected)):
                    raise ValueError("Slot references must be null or distinct string lists")
    return selected


def document_fingerprints(cases):
    return {document_fingerprint(document) for case in cases for document in shadow.documents(case)}


def document_fingerprint(document):
    return shadow.fingerprint([evidence.normalized(document["title"]), evidence.normalized(document["excerpt"])])


def slot_references(cases):
    references = {}
    for case in cases:
        for side in ("a", "b"):
            original = case[side]
            reference = references.setdefault(document_fingerprint(original), {})
            for name, values in original.get("expectedSlots", {}).items():
                if values is None:
                    continue
                expected = sorted(values)
                if name in reference and reference[name] != expected:
                    raise ValueError("Conflicting annotations for the same original document")
                reference[name] = expected
    return references


def validate_partitions(calibration, development, confirmation):
    groups = (calibration, development, confirmation)
    if any(not cases for cases in groups) or sum(map(len, groups)) > shadow.MAX_PAIRS:
        raise ValueError("The complete three-partition experiment exceeds the bounded pair budget")
    all_ids = [case["id"] for cases in groups for case in cases]
    if len(set(all_ids)) != len(all_ids):
        raise ValueError("Pair ids must be unique across all files and partitions")
    for index, cases in enumerate(groups):
        if any(case.get("expected") is None for case in cases):
            raise ValueError("This comparison requires independently labeled pairs")
        documents = document_fingerprints(cases)
        families = {case.get("family", case["id"]) for case in cases}
        for other in groups[index + 1:]:
            if (documents & document_fingerprints(other) or
                families & {case.get("family", case["id"]) for case in other}):
                raise ValueError("A story family or original document crosses evaluation partitions")
    slot_references([case for cases in groups for case in cases])


def load_experiment(calibration_path, development_paths, confirmation_path):
    paths = {calibration_path.resolve(), confirmation_path.resolve(),
             *(path.resolve() for path in development_paths)}
    if sum(path.stat().st_size for path in paths) > shadow.MAX_INPUT_BYTES:
        raise ValueError("Combined input files exceed the bounded local batch size")
    groups = (
        load_pairs(calibration_path, "calibration"),
        [case for path in development_paths for case in load_pairs(path, "holdout")],
        load_pairs(confirmation_path, "holdout"),
    )
    validate_partitions(*groups)
    return groups


def protocol_fingerprint(model_key, protocol):
    source_hashes = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (Path(__file__), Path(evidence.__file__), Path(shadow.__file__))
    }
    return shadow.fingerprint({
        "version": 1, "protocol": protocol, "model": shadow.MODELS[model_key],
        "sources": source_hashes, "maxTokens": shadow.MAX_TOKENS,
        "minimumScores": MINIMUM_SCORES, "minimumMargins": MINIMUM_MARGINS,
    })


def available_memory_mib():
    if os.name != "nt":
        return None
    import ctypes

    class MemoryStatus(ctypes.Structure):
        _fields_ = [("length", ctypes.c_uint32), ("load", ctypes.c_uint32)] + [
            (name, ctypes.c_uint64) for name in
            ("totalPhysical", "availablePhysical", "totalPage", "availablePage",
             "totalVirtual", "availableVirtual", "availableExtended")
        ]

    state = MemoryStatus()
    state.length = ctypes.sizeof(state)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(MemoryStatus)]
    if not kernel.GlobalMemoryStatusEx(ctypes.byref(state)):
        raise OSError(ctypes.get_last_error(), "Cannot check model-loading headroom")
    return state.availablePhysical / 1024 ** 2


class NliRuntime:
    def __init__(self, model_key, cache):
        profile = shadow.MODELS[model_key]
        if profile["adapter"] != "nli":
            raise ValueError("All four arms require the same three-head NLI checkpoint")
        available = available_memory_mib()
        minimum = 1800 if model_key == "minilm" else 3000
        if available is not None and available < minimum:
            raise RuntimeError(f"Model not loaded: {available:.0f} MiB available; guard requires {minimum} MiB")
        shadow.environment()
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        import torch
        from huggingface_hub import snapshot_download
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        torch.set_num_threads(2)
        torch.manual_seed(0)
        started = time.perf_counter()
        location = snapshot_download(profile["id"], revision=profile["revision"], cache_dir=cache,
                                     local_files_only=True, token=False, allow_patterns=shadow.MODEL_FILES)
        self.tokenizer = AutoTokenizer.from_pretrained(location, local_files_only=True, trust_remote_code=False)
        self.model = AutoModelForSequenceClassification.from_pretrained(
            location, local_files_only=True, trust_remote_code=False, use_safetensors=True, dtype=torch.float32,
        ).cpu().eval()
        self.profile, self.torch = profile, torch
        self.load_seconds = round(time.perf_counter() - started, 2)

    def classify(self, text):
        with self.torch.inference_mode():
            return shadow.score_text(self.profile, self.tokenizer, self.model, None, text)

    def infer(self, premise, hypothesis):
        inputs = self.tokenizer(premise, hypothesis, return_tensors="pt", truncation=False)
        count = inputs["input_ids"].shape[1]
        if count > shadow.MAX_TOKENS:
            return None, count
        with self.torch.inference_mode():
            logits = self.model(**inputs).logits[0].float().tolist()
        return evidence.nli_probabilities(logits, self.model.config.label2id), count


def native_scores(cards, runtime):
    matrices = [[], []]
    counts = []
    for a_index, a in enumerate(cards[0]["claims"]):
        for b_index, b in enumerate(cards[1]["claims"]):
            for direction, (premise, hypothesis) in enumerate(((a, b), (b, a))):
                probabilities, count = runtime.infer(premise["quote"], hypothesis["quote"])
                counts.append(count)
                matrices[direction].append({
                    "aClaim": a_index, "bClaim": b_index, "probabilities": probabilities,
                    "tokens": count, "sharedAnchor": bool(evidence.anchors(a["quote"]) & evidence.anchors(b["quote"])),
                    "eventClaim": evidence.claim_has_identity(cards[0], a) and evidence.claim_has_identity(cards[1], b),
                })
    score_sets = []
    for matrix in matrices:
        usable = [entry for entry in matrix if entry["probabilities"] is not None]
        scores = {name: 0.0 for name in shadow.LABELS}
        if not usable:
            scores["uncertain"] = 1.0
        else:
            aligned = [entry for entry in usable if entry["eventClaim"]]
            best = max(aligned or usable, key=lambda entry: entry["probabilities"]["entailment"])
            scores["same_event"] = best["probabilities"]["entailment"]
            scores["uncertain"] = best["probabilities"]["neutral"]
            scores["related_different"] = max(
                (entry["probabilities"]["contradiction"] for entry in usable if entry["sharedAnchor"]),
                default=0.0,
            )
        score_sets.append(scores)
    return score_sets, matrices, max(counts, default=0)


def predict_case(case, protocol, runtime):
    if protocol not in PROTOCOLS:
        raise ValueError("Unknown ablation protocol")
    started = time.perf_counter()
    pair = shadow.documents(case)
    cards = [evidence.prepare(document) for document in pair]
    if not all(evidence.validate_card(document, card) for document, card in zip(pair, cards)):
        raise ValueError("An extracted field or claim is not an exact original span")
    incomplete = any(len(document["excerpt"].strip()) < 50 for document in pair)
    omitted = any(card["scanLimited"] or card["omittedCriticalCount"] for card in cards)
    result = {
        "id": case["id"], "family": case.get("family", case["id"]),
        "split": case.get("split", "observation"), "expected": case["expected"],
        "isControl": case.get("isControl", False),
        "inputFingerprint": shadow.fingerprint(pair), "inputs": pair,
        "evidence": cards, "protocol": protocol,
        "canMerge": False, "action": "observe_only", "publisherIndependence": "not_established",
        "copyRule": False, "conflicts": [], "identityReady": evidence.identity_ready(cards),
        "modelUsed": True, "nativeComparisons": [], "nativeEvidenceAligned": False,
    }
    if protocol == "hierarchical":
        incomplete = incomplete or omitted
        result["conflicts"] = evidence.conflicts(cards)
        result["copyRule"] = not incomplete and evidence.same_copy(pair)
        if incomplete or result["copyRule"] or result["conflicts"]:
            label = "uncertain" if incomplete else "same_copy" if result["copyRule"] else "related_different"
            score_sets = [{name: float(name == label) for name in shadow.LABELS}] * 2
            tokens = 0
            result["modelUsed"] = False
        else:
            score_sets, result["nativeComparisons"], tokens = native_scores(cards, runtime)
            result["nativeEvidenceAligned"] = all(
                any(entry["eventClaim"] and entry["probabilities"] is not None for entry in matrix)
                for matrix in result["nativeComparisons"]
            )
    else:
        score_sets, counts = [], []
        for order in (False, True):
            documents = pair[::-1] if order else pair
            if protocol == "raw":
                text = "Report A:\n" + json.dumps(documents[0], ensure_ascii=False) + "\nReport B:\n" + json.dumps(documents[1], ensure_ascii=False)
            elif protocol == "clean":
                text = evidence.plain_pair(documents)
            else:
                text = evidence.evidence_pair(cards[::-1] if order else cards)
            scores, count = runtime.classify(text)
            score_sets.append(scores)
            counts.append(count)
        tokens = max(counts)
        if protocol == "evidence":
            incomplete = incomplete or omitted
    for scores in score_sets:
        shadow.validate_scores(scores)
    result.update(scores=score_sets[0], reverseScores=score_sets[1],
                  incomplete=incomplete or tokens > shadow.MAX_TOKENS, estimatedTokens=tokens,
                  modelForwardCalls=(0 if not result["modelUsed"] else
                                     sum(entry["probabilities"] is not None for matrix in result["nativeComparisons"]
                                         for entry in matrix) if protocol == "hierarchical" else 2 * len(shadow.HYPOTHESES)),
                  elapsedMs=round((time.perf_counter() - started) * 1000, 1))
    return result


def judge(result, thresholds):
    decision, reason, raw = shadow.decide(
        result["scores"], result["reverseScores"], thresholds, incomplete=result["incomplete"],
    )
    if result["protocol"] == "hierarchical" and not result["incomplete"]:
        if result["copyRule"]:
            decision, reason = "same_copy", "retained_text_copy_rule"
        elif result["conflicts"]:
            decision, reason = "related_different", "grounded_fact_conflict"
        elif decision in shadow.MERGE_LABELS and not result["identityReady"]:
            decision, reason = "uncertain", "missing_or_ambiguous_event_identity"
        elif decision in shadow.MERGE_LABELS and not result["nativeEvidenceAligned"]:
            decision, reason = "uncertain", "no_aligned_event_claims"
    return dict(result, decision=decision, reason=reason, rawLabel=raw)


def calibrate(results, model_key, protocol):
    if any(result["split"] != "calibration" or result["expected"] is None for result in results):
        raise ValueError("Only labeled calibration pairs can fit a protocol")
    choices = []
    for minimum in MINIMUM_SCORES:
        for margin in MINIMUM_MARGINS:
            thresholds = {"minimumScore": minimum, "minimumMargin": margin}
            metrics = shadow.metrics([judge(result, thresholds) for result in results])
            if metrics["falseMerges"] == 0 and metrics["copyVsIndependentErrors"] == 0:
                choices.append((metrics["acceptedSameCopyOrEvent"], minimum, margin, thresholds))
    thresholds = max(choices, key=lambda choice: choice[:3])[-1] if choices else {
        "minimumScore": 1.0, "minimumMargin": 1.0,
    }
    return {
        "version": 1, "model": shadow.MODELS[model_key]["id"], "revision": shadow.MODELS[model_key]["revision"],
        "protocol": protocol, "protocolFingerprint": protocol_fingerprint(model_key, protocol),
        "thresholds": thresholds, "calibrationPolicySatisfied": bool(choices),
        "calibrationMetrics": shadow.metrics([judge(result, thresholds) for result in results]),
        "calibrationFamilies": sorted({result["family"] for result in results}),
        "calibrationInputFingerprints": [result["inputFingerprint"] for result in results],
        "calibratedProbabilities": False, "productionApproved": False,
    }


def extraction_metrics(cases, results):
    slots = []
    seen = set()
    references = slot_references(cases)
    for case, result in zip(cases, results):
        for side, card, original in zip(("a", "b"), result["evidence"], result["inputs"]):
            fingerprint = document_fingerprint(original)
            if fingerprint in seen:
                continue
            seen.add(fingerprint)
            reference = references[fingerprint]
            for name, expected in reference.items():
                if name not in evidence.SLOTS or expected is None:
                    continue
                observed = card["slotValues"][name]
                expected = sorted(expected)
                slots.append({
                    "document": fingerprint, "slot": name, "expected": expected, "observed": observed,
                    "correct": expected == observed,
                    "missing": bool(expected) and not observed,
                    "unsupportedValue": bool(set(observed) - set(expected)),
                })
    return {
        "uniqueDocuments": len(seen), "allReportedSpansGrounded": True,
        "annotatedSlots": len(slots), "correctSlots": sum(slot["correct"] for slot in slots),
        "knownAnnotatedSlots": sum(bool(slot["expected"]) for slot in slots),
        "knownSlotsCorrect": sum(slot["correct"] and bool(slot["expected"]) for slot in slots),
        "referenceUnknownSlots": sum(not slot["expected"] for slot in slots),
        "correctUnknownSlots": sum(slot["correct"] and not slot["expected"] for slot in slots),
        "referenceValues": sum(len(slot["expected"]) for slot in slots),
        "recoveredReferenceValues": sum(len(set(slot["expected"]) & set(slot["observed"])) for slot in slots),
        "extractedValues": sum(len(slot["observed"]) for slot in slots),
        "missingKnownSlots": sum(slot["missing"] for slot in slots),
        "wrongOrUnexpectedSlots": sum(slot["unsupportedValue"] for slot in slots),
        "slotDetails": slots,
        "note": "Exact span grounding does not prove correct semantic roles; slot accuracy exists only where independently annotated.",
    }


def source_references(value):
    if isinstance(value, list):
        return [source_references(item) for item in value]
    if isinstance(value, dict):
        result = {key: source_references(item) for key, item in value.items() if key != "quote"}
        if "quote" in value:
            result["quoteSha256"] = hashlib.sha256(value["quote"].encode("utf-8")).hexdigest()
        return result
    return value


def persisted_result(result):
    # Original text lives once in the frozen fixture. Reports retain auditable
    # offsets/hashes rather than multiplying copyrighted quotations.
    result = source_references(result)
    result["inputs"] = [{"fingerprint": shadow.fingerprint(original),
                         "evidenceFingerprint": document_fingerprint(original), "url": original["url"]}
                        for original in result["inputs"]]
    return result


def report(cases, predictions, threshold, phase, runtime):
    results = [judge(result, threshold["thresholds"]) for result in predictions]
    latency = sorted(result["elapsedMs"] for result in results)
    modeled_latency = [result["elapsedMs"] for result in results if result["modelUsed"]]
    return {
        "version": 1, "phase": phase, "model": threshold["model"], "revision": threshold["revision"],
        "protocol": threshold["protocol"], "protocolFingerprint": threshold["protocolFingerprint"],
        "thresholds": threshold["thresholds"], "productionApproved": False, "calibratedProbabilities": False,
        "calibrationPolicySatisfied": threshold["calibrationPolicySatisfied"],
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "device": "cpu", "threads": 2, "dtype": "float32", "maxTokens": shadow.MAX_TOKENS,
        "modelLoadedOnceForAllArms": True, "loadSeconds": runtime.load_seconds,
        "dependencies": {name: importlib.metadata.version(name) for name in ("transformers", "torch", "numpy")},
        "latencyMedianMs": statistics.median(latency),
        "modeledPairsLatencyMedianMs": statistics.median(modeled_latency) if modeled_latency else None,
        "latencyP95Ms": latency[min(len(latency) - 1, math.ceil(len(latency) * 0.95) - 1)],
        "peakProcessMemoryMBCumulative": shadow.peak_memory_mb(),
        "metrics": shadow.metrics(results),
        "nonControlMetrics": shadow.metrics([result for result in results if not result["isControl"]]),
        "controlMetrics": shadow.metrics([result for result in results if result["isControl"]]),
        "attribution": dict(Counter(result["reason"] for result in results)),
        "modelCallsSkippedPairs": sum(not result["modelUsed"] for result in results),
        "modelForwardCalls": sum(result["modelForwardCalls"] for result in results),
        "extraction": extraction_metrics(cases, results), "results": [persisted_result(result) for result in results],
        "evidenceStorage": "Original title/excerpt text occurs only in the frozen input fixture; span offsets and SHA256 hashes resolve into those originals.",
        "note": "Development data was previously seen. Confirmation is a small hand-labeled check, not an external blind benchmark. Hierarchical raw labels are native-support diagnostics, not a five-class accuracy comparator.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=[key for key, profile in shadow.MODELS.items() if profile["adapter"] == "nli"],
                        default="minilm")
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--calibration-input", type=Path, required=True)
    parser.add_argument("--development-input", type=Path, action="append", required=True)
    parser.add_argument("--confirmation-input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.output_dir.exists() and any(args.output_dir.iterdir()):
        parser.error("Use a new empty output directory; existing measurements must not be overwritten")
    calibration, development, confirmation = load_experiment(
        args.calibration_input, args.development_input, args.confirmation_input,
    )
    paths = [args.calibration_input, *args.development_input, args.confirmation_input]
    manifest = {
        "model": args.model, "protocols": {name: protocol_fingerprint(args.model, name) for name in PROTOCOLS},
        "inputs": {str(path.resolve()): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths},
        "protocolsFrozenBeforeInference": True, "productionApproved": False,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "counts": {"calibration": len(calibration), "development": len(development), "confirmation": len(confirmation)},
    }
    shadow.write_json(args.output_dir / "manifest.json", manifest)
    runtime = NliRuntime(args.model, args.cache_dir)
    thresholds = {}
    for protocol in PROTOCOLS:
        predictions = [predict_case(case, protocol, runtime) for case in calibration]
        thresholds[protocol] = calibrate(predictions, args.model, protocol)
        shadow.write_json(args.output_dir / f"{protocol}-thresholds.json", thresholds[protocol])
        shadow.write_json(args.output_dir / f"{protocol}-calibration.json",
                          report(calibration, predictions, thresholds[protocol], "calibration", runtime))
    for phase, cases in (("development", development), ("confirmation", confirmation)):
        for protocol in PROTOCOLS:
            predictions = []
            for case in cases:
                predictions.append(predict_case(case, protocol, runtime))
                print(json.dumps({"phase": phase, "protocol": protocol, "pair": case["id"]}), flush=True)
            result = report(cases, predictions, thresholds[protocol], phase, runtime)
            shadow.write_json(args.output_dir / f"{protocol}-{phase}.json", result)
            print(json.dumps({"phase": phase, "protocol": protocol, "metrics": result["metrics"]}), flush=True)


if __name__ == "__main__":
    main()
