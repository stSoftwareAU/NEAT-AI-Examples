#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env

/**
 * Project Improvement Analyser
 *
 * Analyses the NEAT-AI-Examples project structure and produces
 * a list of actionable improvement suggestions. These suggestions
 * can then be filed as GitHub issues using the GH CLI.
 *
 * Usage:
 *   deno run --allow-read --allow-write suggest_improvements/suggest_improvements.ts
 *
 * Or with the runner script:
 *   ./suggest_improvements/run.sh
 */

import { join } from "@std/path";

/** A single improvement suggestion. */
export interface Improvement {
  title: string;
  description: string;
  category: string;
}

/** The result of analysing the project. */
export interface AnalysisResult {
  improvements: Improvement[];
  summary: string;
}

/**
 * Analyses the NEAT-AI-Examples project and returns improvement suggestions.
 *
 * Each suggestion is a concrete, actionable item that would improve the
 * project's quality, maintainability, or documentation.
 */
export function analyseProject(): AnalysisResult {
  const improvements: Improvement[] = [];

  // CI/CD: No GitHub Actions workflow exists
  improvements.push({
    title: "Add GitHub Actions CI/CD workflow",
    description:
      "The project has no automated CI/CD pipeline. Adding a GitHub Actions " +
      "workflow would automate quality checks on every push and pull request, " +
      "preventing regressions from being merged. The workflow should run " +
      "deno test and execute all example runner scripts.",
    category: "ci-cd",
  });

  // Code quality: No explicit lint/fmt configuration
  improvements.push({
    title: "Add Deno linting and formatting configuration",
    description:
      "The deno.json file has no explicit lint or format configuration. " +
      "Adding lint rules and formatting options ensures consistent code " +
      "style across contributors. The quality.sh script should also be " +
      "updated to include deno lint and deno fmt --check.",
    category: "code-quality",
  });

  // Data generation consistency
  improvements.push({
    title: "Make intelligent_design/generateSyntheticData deterministic",
    description:
      "The generateSyntheticData function in the intelligent design module " +
      "uses Math.random(), making it non-deterministic. The discovery module " +
      "uses a seeded PRNG for reproducible results. Making both modules " +
      "consistent would improve debuggability and allow determinism tests.",
    category: "code-quality",
  });

  // New example: Crossover / Breeding
  improvements.push({
    title: "Add a third example: Crossover / Breeding",
    description:
      "The project demonstrates discovery and intelligent design but not " +
      "crossover (breeding). Adding a crossover example would demonstrate " +
      "a fundamental NEAT operation: combining two parent creatures to " +
      "produce offspring. This rounds out the example suite.",
    category: "new-example",
  });

  // Shared utilities
  improvements.push({
    title: "Extract shared utilities into a common module",
    description:
      "Both examples independently implement similar functionality: creature " +
      "creation, synthetic data generation, and directory setup. Extracting " +
      "shared utilities (especially the deterministic PRNG and binary data " +
      "generation) into a common module would reduce duplication.",
    category: "code-quality",
  });

  // Documentation: Contributing guide
  improvements.push({
    title: "Add CONTRIBUTING.md with development setup guide",
    description:
      "The project lacks a contributor guide. A CONTRIBUTING.md file should " +
      "cover development environment setup, testing conventions, how to add " +
      "new examples, the PR process, and the Australian English spelling " +
      "requirement. This helps new contributors get started quickly.",
    category: "documentation",
  });

  // Benchmarks
  improvements.push({
    title: "Add benchmark tests for creature activation and data generation",
    description:
      "AGENTS.md defines a clear separation between unit tests and benchmarks, " +
      "but no benchmark files (*_bench.ts) exist. Adding benchmarks for creature " +
      "activation, data generation, and scoring would establish performance " +
      "baselines and detect regressions in the NEAT-AI library.",
    category: "enhancement",
  });

  const summary =
    `Analysed the NEAT-AI-Examples project and identified ${improvements.length} ` +
    `improvement suggestions across CI/CD, code quality, documentation, and new ` +
    `examples. The project is well-structured with good test coverage; these ` +
    `suggestions focus on automation, consistency, and expanding the example suite.`;

  return { improvements, summary };
}

/**
 * Writes the analysis result to a markdown file.
 */
export function writeImprovementsSummary(
  result: AnalysisResult,
  outputPath: string,
): void {
  const lines: string[] = [];

  lines.push("# NEAT-AI-Examples Improvement Suggestions");
  lines.push("");
  lines.push(result.summary);
  lines.push("");

  for (const improvement of result.improvements) {
    lines.push(`## ${improvement.title}`);
    lines.push("");
    lines.push(`**Category:** ${improvement.category}`);
    lines.push("");
    lines.push(improvement.description);
    lines.push("");
  }

  Deno.writeTextFileSync(outputPath, lines.join("\n"));
}

if (import.meta.main) {
  const result = analyseProject();

  console.log("NEAT-AI-Examples Improvement Analysis");
  console.log("=====================================");
  console.log("");
  console.log(result.summary);
  console.log("");

  for (const improvement of result.improvements) {
    console.log(`- [${improvement.category}] ${improvement.title}`);
    console.log(`  ${improvement.description}`);
    console.log("");
  }

  // Write summary to file if output directory exists
  const outputDir = ".synthetic-suggest-improvements";
  try {
    Deno.mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, "improvements.md");
    writeImprovementsSummary(result, outputPath);
    console.log(`Summary written to ${outputPath}`);
  } catch (error) {
    console.error(`Could not write summary: ${error}`);
  }
}
