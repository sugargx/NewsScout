import { expect, test } from "@playwright/test";
import { projectArticle, projectBrief } from "../../services/public-reader/server.cjs";

const id = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const article = {
  id, contentVersion: 7, title: "Original engineering article", displayTitle: "Reader headline", evidence: [],
  editorial: {
    policyVersion: "editorial-v1", contentKind: "analysis", valueScore: 80,
    reason: "Substantive engineering analysis from the original publisher.", briefEligible: true,
  },
};
const edition = {
  localDate: "2026-09-15", generatedAt: "2026-09-15T08:00:00Z",
  items: [article, { ...article, id: secondId }],
  sections: [
    { key: "essential", kind: "essential", title: "Essential", description: "Recent changes.", eventIds: [id] },
    { key: "catch-up", kind: "catch_up", title: "Worth revisiting", description: "Earlier useful material.", eventIds: [secondId] },
  ],
};

test("editorial public projection keeps reading context but never personal feedback or ranking", () => {
  const projected = projectArticle({
    ...article, notInterestedReason: "PRIVATE_SENTINEL", saved: true,
    editorial: { ...article.editorial, userPreference: "PRIVATE_SENTINEL", extra: { token: "PRIVATE_SENTINEL" } },
    recommendation: { score: 99, affinity: 88, explanation: "PRIVATE_SENTINEL", facets: ["Engineering"] },
  });
  expect(projected.displayTitle).toBe(article.displayTitle);
  expect(projected.contentVersion).toBe(article.contentVersion);
  expect(projected.title).toBe(article.title);
  expect(projected.editorial).toEqual({
    policyVersion: article.editorial.policyVersion,
    contentKind: article.editorial.contentKind,
    reason: article.editorial.reason,
  });
  expect(projected.facets).toEqual(["Engineering"]);
  expect(projected).not.toHaveProperty("recommendation");
  expect(projected).not.toHaveProperty("notInterestedReason");
  expect(projected).not.toHaveProperty("saved");
  expect(projected.editorial).not.toHaveProperty("valueScore");
  expect(projected.editorial).not.toHaveProperty("briefEligible");
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_SENTINEL");
});

test("editorial public edition preserves all section membership and original ordering", () => {
  const projected = projectBrief({
    ...edition, ownerNotes: "PRIVATE_SENTINEL",
    sections: edition.sections.map(section => ({ ...section, privateNotes: "PRIVATE_SENTINEL" })),
  });
  expect(projected.sections).toEqual(edition.sections);
  expect(projected.sections.flatMap((section: { eventIds: string[] }) => section.eventIds))
    .toEqual(projected.items.map((item: { id: string }) => item.id));
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_SENTINEL");
});

test("editorial public edition rejects missing, repeated, reordered or foreign members", () => {
  const section = edition.sections[0];
  for (const sections of [
    [section],
    [section, { ...edition.sections[1], eventIds: [id] }],
    [...edition.sections].reverse(),
    [section, { ...edition.sections[1], eventIds: ["33333333-3333-4333-8333-333333333333"] }],
    [section, { ...edition.sections[1], key: section.key }],
    [{ ...section, eventIds: [] }, edition.sections[1]],
  ]) {
    expect(() => projectBrief({ ...edition, sections })).toThrow();
  }
});

test("editorial public projection accepts legacy editions without inventing classification", () => {
  const legacy = { id, title: "Original legacy title", evidence: [] };
  const projected = projectBrief({ items: [legacy], localDate: "2026-09-01" });
  expect(projected).not.toHaveProperty("sections");
  expect(projected.items[0]).not.toHaveProperty("editorial");
  expect(projected.items[0]).not.toHaveProperty("displayTitle");
  expect(projectBrief({ items: [legacy], sections: [] }).sections).toEqual([]);
});

test("editorial public projection bounds new headings and rejects invalid policy context", () => {
  for (const displayTitle of ["x".repeat(181), "", { secret: "PRIVATE_SENTINEL" }]) {
    expect(() => projectArticle({ ...article, displayTitle })).toThrow();
  }
  for (const editorial of [
    { ...article.editorial, valueScore: 101 },
    { ...article.editorial, valueScore: Number.NaN },
    { ...article.editorial, reason: "x".repeat(601) },
    { ...article.editorial, contentKind: "guaranteed_fact" },
    { ...article.editorial, briefEligible: "true" },
  ]) {
    expect(() => projectArticle({ ...article, editorial })).toThrow();
  }
  expect(projectArticle({ ...article, displayTitle: null }).displayTitle).toBeNull();
  expect(projectArticle({ ...article, contentVersion: 0 }).contentVersion).toBe(0);
  expect(() => projectArticle({ ...article, contentVersion: -1 })).toThrow();
  expect(() => projectArticle({ ...article, contentVersion: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
});
