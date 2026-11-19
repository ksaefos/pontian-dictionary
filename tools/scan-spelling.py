#!/usr/bin/env python3
"""Produce an advisory proofreading report for the published dictionary snapshot."""

import argparse
from collections import defaultdict
import ctypes as c
from ctypes.util import find_library
import hashlib
import json
from pathlib import Path
import re
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
FORMAT = "pontian-proofreading-v2"
ABBREVIATIONS = json.loads((ROOT / "tools/abbreviations.json").read_text())
ABBREVIATION_FORMS = {form: rule for rule in ABBREVIATIONS.values() for form in rule["forms"]}
FIELDS = {0: "lemma", 1: "definition", 2: "root", 6: "diminutive"}
WORD = re.compile(r"[Α-Ωα-ωΆΈΉΊΌΎΏΪΫάέήίόύώϊϋΐΰ\u0300-\u036f]+")
# Whole-word corrections for modern Greek explanations. Add verified examples here.
CORRECTIONS = {"διακρητικό": "διακριτικό", "αγαλέδα": "αγελάδα"}
RULES = [
    ("apostrophe", re.compile(r"'"), "’"),
    ("spacing", re.compile(r" {2,}"), " "),
    ("invisible", re.compile(r"[\u00ad\u200b\ufeff]"), None),
]


class Hunspell:
    def __init__(self, prefix):
        self.lib = c.CDLL(find_library("hunspell-1.7") or find_library("hunspell") or "libhunspell-1.7.so.0")
        bindings = {
            "create": ([c.c_char_p, c.c_char_p], c.c_void_p),
            "destroy": ([c.c_void_p], None),
            "get_dic_encoding": ([c.c_void_p], c.c_char_p),
            "spell": ([c.c_void_p, c.c_char_p], c.c_int),
            "suggest": ([c.c_void_p, c.POINTER(c.POINTER(c.c_char_p)), c.c_char_p], c.c_int),
            "free_list": ([c.c_void_p, c.POINTER(c.POINTER(c.c_char_p)), c.c_int], None),
        }
        for name, (args, result) in bindings.items():
            fn = getattr(self.lib, "Hunspell_" + name)
            fn.argtypes, fn.restype = args, result
        paths = [prefix.with_suffix(ext) for ext in (".aff", ".dic")]
        for path in paths:
            if not path.is_file():
                raise FileNotFoundError(path)
        self.handle = self.lib.Hunspell_create(*(bytes(path) for path in paths))
        if not self.handle:
            raise RuntimeError("Hunspell initialization failed")
        self.encoding = self.lib.Hunspell_get_dic_encoding(self.handle).decode()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.lib.Hunspell_destroy(self.handle)

    def check(self, word):
        try:
            encoded = word.encode(self.encoding)
        except UnicodeEncodeError:
            return False
        return bool(self.lib.Hunspell_spell(self.handle, encoded))

    def suggest(self, word):
        results = c.POINTER(c.c_char_p)()
        count = self.lib.Hunspell_suggest(self.handle, c.byref(results), word.encode(self.encoding))
        if count <= 0:
            return []
        try:
            return [results[index].decode(self.encoding) for index in range(min(count, 4))]
        finally:
            self.lib.Hunspell_free_list(self.handle, c.byref(results), count)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def source_rows():
    source = (ROOT / "index.html").read_text()
    base = re.search(r"<script>const DATA=(.+);\n", source)[1]
    edition = re.search(r'const EDITION_ID="([^"]+)"', source)[1]
    admin = (ROOT / "admin/index.html").read_text()
    if base != re.search(r"<script>const DATA=(.+);\n", admin)[1]:
        raise ValueError("Public and admin bases differ")
    rows = json.loads(base)
    overlay = json.loads((ROOT / "data/edits.json").read_text())
    if (overlay["format"], overlay["baseVersion"], overlay["total"]) != (
        "pontian-github-edits-v1", edition, len(rows)
    ):
        raise ValueError("Overlay does not match embedded dictionary")
    for key, row in overlay["edits"].items():
        index = int(key)
        if key != str(index) or not 0 <= index < len(rows):
            raise ValueError(f"Invalid overlay index {key}")
        if row == {"deleted": True}:
            rows[index] = None
        elif isinstance(row, list) and len(row) in (6, 7):
            rows[index] = row
        else:
            raise ValueError(f"Invalid overlay row {key}")
    return rows, edition, digest(base), overlay["updatedAt"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dictionary", required=True, type=Path, help="Path to el_GR without the file extension")
    parser.add_argument("--output", type=Path, default=ROOT / "admin/proofreading-report.json")
    parser.add_argument("--accepted", type=Path, help="JSON array of exact modern Greek word forms")
    args = parser.parse_args()
    accepted = json.loads(args.accepted.read_text()) if args.accepted else []
    if not isinstance(accepted, list) or not all(isinstance(word, str) for word in accepted):
        parser.error("--accepted requires a JSON array of strings")
    accepted = set(accepted)
    rows, edition, base_hash, overlay_date = source_rows()
    groups = defaultdict(list)
    fingerprints = {}

    def record(rule, token, replacement, index, field, start, text):
        groups[rule, token, replacement].append([index, field, start])
        key = f"{index}:{field}"
        if key not in fingerprints:
            fingerprints[key] = digest(text)

    with Hunspell(args.dictionary.resolve()) as checker:
        checked = {}
        for index, row in enumerate(rows):
            if row is None:
                continue
            fields = [(field, row[pos]) for pos, field in FIELDS.items() if pos < len(row)]
            fields.extend((f"variant:{pos}", word) for pos, word in enumerate(row[5]))
            for field, raw in fields:
                # The client canonicalizes straight apostrophes when applying published overrides.
                # Match the snapshot itself so raw legacy data stays auditable.
                for rule, regex, replacement in RULES:
                    for match in regex.finditer(raw):
                        record(rule, match[0], replacement, index, field, match.start(), raw)
                if field != "definition":
                    continue
                for match in WORD.finditer(raw):
                    token = match[0]
                    word = unicodedata.normalize("NFC", token)
                    dotted = raw[match.end():match.end() + 1] == "." and raw[match.end():match.end() + 2] != ".."
                    rule = ABBREVIATION_FORMS.get(word)
                    if rule and (dotted or rule["bare"]):
                        end = match.end() + int(dotted)
                        original = raw[match.start():end]
                        replacement = rule["canonical"]
                        if replacement == "(μεταφορικά)" and raw[match.start() - 1:match.start()] == "(":
                            replacement = "μεταφορικά"
                        if replacement and WORD.match(raw, end):
                            replacement += " "
                        if replacement and replacement != original:
                            record("abbreviation", original, replacement, index, field, match.start(), raw)
                        elif rule is ABBREVIATIONS["μεσ"]:
                            record("historical", original, None, index, field, match.start(), raw)
                        continue
                    if word in accepted or len(word) < 3:
                        continue
                    replacement = CORRECTIONS.get(word)
                    if replacement:
                        record("known", token, replacement, index, field, match.start(), raw)
                        continue
                    # Preserve dialect forms with combining marks or adjoining apostrophes.
                    if any(unicodedata.combining(char) for char in word):
                        continue
                    if raw[max(0, match.start() - 1):match.start()] in ("’", "'") or raw[match.end():match.end() + 1] in ("’", "'"):
                        continue
                    if word not in checked:
                        checked[word] = checker.check(word)
                    if not checked[word]:
                        rest = raw[match.end() + 1:].lstrip()
                        suspected = dotted and len(word) <= 7 and bool(rest) and rest[0].islower()
                        record("abbreviation-review" if suspected else "unknown",
                               token + "." if suspected else token, None, index, field, match.start(), raw)

        frequent = sorted(
            ((len(uses), token) for (rule, token, _), uses in groups.items() if rule == "unknown"),
            key=lambda entry: (-entry[0], entry[1]),
        )[:100]
        suggestions = {token: checker.suggest(unicodedata.normalize("NFC", token)) for _, token in frequent}

    order = {"known": 0, "abbreviation": 1, "apostrophe": 2, "spacing": 3, "invisible": 4,
             "historical": 5, "abbreviation-review": 6, "unknown": 7}
    report = {
        "format": FORMAT, "edition": edition, "baseSha256": base_hash, "overlayUpdatedAt": overlay_date,
        "scanned": sum(row is not None for row in rows), "fingerprints": fingerprints, "abbreviations": ABBREVIATIONS,
        "corrections": CORRECTIONS,
        "groups": [
            {"rule": rule, "token": token, "replacement": replacement, "uses": uses,
             **({"suggestions": suggestions[token]} if suggestions.get(token) else {})}
            for (rule, token, replacement), uses in sorted(
                groups.items(), key=lambda item: (order[item[0][0]], -len(item[1]), item[0][1])
            )
        ],
    }
    args.output.write_text(json.dumps(report, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Scanned {report['scanned']} entries; {len(groups)} groups; {sum(map(len, groups.values()))} findings")
    for rule in order:
        uses = [len(records) for (kind, _, _), records in groups.items() if kind == rule]
        print(f"{rule}: {len(uses)} groups, {sum(uses)} findings")


if __name__ == "__main__":
    main()
