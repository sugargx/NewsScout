import { expect, test } from "@playwright/test";
import { projectArticle } from "../../services/public-reader/server.cjs";

function articleWithScore(score: unknown) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Original discussion",
    evidence: [{
      id: "source",
      sourceName: "Original community",
      url: "https://www.reddit.com/r/example/comments/abc123/discussion/",
      readingContext: {
        version: 1, kind: "post", origin: "feed", status: "partial",
        sourceUrl: "https://www.reddit.com/r/example/comments/abc123/discussion/",
        body: "Original post text", truncated: false, durationSeconds: null,
        chapters: [], transcriptUrl: null, commentsStatus: "available", fetchedAt: null,
        comments: [{
          id: "t1_comment", body: "Original comment text", score,
          url: "https://www.reddit.com/r/example/comments/abc123/discussion/comment/",
          privateToken: "PRIVATE_SENTINEL",
        }],
      },
    }],
  };
}

test("reading comment contract preserves unknown scores without inventing votes", () => {
  for (const score of [null, 42, -1]) {
    const article = projectArticle(articleWithScore(score));
    expect(article.evidence[0].readingContext.comments[0].score).toBe(score);
    expect(JSON.stringify(article)).not.toContain("PRIVATE_SENTINEL");
  }
});

test("reading comment contract rejects malformed vote fields", () => {
  for (const score of [undefined, "42", true, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => projectArticle(articleWithScore(score))).toThrow("Invalid post comment");
  }
});

test("reading comment contract retains only valid source attribution", () => {
  const article = articleWithScore(null);
  const comment = article.evidence[0].readingContext.comments[0];
  const supplied = { ...comment, author: "source_author", publishedAt: "2026-09-11T00:00:00Z", truncated: true };
  const withComment = (value: object) => ({
    ...article,
    evidence: [{ ...article.evidence[0], readingContext: { ...article.evidence[0].readingContext, comments: [value] } }],
  });
  expect(projectArticle(withComment(supplied)).evidence[0].readingContext.comments[0]).toMatchObject({
    author: "source_author", publishedAt: "2026-09-11T00:00:00Z", truncated: true,
  });
  for (const malformed of [{ author: "x".repeat(101) }, { publishedAt: "unknown" }, { truncated: "yes" }]) {
    expect(() => projectArticle(withComment({ ...supplied, ...malformed }))).toThrow("Invalid comment attribution");
  }
});
