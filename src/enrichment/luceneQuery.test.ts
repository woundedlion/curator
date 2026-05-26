import { describe, expect, it } from "vitest";
import { buildRecordingQuery } from "./luceneQuery";

describe("buildRecordingQuery", () => {
  it("emits recording + artist clauses joined by AND", () => {
    expect(
      buildRecordingQuery({ title: "Karma Police", artist: "Radiohead" }),
    ).toBe('recording:"Karma Police" AND artist:"Radiohead"');
  });

  it("drops missing fields", () => {
    expect(buildRecordingQuery({ title: "Stargazer" })).toBe(
      'recording:"Stargazer"',
    );
  });

  it("intentionally omits album to avoid over-strict matches", () => {
    expect(
      buildRecordingQuery({
        title: "Foo",
        artist: "Bar",
        album: "Should Not Appear",
      }),
    ).toBe('recording:"Foo" AND artist:"Bar"');
  });

  it("returns empty string when both fields missing", () => {
    expect(buildRecordingQuery({})).toBe("");
  });
});
