// The comment from recorded stages: the app and the sidebars example of samebase/samebase at its
// pull request 1829, and a bucket of samebase/scout. Secret values and `props.env` are not recorded.
import { readFileSync } from "node:fs";
import { inMemoryState } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readStackCards,
  renderStackComment,
  saveStackComment,
  type StackCard,
} from "../src/StackComment.ts";

interface RecordedStage {
  readonly stack: string;
  readonly stage: string;
  readonly rows: readonly { readonly fqn: string }[];
  readonly output: unknown;
}

const recorded = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const stages = recorded("./fixtures/state/stack_comment_stages.json") as readonly RecordedStage[];

const repository = "samebase/samebase";

const stateOf = (recordedStages: readonly RecordedStage[]) => {
  const rows: Record<string, Record<string, Record<string, never>>> = {};
  const outputs: Record<string, Record<string, unknown>> = {};
  for (const { output, rows: stageRows, stack, stage } of recordedStages) {
    rows[stack] = {
      ...rows[stack],
      [stage]: Object.fromEntries(stageRows.map((row) => [row.fqn, row as never])),
    };
    outputs[stack] = { ...outputs[stack], [stage]: output };
  }
  return inMemoryState(rows, outputs);
};

const cardsAt = (stage: string, name = repository) =>
  Effect.runPromise(
    readStackCards({ repository: name, stage }).pipe(Effect.provide(stateOf(stages))),
  );

const worker = (cards: readonly StackCard[]) => cards[1]?.resources[0];

describe("readStackCards", () => {
  it("gives a card for each stack of the repository with the stage", async () => {
    const cards = await cardsAt("pr-1829");

    expect(cards.map(({ name }) => name)).toEqual([
      "samebase/samebase/apps/samebase",
      "samebase/samebase/apps/sidebars-example",
    ]);
  });

  it("gives no card for a stack without the stage", async () => {
    expect(await cardsAt("pr-1")).toEqual([]);
  });

  it("does not read a repository whose name starts with the same text", async () => {
    expect(await cardsAt("pr-1829", "samebase/same")).toEqual([]);
  });

  it("leaves out a row of another type", async () => {
    const [app] = await cardsAt("pr-1829");

    expect(app?.resources.map(({ resourceType }) => resourceType)).toEqual([
      "Convex.Deployment",
      "Convex.Deployment",
    ]);
  });
});

describe("renderStackComment", () => {
  it("starts with the marker that finds the comment again", async () => {
    const body = renderStackComment(await cardsAt("pr-1829"), repository);

    expect(body.startsWith("<!-- samebase-stacks -->\n")).toBe(true);
  });

  it("names each stack by its folder, with its address and its run", async () => {
    const body = renderStackComment(await cardsAt("pr-1829"), repository);

    expect(body).toContain("<b>apps/samebase</b> <sub>pr-1829</sub>");
    expect(body).toContain("<b>apps/sidebars-example</b> <sub>pr-1829</sub>");
    expect(body).toContain('">adventurous-dog-484.convex.site</a>');
    expect(body).toContain(">7b23daa</a> 2026-10-31");
  });

  it("shows the two rows of one deployment once", async () => {
    const [app] = await cardsAt("pr-1829");

    const body = renderStackComment(app ? [app] : [], repository);

    expect(body.match(/convex\.svg/g)).toHaveLength(1);
  });

  it("does not repeat the address of a Worker in its row", async () => {
    const body = renderStackComment(await cardsAt("pr-1829"), repository);

    expect(body.match(/<br><sub><a href="https:\/\/samebase-monorepo/g)).toBeNull();
  });

  it("shows another URL of a Worker below its name", async () => {
    const cards = await cardsAt("pr-1829");
    const row = worker(cards);
    const [app] = cards;

    const body = renderStackComment(
      app && row ? [{ ...app, resources: [...app.resources, row] }] : [],
      repository,
    );

    expect(body).toContain(
      '<br><sub><a href="https://samebase-monorepo-sidebars-example-pr-1829.pfp.workers.dev">',
    );
  });

  it("links a bucket to the dashboard page of its jurisdiction", async () => {
    const cards = await cardsAt("prod", "samebase/scout");

    const body = renderStackComment(cards, "samebase/scout");

    expect(body).toMatch(
      /href="https:\/\/dash\.cloudflare\.com\/[0-9a-f]+\/r2\/default\/buckets\/[^"]+"/,
    );
  });

  it("names the root only when the repository has several cards", async () => {
    const [app] = await cardsAt("pr-1829");
    const root = app ? [{ ...app, name: repository }] : [];

    expect(renderStackComment(root, repository)).not.toContain("<b>/</b>");
    expect(renderStackComment([...root, ...root], repository)).toContain("<b>/</b>");
  });

  it("has a blank line between tables and none inside a table", async () => {
    const body = renderStackComment(await cardsAt("pr-1829"), repository);

    expect(body.split("\n\n")).toHaveLength(2);
  });

  it("escapes the values of the state", async () => {
    const [bucket] = await cardsAt("prod", "samebase/scout");
    const [row] = bucket?.resources ?? [];

    const body = renderStackComment(
      bucket && row?.resourceType === "Cloudflare.R2.Bucket"
        ? [
            {
              ...bucket,
              resources: [{ ...row, attr: { ...row.attr, bucketName: "<script>" } }],
            },
          ]
        : [],
      "samebase/scout",
    );

    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });
});

describe("saveStackComment", () => {
  const comments = recorded("./fixtures/github/issue_comments.json");
  const save = saveStackComment({ token: "t", repository, pullRequest: 1829, body: "new" });

  const stubGitHub = (list: unknown, status = 200) => {
    const calls: { method: string; url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        const method = init.method ?? "GET";
        calls.push({ method, url });
        return Promise.resolve(
          Response.json(
            method === "GET"
              ? list
              : { html_url: "https://github.com/samebase/samebase/pull/1829#issuecomment-1" },
            { status },
          ),
        );
      }),
    );
    return calls;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("replaces the body of the comment with the marker", async () => {
    const calls = stubGitHub(comments);

    await Effect.runPromise(save);

    expect(calls.at(-1)).toEqual({
      method: "PATCH",
      url: "https://api.github.com/repos/samebase/samebase/issues/comments/6544860482",
    });
  });

  it("posts a comment when no comment has the marker", async () => {
    const calls = stubGitHub([{ id: 1, body: "Preview `pr-1829`: https://example.convex.site" }]);

    await Effect.runPromise(save);

    expect(calls.at(-1)).toEqual({
      method: "POST",
      url: "https://api.github.com/repos/samebase/samebase/issues/1829/comments",
    });
  });

  it("fails with the request, and never the token, when GitHub refuses", async () => {
    stubGitHub({ message: "Resource not accessible by integration" }, 403);

    const exit = await Effect.runPromiseExit(save);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("HTTP 403");
    expect(String(exit)).not.toContain("Bearer");
  });
});
