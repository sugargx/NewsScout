"""Bounded, source-grounded preparation for offline news-relation experiments."""

import re
import unicodedata
from datetime import date as calendar_date


VERSION = "news-evidence-v1"
MAX_SENTENCES = 96
MAX_CLAIMS = 3
SLOTS = ("actor", "action", "object", "version", "event_date", "application", "polarity")
BOUNDARY = re.compile(r"[。！？!?]+|\.(?=\s|$)|\n+")
CRITICAL = re.compile(
    r"\b(?:not|never|no|cancel\w*|withdraw\w*|retract\w*|denied|correction|postpon\w*)\b"
    r"|不|未|取消|撤回|否认|推迟|更正|辟谣", re.I,
)
VERSION_TOKEN = re.compile(
    r"\b(?:version\s*|v)(\d+(?:\.\d+){0,3}(?:-[A-Za-z0-9]+)?)(?![\w.])"
    r"|版本\s*(\d+(?:\.\d+){0,3})(?![\w.])", re.I,
)
DATE_TOKEN = re.compile(r"\b(20\d{2})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])\b|"
                        r"(20\d{2})年(1[0-2]|0?[1-9])月(3[01]|[12]\d|0?[1-9])日")
EN_FRAME = re.compile(
    r"(?P<actor>[A-Z][\w&.-]*(?:[ \t]+[A-Z][\w&.-]*){0,3})"
    r"(?:[ \t]+(?:today|has|have|just|also|separately))*[ \t]+"
    r"(?P<polarity>(?:not|never)[ \t]+)?"
    r"(?P<action>(?i:releases?|released|launch(?:es|ed)?|introduces?|introduced|"
    r"acquires?|acquired|publishes?|published|open-sources?|open-sourced))"
    r"[ \t]+(?P<object>.+)"
)
ZH_FRAME = re.compile(
    r"^(?P<actor>[\w\u3400-\u9fff·&.-]{2,30}?)(?:团队|公司)?"
    r"(?:宣布|正式|已经|已|另外)?(?P<polarity>没有|尚未|未|不再)?"
    r"(?P<action>发布|推出|上线|收购|开源)(?P<object>.+)"
)
ACTION = {
    **dict.fromkeys(("release", "releases", "released", "launch", "launches", "launched",
                     "introduce", "introduces", "introduced", "发布", "推出", "上线"), "release"),
    **dict.fromkeys(("acquire", "acquires", "acquired", "收购"), "acquire"),
    **dict.fromkeys(("publish", "publishes", "published"), "publish"),
    **dict.fromkeys(("open-source", "open-sources", "open-sourced", "开源"), "open_source"),
}
OBJECT_END = re.compile(r"[,;，；。]|面向|[ \t]+(?:with|for|on|that|which|to help)\b|\.(?=\s|$)", re.I)
APPLICATION = re.compile(r"\bfor[ \t]+([^,.;\n]+)|面向([^，。；\n]+)", re.I)
NON_ACTORS = {"we", "i", "our", "the", "this", "it", "they", "he", "she",
              "我们", "我", "他们", "本公司", "该公司", "本团队", "它", "它们"}
UNSUPPORTED_CONTEXT = re.compile(
    r"\b(?:will|may|plan\w*|might|could|would|if|rumou?r\w*|expect\w*|not|never)\b"
    r"|计划|可能|据传|是否|今天|将", re.I,
)
STOP_WORDS = {"the", "and", "for", "with", "from", "this", "that", "new", "model", "models",
              "release", "released", "launch", "launched", "today", "article", "report"}


def normalized(text):
    return " ".join(unicodedata.normalize("NFC", text).split())


def key(text):
    return "".join(char.casefold() for char in normalized(text) if char.isalnum())


def span(document, field, start, end):
    text = document[field]
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return {"field": field, "start": start, "end": end, "quote": text[start:end]}


def grounded(document, item):
    return (item["field"] in {"title", "excerpt"} and
            0 <= item["start"] < item["end"] <= len(document[item["field"]]) and
            document[item["field"]][item["start"]:item["end"]] == item["quote"])


def sentences(document):
    text, start, result = document["excerpt"], 0, []
    for boundary in BOUNDARY.finditer(text):
        item = span(document, "excerpt", start, boundary.end())
        if item["quote"]:
            result.append(item)
        start = boundary.end()
    item = span(document, "excerpt", start, len(text))
    if item["quote"]:
        result.append(item)
    return result


def anchors(text):
    words = {word.casefold() for word in re.findall(r"[A-Za-z][A-Za-z0-9_.-]{2,}", text)}
    chinese = re.findall(r"[\u3400-\u9fff]+", text)
    return (words - STOP_WORDS) | {word[index:index + 2] for word in chinese for index in range(len(word) - 1)}


def _slot(document, clause, start, end, value=None):
    result = span(document, clause["field"], clause["start"] + start, clause["start"] + end)
    result["value"] = normalized(result["quote"]).casefold() if value is None else value
    return result


def _frames(document, clause):
    text = clause["quote"]
    match = EN_FRAME.search(text) or ZH_FRAME.search(text)
    if match is None or "?" in text or "？" in text:
        return []
    actor_start, actor_end = match.span("actor")
    if text[actor_start:actor_end].startswith("Today "):
        actor_start += len("Today ")
    actor = text[actor_start:actor_end]
    if (actor.casefold() in NON_ACTORS or UNSUPPORTED_CONTEXT.search(text[:actor_start] + actor) or
        DATE_TOKEN.search(actor) or (match.start() and text[match.start() - 1].isalnum())):
        return []
    tail = match.group("object")
    if EN_FRAME.search(tail) or ZH_FRAME.search(tail):
        return []
    end = OBJECT_END.search(tail)
    object_end = end.start() if end else len(tail)
    object_start = match.start("object")
    object_span = _slot(document, clause, object_start, object_start + object_end)
    if not object_span["quote"] or len(object_span["quote"]) > 120:
        return []
    frame = {name: None for name in SLOTS}
    frame["actor"] = _slot(document, clause, actor_start, actor_end)
    action = ACTION[match.group("action").casefold()]
    frame["action"] = _slot(document, clause, *match.span("action"), action)
    frame["object"] = object_span
    polarity = match.span("polarity") if match.group("polarity") else match.span("action")
    frame["polarity"] = _slot(document, clause, *polarity, "negative" if match.group("polarity") else "positive")
    version_matches = list(VERSION_TOKEN.finditer(object_span["quote"]))
    if len(version_matches) == 1:
        version = version_matches[0]
        value = next(group for group in version.groups() if group is not None)
        frame["version"] = _slot(document, clause, object_span["start"] - clause["start"] + version.start(),
                                 object_span["start"] - clause["start"] + version.end(), value.casefold())
    dates = [item for item in DATE_TOKEN.finditer(text)
             if re.search(r"(?:\bon\s+|于|在)$", text[:item.start()], re.I)]
    if len(dates) == 1:
        date = dates[0]
        parts = [int(value) for value in date.groups() if value is not None]
        try:
            value = calendar_date(*parts).isoformat()
        except ValueError:
            value = None
        if value:
            frame["event_date"] = _slot(document, clause, *date.span(), value)
    application = APPLICATION.search(tail)
    if application:
        group = 1 if application.group(1) else 2
        application_end = application.end(group)
        following_date = re.search(r"\s+on\s+20\d{2}-|于20\d{2}年", application.group(group), re.I)
        if following_date:
            application_end = application.start(group) + following_date.start()
        frame["application"] = _slot(document, clause, object_start + application.start(group),
                                     object_start + application_end)
    frame["evidence"] = clause
    return [frame]


def prepare(document):
    body = sentences(document)
    title = span(document, "title", 0, len(document["title"]))
    title_anchors = anchors(title["quote"])
    critical = {index for index, item in enumerate(body) if CRITICAL.search(item["quote"])}
    priorities = sorted(range(len(body)), key=lambda index: (
        index in critical, index == 0, len(anchors(body[index]["quote"]) & title_anchors), -index
    ), reverse=True)
    selected = sorted(priorities[:MAX_CLAIMS])
    frames = []
    for item in [title, *body[:MAX_SENTENCES]]:
        frames.extend(_frames(document, item))
    values = {name: sorted({frame[name]["value"] for frame in frames if frame[name]}) for name in SLOTS}
    return {
        "title": title, "claims": [body[index] for index in selected], "frames": frames,
        "slotValues": values, "unknownSlots": [name for name, items in values.items() if not items],
        "ambiguousSlots": [name for name, items in values.items() if len(items) > 1],
        "omittedSentenceCount": len(body) - len(selected),
        "omittedCriticalCount": len(critical - set(selected)),
        "scanLimited": len(body) > MAX_SENTENCES,
        "sourceCharacters": len(document["excerpt"]),
    }


def validate_card(document, card):
    items = [card["title"], *card["claims"]]
    for frame in card["frames"]:
        items.append(frame["evidence"])
        items.extend(frame[name] for name in SLOTS if frame[name])
    return all(grounded(document, item) for item in items if item["quote"])


def plain_pair(pair):
    return "\n\n".join(f"Report {name}:\n{normalized(document['title'])}\n{normalized(document['excerpt'])}"
                       for name, document in zip(("A", "B"), pair))


def evidence_pair(cards):
    reports = []
    for name, card in zip(("A", "B"), cards):
        lines = [f"Report {name}:", "Title: " + card["title"]["quote"], "Verbatim evidence:"]
        lines.extend(item["quote"] for item in card["claims"])
        lines.append("Explicit event fields (unknown means not extracted):")
        for slot in SLOTS:
            values = card["slotValues"][slot]
            lines.append(f"{slot}: " + (" | ".join(values) if values else "unknown"))
        reports.append("\n".join(lines))
    return "\n\n".join(reports)


def same_copy(pair):
    a, b = pair
    title_a, title_b = normalized(a["title"]).casefold(), normalized(b["title"]).casefold()
    if not 24 <= len(key(title_a)) <= 240 or title_a != title_b:
        return False
    left, right = normalized(a["excerpt"]), normalized(b["excerpt"])
    # Deliberately stricter than the portal's retained-core matcher: no substring
    # match or punctuation removal can conceal appended corrections or signs.
    return (len(left) >= 100 and left == right and
            len({left[index:index + 5] for index in range(len(left) - 4)}) >= 60)


def conflicts(cards):
    a, b = cards
    findings = []
    for left in a["frames"]:
        for right in b["frames"]:
            value = lambda frame, name: frame[name]["value"] if frame[name] else None
            if value(left, "action") == value(right, "action") == "acquire" and (
                value(left, "actor") == value(right, "object") and
                value(left, "object") == value(right, "actor") and
                value(left, "actor") != value(left, "object")
            ):
                findings.append({"kind": "swapped_actor_object", "a": left["evidence"], "b": right["evidence"]})
            same_actor = value(left, "actor") == value(right, "actor")
            same_action = value(left, "action") == value(right, "action")
            if not same_actor or not same_action:
                continue
            for slot in ("version", "event_date", "application", "polarity"):
                left_value, right_value = value(left, slot), value(right, slot)
                if left_value and right_value and left_value != right_value:
                    findings.append({"kind": "different_" + slot, "a": left[slot], "b": right[slot]})
    return findings


def identity_ready(cards):
    if any(card["ambiguousSlots"] or card["scanLimited"] or card["omittedCriticalCount"] for card in cards):
        return False
    a, b = [card["slotValues"] for card in cards]
    if any(len(a[name]) != 1 or len(b[name]) != 1 or a[name][0] != b[name][0]
           for name in ("actor", "action", "object", "polarity")):
        return False
    if a["application"] != b["application"]:
        return False
    # A publication timestamp is not an event date. A shared version or an
    # explicit event date must anchor otherwise repeated announcements.
    return any(len(a[name]) == len(b[name]) == 1 and a[name][0] == b[name][0]
               for name in ("version", "event_date"))


def claim_has_identity(card, claim):
    return any(
        frame["evidence"]["field"] == claim["field"] and
        frame["evidence"]["start"] == claim["start"] and frame["evidence"]["end"] == claim["end"] and
        all(frame[name] and [frame[name]["value"]] == card["slotValues"][name]
            for name in ("actor", "action", "object", "polarity"))
        for frame in card["frames"]
    )


def nli_probabilities(logits, label2id):
    import math

    heads = {name.lower(): index for name, index in label2id.items()}
    if (set(heads) != {"entailment", "neutral", "contradiction"} or
        set(heads.values()) != set(range(3)) or len(logits) != 3 or
        any(not math.isfinite(value) for value in logits)):
        raise ValueError("Expected three finite, explicitly named NLI heads")
    maximum = max(logits)
    exp = [math.exp(value - maximum) for value in logits]
    denominator = sum(exp)
    return {name: exp[index] / denominator for name, index in heads.items()}
