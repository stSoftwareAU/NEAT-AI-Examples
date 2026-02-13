/**
 * Unit tests for the suggest_improvements module.
 *
 * These are "what" tests — they verify that the analysis functions
 * produce correct results (outputs, structure) without checking
 * implementation details.
 */

import { assertEquals, assertGreater } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";

import {
  analyseProject,
  type AnalysisResult,
  type Improvement,
  writeImprovementsSummary,
} from "./suggest_improvements.ts";

/* ------------------------------------------------------------------ */
/*  analyseProject                                                     */
/* ------------------------------------------------------------------ */

Deno.test("analyseProject returns an AnalysisResult with improvements", () => {
  const result: AnalysisResult = analyseProject();

  assertGreater(
    result.improvements.length,
    0,
    "should find at least one improvement",
  );
});

Deno.test("analyseProject improvements have required fields", () => {
  const result: AnalysisResult = analyseProject();

  for (const improvement of result.improvements) {
    assertGreater(
      improvement.title.length,
      0,
      "title should not be empty",
    );
    assertGreater(
      improvement.description.length,
      0,
      "description should not be empty",
    );
    assertGreater(
      improvement.category.length,
      0,
      "category should not be empty",
    );
  }
});

Deno.test("analyseProject includes CI/CD improvement", () => {
  const result: AnalysisResult = analyseProject();

  const ciImprovement = result.improvements.find(
    (i) => i.category === "ci-cd",
  );
  assertEquals(
    ciImprovement !== undefined,
    true,
    "should include a CI/CD improvement suggestion",
  );
});

Deno.test("analyseProject includes linting improvement", () => {
  const result: AnalysisResult = analyseProject();

  const lintImprovement = result.improvements.find(
    (i) => i.category === "code-quality",
  );
  assertEquals(
    lintImprovement !== undefined,
    true,
    "should include a code quality improvement suggestion",
  );
});

Deno.test("analyseProject includes documentation improvement", () => {
  const result: AnalysisResult = analyseProject();

  const docImprovement = result.improvements.find(
    (i) => i.category === "documentation",
  );
  assertEquals(
    docImprovement !== undefined,
    true,
    "should include a documentation improvement suggestion",
  );
});

Deno.test("analyseProject includes new example improvement", () => {
  const result: AnalysisResult = analyseProject();

  const exampleImprovement = result.improvements.find(
    (i) => i.category === "new-example",
  );
  assertEquals(
    exampleImprovement !== undefined,
    true,
    "should include a new example improvement suggestion",
  );
});

Deno.test("analyseProject improvements have unique titles", () => {
  const result: AnalysisResult = analyseProject();

  const titles = result.improvements.map((i) => i.title);
  const uniqueTitles = new Set(titles);
  assertEquals(
    titles.length,
    uniqueTitles.size,
    "all improvement titles should be unique",
  );
});

Deno.test("analyseProject summary is non-empty", () => {
  const result: AnalysisResult = analyseProject();

  assertGreater(
    result.summary.length,
    0,
    "summary should not be empty",
  );
});

/* ------------------------------------------------------------------ */
/*  writeImprovementsSummary                                           */
/* ------------------------------------------------------------------ */

Deno.test("writeImprovementsSummary creates a markdown file", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_suggest_test_" });

  try {
    const improvements: Improvement[] = [
      {
        title: "Test improvement",
        description: "A test improvement description.",
        category: "enhancement",
      },
    ];
    const result: AnalysisResult = {
      improvements,
      summary: "Test summary",
    };

    const outputPath = join(tmpDir, "improvements.md");
    writeImprovementsSummary(result, outputPath);

    assertEquals(existsSync(outputPath), true, "output file should exist");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("writeImprovementsSummary output contains improvement titles", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_suggest_test_" });

  try {
    const improvements: Improvement[] = [
      {
        title: "Add CI/CD pipeline",
        description: "Automate quality checks.",
        category: "ci-cd",
      },
      {
        title: "Add linting configuration",
        description: "Enforce consistent code style.",
        category: "code-quality",
      },
    ];
    const result: AnalysisResult = {
      improvements,
      summary: "Found 2 improvements",
    };

    const outputPath = join(tmpDir, "improvements.md");
    writeImprovementsSummary(result, outputPath);

    const content = Deno.readTextFileSync(outputPath);
    assertEquals(
      content.includes("Add CI/CD pipeline"),
      true,
      "output should contain first improvement title",
    );
    assertEquals(
      content.includes("Add linting configuration"),
      true,
      "output should contain second improvement title",
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("writeImprovementsSummary output contains summary", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_suggest_test_" });

  try {
    const improvements: Improvement[] = [
      {
        title: "Test item",
        description: "Description here.",
        category: "enhancement",
      },
    ];
    const result: AnalysisResult = {
      improvements,
      summary: "Overall the project is well-structured.",
    };

    const outputPath = join(tmpDir, "improvements.md");
    writeImprovementsSummary(result, outputPath);

    const content = Deno.readTextFileSync(outputPath);
    assertEquals(
      content.includes("Overall the project is well-structured."),
      true,
      "output should contain the summary text",
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("writeImprovementsSummary output is valid markdown with headings", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_suggest_test_" });

  try {
    const improvements: Improvement[] = [
      {
        title: "First item",
        description: "First description.",
        category: "ci-cd",
      },
    ];
    const result: AnalysisResult = {
      improvements,
      summary: "Summary text",
    };

    const outputPath = join(tmpDir, "improvements.md");
    writeImprovementsSummary(result, outputPath);

    const content = Deno.readTextFileSync(outputPath);
    assertEquals(
      content.includes("# "),
      true,
      "output should contain markdown headings",
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});
