/**
 * Modified fork of the review extension in diegopetrucci/pi-extensions
 * (based on commit ce73c9e):
 * https://github.com/diegopetrucci/pi-extensions/tree/ce73c9efb8c47abbcdf1f79ee7cc65f453742425/extensions/review
 *
 * That extension was adapted from:
 * https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/review.ts
 *
 * The upstream source is licensed under Apache-2.0. See LICENSE.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  ModelChangeEntry,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, DynamicBorder, BorderedLoader, getAgentDir, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  Container,
  fuzzyFilter,
  Input,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, promises as fs } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import lockfile from "proper-lockfile";
import lt from "semver/functions/lt.js";

const GIT_GH_COMMAND_TIMEOUT_MS = 30_000;
const PR_CHECKOUT_TIMEOUT_MS = 120_000;

// State to track fresh session review (where we branched from).
// Module-level state means only one review can be active at a time.
// This is intentional - the UI and /end-review command assume a single active review.
let reviewOriginId: string | undefined = undefined;
let endReviewInProgress = false;
let reviewLoopFixingEnabled = false;
let reviewCustomInstructions: string | undefined = undefined;
let reviewLoopInProgress = false;

function getReviewRuntimeState() {
  return {
    reviewOriginId,
    endReviewInProgress,
    reviewLoopFixingEnabled,
    reviewCustomInstructions,
    reviewLoopInProgress,
  };
}

function resetReviewRuntimeState() {
  reviewOriginId = undefined;
  endReviewInProgress = false;
  reviewLoopFixingEnabled = false;
  reviewCustomInstructions = undefined;
  reviewLoopInProgress = false;
}

const REVIEW_STATE_TYPE = "review-session";
const REVIEW_ANCHOR_TYPE = "review-anchor";
const REVIEW_SETTINGS_TYPE = "review-settings";
const REVIEW_LOOP_MAX_ITERATIONS = 10;
const REVIEW_LOOP_START_TIMEOUT_MS = 15000;
const REVIEW_LOOP_START_POLL_MS = 50;

type ReviewSessionState = {
  active: boolean;
  originId?: string;
};

type ReviewSettingsState = {
  loopFixingEnabled?: boolean;
  customInstructions?: string;
};

const THINKING_FIELD = { reviewModel: "reviewThinkingLevel", fixModel: "fixThinkingLevel" } as const;
type ModelField = keyof typeof THINKING_FIELD;
type ModelSettings = Record<string, unknown>;
type Model = NonNullable<ExtensionContext["model"]>;
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type ThinkingDefaults = Pick<ReturnType<SettingsManager["getGlobalSettings"]>, "defaultThinkingLevel" | "modelThinkingLevels">;
type RunModel = { model?: Model; thinking?: ThinkingLevel };

function modelRef(model: Model) {
  return `${model.provider}/${model.id}`;
}

async function readModelSettings(file = path.join(getAgentDir(), "review.json")): Promise<ModelSettings> {
  try {
    const text = await fs.readFile(file, "utf8");
    const settings = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("Expected a JSON object");
    }
    return settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !lstatSync(file, { throwIfNoEntry: false })) return {};
    throw new Error(`Could not read ${file}: ${error instanceof Error ? error.message : error}`, { cause: error });
  }
}

async function saveModelSetting(
  settingsFile: string,
  field: ModelField,
  expected: ModelSettings,
  selected: string | undefined,
  thinking: ThinkingLevel | undefined,
) {
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  const options = { realpath: false, stale: 10_000 };
  let release;
  try {
    release = await lockfile.lock(settingsFile, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
    // Older versions staged the JSON inside the lock. Only a stale lock reaches rmdir.
    await fs.rm(path.join(settingsFile + ".lock", "review.json"), { force: true });
    // Removing the legacy file refreshes the directory mtime. Let the lease expire again.
    release = await lockfile.lock(settingsFile, {
      ...options,
      retries: { retries: 1, minTimeout: options.stale + 1000 },
    });
  }
  try {
    if (lstatSync(settingsFile, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Edit the symlink target for ${settingsFile} directly.`);
    }
    const latest = await readModelSettings(settingsFile);
    const levelField = THINKING_FIELD[field];
    if (!isDeepStrictEqual(latest[field], expected[field]) || !isDeepStrictEqual(latest[levelField], expected[levelField])) {
      throw new Error(`${field} settings changed. Reopen Model settings.`);
    }
    latest[field] = selected;
    latest[levelField] = thinking;
    const temp = settingsFile + ".pi-review.tmp";
    await fs.rm(temp, { force: true });
    await fs.writeFile(temp, JSON.stringify(latest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await fs.rename(temp, settingsFile);
  } finally {
    await release();
  }
}

async function getRunModels(ctx: ExtensionContext, field: ModelField) {
  const settings = await readModelSettings();
  const available = ctx.modelRegistry.getAvailable();
  const current = ctx.model && modelRef(ctx.model);
  const session = available.find(m => modelRef(m) === current);
  const reference = settings[field];
  const model = available.find(m => modelRef(m) === reference);
  if (!session && (!model || field === "fixModel")) {
    throw new Error(field === "fixModel"
      ? "Select an available session model before returning with a summary."
      : "Select an authorized session or Review model before starting a review.");
  }
  const effective = reference === undefined ? session : model;
  const thinking = effective && getSupportedThinkingLevels(effective).find(level => level === settings[THINKING_FIELD[field]]);
  return { override: { model, thinking }, session, fallback: reference !== undefined && !model };
}

type ProjectConfigContext = {
  cwd: string;
  isProjectTrusted?: () => boolean;
};

function canReadProjectConfig(ctx: ProjectConfigContext): boolean {
  return typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
}

function setReviewWidget(ctx: ExtensionContext, active: boolean) {
  if (!ctx.hasUI) return;
  if (!active || ctx.mode !== "tui") {
    ctx.ui.setWidget("review", undefined);
    return;
  }

  ctx.ui.setWidget("review", (_tui, theme) => {
    const message = reviewLoopInProgress
      ? "Review session active (loop fixing running)"
      : reviewLoopFixingEnabled
        ? "Review session active (loop fixing enabled), return with /end-review"
        : "Review session active, return with /end-review";
    const text = new Text(theme.fg("warning", message), 0, 0);
    return {
      render(width: number) {
        return text.render(width);
      },
      invalidate() {
        text.invalidate();
      },
    };
  });
}

function getReviewState(ctx: ExtensionContext): ReviewSessionState | undefined {
  let state: ReviewSessionState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === REVIEW_STATE_TYPE) {
      state = entry.data as ReviewSessionState | undefined;
    }
  }

  return state;
}

function applyReviewState(ctx: ExtensionContext) {
  const state = getReviewState(ctx);

  if (state?.active && state.originId) {
    reviewOriginId = state.originId;
    setReviewWidget(ctx, true);
    return;
  }

  reviewOriginId = undefined;
  setReviewWidget(ctx, false);
}

function getReviewSettings(ctx: ExtensionContext): ReviewSettingsState {
  let state: ReviewSettingsState | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === REVIEW_SETTINGS_TYPE) {
      state = entry.data as ReviewSettingsState | undefined;
    }
  }

  return {
    loopFixingEnabled: state?.loopFixingEnabled === true,
    customInstructions: state?.customInstructions?.trim() || undefined,
  };
}

function applyReviewSettings(ctx: ExtensionContext) {
  const state = getReviewSettings(ctx);
  reviewLoopFixingEnabled = state.loopFixingEnabled === true;
  reviewCustomInstructions = state.customInstructions?.trim() || undefined;
}

function parseMarkdownHeading(line: string): { level: number; title: string } | null {
  const headingMatch = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
  if (!headingMatch) {
    return null;
  }

  const rawTitle = headingMatch[2].replace(/\s+#+\s*$/, "").trim();
  return {
    level: headingMatch[1].length,
    title: rawTitle,
  };
}

function getFindingsSectionBounds(lines: string[]): { start: number; end: number } | null {
  let start = -1;
  let findingsHeadingLevel: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = parseMarkdownHeading(line);
    if (heading && /^findings\b/i.test(heading.title)) {
      start = i + 1;
      findingsHeadingLevel = heading.level;
      break;
    }
    if (/^\s*findings\s*:?\s*$/i.test(line)) {
      start = i + 1;
      break;
    }
  }

  if (start < 0) {
    return null;
  }

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const heading = parseMarkdownHeading(line);
    if (heading) {
      const normalizedTitle = heading.title.replace(/[*_`]/g, "").trim();
      if (
        /^(review scope|verdict|overall verdict|fix queue|constraints(?:\s*&\s*preferences)?)\b:?/i.test(
          normalizedTitle,
        )
      ) {
        end = i;
        break;
      }

      if (/\[P[0-3]\]/i.test(heading.title)) {
        continue;
      }

      if (findingsHeadingLevel !== null && heading.level <= findingsHeadingLevel) {
        end = i;
        break;
      }
    }

    if (
      /^\s*(review scope|verdict|overall verdict|fix queue|constraints(?:\s*&\s*preferences)?)\b:?/i.test(
        line,
      )
    ) {
      end = i;
      break;
    }
  }

  return { start, end };
}

function isLikelyFindingLine(line: string): boolean {
  if (!/\[P[0-3]\]/i.test(line)) {
    return false;
  }

  if (/^\s*(?:[-*+]|(?:\d+)[.)]|#{1,6})\s+priority\s+tag\b/i.test(line)) {
    return false;
  }

  if (
    /^\s*(?:[-*+]|(?:\d+)[.)]|#{1,6})\s+\[P[0-3]\]\s*-\s*(?:drop everything|urgent|normal|low|nice to have)\b/i.test(
      line,
    )
  ) {
    return false;
  }

  const allPriorityTags = line.match(/\[P[0-3]\]/gi) ?? [];
  if (allPriorityTags.length > 1) {
    return false;
  }

  if (/^\s*(?:[-*+]|(?:\d+)[.)])\s+/.test(line)) {
    return true;
  }

  if (/^\s*#{1,6}\s+/.test(line)) {
    return true;
  }

  if (/^\s*(?:\*\*|__)?\[P[0-3]\](?:\*\*|__)?(?=\s|:|-)/i.test(line)) {
    return true;
  }

  return false;
}

function normalizeVerdictValue(value: string): string {
  return value
    .trim()
    .replace(/^[-*+]\s*/, "")
    .replace(/^['"`]+|['"`]+$/g, "")
    .toLowerCase();
}

function isNeedsAttentionVerdictValue(value: string): boolean {
  const normalized = normalizeVerdictValue(value);
  if (!normalized.includes("needs attention")) {
    return false;
  }

  if (/\bnot\s+needs\s+attention\b/.test(normalized)) {
    return false;
  }

  // Reject rubric/choice phrasing like "correct or needs attention", but
  // keep legitimate verdict text that may contain unrelated "or".
  if (/\bcorrect\b/.test(normalized) && /\bor\b/.test(normalized)) {
    return false;
  }

  return true;
}

function hasNeedsAttentionVerdict(messageText: string): boolean {
  const lines = messageText.split(/\r?\n/);

  for (const line of lines) {
    const inlineMatch = line.match(/^\s*(?:[*-+]\s*)?(?:overall\s+)?verdict\s*:\s*(.+)$/i);
    if (inlineMatch && isNeedsAttentionVerdictValue(inlineMatch[1])) {
      return true;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = parseMarkdownHeading(line);

    let verdictLevel: number | null = null;
    if (heading) {
      const normalizedHeading = heading.title.replace(/[*_`]/g, "").trim();
      if (!/^(?:overall\s+)?verdict\b/i.test(normalizedHeading)) {
        continue;
      }
      verdictLevel = heading.level;
    } else if (!/^\s*(?:overall\s+)?verdict\s*:?\s*$/i.test(line)) {
      continue;
    }

    for (let j = i + 1; j < lines.length; j++) {
      const verdictLine = lines[j];
      const nextHeading = parseMarkdownHeading(verdictLine);
      if (nextHeading) {
        const normalizedNextHeading = nextHeading.title.replace(/[*_`]/g, "").trim();
        if (verdictLevel === null || nextHeading.level <= verdictLevel) {
          break;
        }
        if (
          /^(review scope|findings|fix queue|constraints(?:\s*&\s*preferences)?)\b:?/i.test(
            normalizedNextHeading,
          )
        ) {
          break;
        }
      }

      const trimmed = verdictLine.trim();
      if (!trimmed) {
        continue;
      }

      if (isNeedsAttentionVerdictValue(trimmed)) {
        return true;
      }

      if (/\bcorrect\b/i.test(normalizeVerdictValue(trimmed))) {
        break;
      }
    }
  }

  return false;
}

function hasBlockingReviewFindings(messageText: string): boolean {
  const lines = messageText.split(/\r?\n/);
  const bounds = getFindingsSectionBounds(lines);
  const candidateLines = bounds ? lines.slice(bounds.start, bounds.end) : lines;

  let inCodeFence = false;
  let foundTaggedFinding = false;
  for (const line of candidateLines) {
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }

    if (!isLikelyFindingLine(line)) {
      continue;
    }

    foundTaggedFinding = true;
    if (/\[(P0|P1|P2)\]/i.test(line)) {
      return true;
    }
  }

  if (foundTaggedFinding) {
    return false;
  }

  return hasNeedsAttentionVerdict(messageText);
}

// Review target types (matching Codex's approach)
type ReviewTarget =
  | { type: "uncommitted" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | { type: "pullRequest"; prNumber: number; baseBranch: string; title: string }
  | { type: "folder"; paths: string[] };

// Prompts (adapted from Codex)
const UNCOMMITTED_PROMPT =
  "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";

const LOCAL_CHANGES_REVIEW_INSTRUCTIONS =
  "Also include local working-tree changes (staged, unstaged, and untracked files) from this branch. Use `git status --porcelain`, `git diff`, `git diff --staged`, and `git ls-files --others --exclude-standard` so local fixes are part of this review cycle.";

const BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
  "Review the code changes against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes relative to {baseBranch}. Provide prioritized, actionable findings.";

const BASE_BRANCH_PROMPT_FALLBACK =
  'Review the code changes against the base branch \'{branch}\'. Start by finding the merge diff between the current branch and {branch}\'s upstream e.g. (`git merge-base HEAD "$(git rev-parse --abbrev-ref "{branch}@{upstream}")"`), then run `git diff` against that SHA to see what changes we would merge into the {branch} branch. Provide prioritized, actionable findings.';

const COMMIT_PROMPT_WITH_TITLE =
  'Review the code changes introduced by commit {sha} ("{title}"). Provide prioritized, actionable findings.';

const COMMIT_PROMPT =
  "Review the code changes introduced by commit {sha}. Provide prioritized, actionable findings.";

const PULL_REQUEST_PROMPT =
  "Review pull request #{prNumber} (\"{title}\") against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes that would be merged. Provide prioritized, actionable findings.";

const PULL_REQUEST_PROMPT_FALLBACK =
  "Review pull request #{prNumber} (\"{title}\") against the base branch '{baseBranch}'. Start by finding the merge base between the current branch and {baseBranch} (e.g., `git merge-base HEAD {baseBranch}`), then run `git diff` against that SHA to see the changes that would be merged. Provide prioritized, actionable findings.";

const FOLDER_REVIEW_PROMPT =
  "Review the code in the following paths: {paths}. This is a snapshot review (not a diff). Read the files directly in these paths and provide prioritized, actionable findings.";

// Shared by the review rubric and the /end-review summary so the callout list
// and the "informational, not a fix item" rule cannot drift.
const HUMAN_REVIEWER_CALLOUTS = `## Human Reviewer Callouts (Non-Blocking)

Include only applicable callouts (no yes/no lines):

- **This change adds a database migration:** <files/details>
- **This change introduces a new dependency:** <package(s)/details>
- **This change changes a dependency (or the lockfile):** <files/package(s)/details>
- **This change modifies auth/permission behavior:** <what changed and where>
- **This change introduces backwards-incompatible public schema/API/contract changes:** <what changed and where>
- **This change includes irreversible or destructive operations:** <operation and scope>

These are informational callouts for the human reviewer, not fix items.
If none apply, write "- (none)".`;

// The detailed review rubric (adapted from Codex's review_prompt.md)
const REVIEW_RUBRIC = `# Review Guidelines

You are acting as a code reviewer for a proposed code change made by another engineer.

Below are default guidelines for determining what to flag. These are not the final word — if you encounter more specific guidelines elsewhere (in a developer message, user message, file, or project review guidelines appended below), those override these general instructions.

## Determining what to flag

Flag issues that:
1. Meaningfully impact the accuracy, performance, security, or maintainability of the code.
2. Are discrete and actionable (not general issues or multiple combined issues).
3. Don't demand rigor inconsistent with the rest of the codebase.
4. Were introduced in the changes being reviewed (not pre-existing bugs).
5. The author would likely fix if aware of them.
6. Don't rely on unstated assumptions about the codebase or author's intent.
7. Have provable impact on other parts of the code — it is not enough to speculate that a change may disrupt another part, you must identify the parts that are provably affected.
8. Are clearly not intentional changes by the author.
9. Be particularly careful with untrusted user input and follow the specific guidelines to review.
10. Treat silent local error recovery (especially parsing/IO/network fallbacks) as high-signal review candidates unless there is explicit boundary-level justification.

## Untrusted User Input

1. Be careful with open redirects, they must always be checked to only go to trusted domains (?next_page=...)
2. Always flag SQL that is not parametrized
3. In systems with user supplied URL input, http fetches always need to be protected against access to local resources (intercept DNS resolver!)
4. Escape, don't sanitize if you have the option (eg: HTML escaping)

## Comment guidelines

1. Be clear about why the issue is a problem.
2. Communicate severity appropriately - don't exaggerate.
3. Be brief - at most 1 paragraph.
4. Keep code snippets under 3 lines, wrapped in inline code or code blocks.
5. Use \`\`\`suggestion blocks ONLY for concrete replacement code (minimal lines; no commentary inside the block). Preserve the exact leading whitespace of the replaced lines.
6. Explicitly state scenarios/environments where the issue arises.
7. Use a matter-of-fact tone - helpful AI assistant, not accusatory.
8. Write for quick comprehension without close reading.
9. Avoid excessive flattery or unhelpful phrases like "Great job...".

## Review priorities

1. Surface critical non-blocking human callouts (migrations, dependency churn, auth/permissions, compatibility, destructive operations) at the end.
2. Prefer simple, direct solutions over wrappers or abstractions without clear value.
3. Treat back pressure handling as critical to system stability.
4. Apply system-level thinking; flag changes that increase operational risk or on-call wakeups.
5. Ensure that errors are always checked against codes or stable identifiers, never error messages.

## Fail-fast error handling (strict)

When reviewing added or modified error handling, default to fail-fast behavior.

1. Evaluate every new or changed \`try/catch\`: identify what can fail and why local handling is correct at that exact layer.
2. Prefer propagation over local recovery. If the current scope cannot fully recover while preserving correctness, rethrow (optionally with context) instead of returning fallbacks.
3. Flag catch blocks that hide failure signals (e.g. returning \`null\`/\`[]\`/\`false\`, swallowing JSON parse failures, logging-and-continue, or “best effort” silent recovery).
4. JSON parsing/decoding should fail loudly by default. Quiet fallback parsing is only acceptable with an explicit compatibility requirement and clear tested behavior.
5. Boundary handlers (HTTP routes, CLI entrypoints, supervisors) may translate errors, but must not pretend success or silently degrade.
6. If a catch exists only to satisfy lint/style without real handling, treat it as a bug.
7. When uncertain, prefer crashing fast over silent degradation.

## Required human callouts (non-blocking, at the very end)

After findings/verdict, you MUST append this final section:

${HUMAN_REVIEWER_CALLOUTS}

Rules for this section:
1. Do not include them in Findings unless there is an independent defect.
2. These callouts alone must not change the verdict.
3. Keep each emitted callout bold exactly as written.

## Priority levels

Tag each finding with a priority level in the title:
- [P0] - Drop everything to fix. Blocking release/operations. Only for universal issues that do not depend on assumptions about inputs.
- [P1] - Urgent. Should be addressed in the next cycle.
- [P2] - Normal. To be fixed eventually.
- [P3] - Low. Nice to have.

## Output format

Provide your findings in a clear, structured format:
1. List each finding with its priority tag, file location, and explanation.
2. Findings must reference locations that overlap with the actual diff — don't flag pre-existing code.
3. Keep line references as short as possible (avoid ranges over 5-10 lines; pick the most suitable subrange).
4. Provide an overall verdict: "correct" (no blocking issues) or "needs attention" (has blocking issues).
5. Ignore trivial style issues unless they obscure meaning or violate documented standards.
6. Do not generate a full PR fix — only flag issues and optionally provide short suggestion blocks.
7. End with the required "Human Reviewer Callouts (Non-Blocking)" section and all applicable bold callouts (no yes/no).

Output all findings the author would fix if they knew about them. If there are no qualifying findings, explicitly state the code looks good. Don't stop at the first finding - list every qualifying issue. Then append the required non-blocking callouts section.`;

async function loadProjectReviewGuidelines(cwd: string): Promise<string | null> {
  let currentDir = path.resolve(cwd);

  while (true) {
    const piDir = path.join(currentDir, CONFIG_DIR_NAME);
    const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");

    const piStats = await fs.stat(piDir).catch(() => null);
    if (piStats?.isDirectory()) {
      const guidelineStats = await fs.stat(guidelinesPath).catch(() => null);
      if (guidelineStats?.isFile()) {
        try {
          const content = await fs.readFile(guidelinesPath, "utf8");
          const trimmed = content.trim();
          return trimmed ? trimmed : null;
        } catch {
          return null;
        }
      }
      return null;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

async function getMergeBase(pi: ExtensionAPI, branch: string): Promise<string | null> {
  try {
    const {
      stdout: upstream,
      code: upstreamCode,
      killed: upstreamKilled,
    } = await pi.exec("git", ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], {
      timeout: GIT_GH_COMMAND_TIMEOUT_MS,
    });

    if (!upstreamKilled && upstreamCode === 0 && upstream.trim()) {
      const {
        stdout: mergeBase,
        code,
        killed,
      } = await pi.exec("git", ["merge-base", "HEAD", upstream.trim()], {
        timeout: GIT_GH_COMMAND_TIMEOUT_MS,
      });
      if (!killed && code === 0 && mergeBase.trim()) {
        return mergeBase.trim();
      }
    }

    const {
      stdout: mergeBase,
      code,
      killed,
    } = await pi.exec("git", ["merge-base", "HEAD", branch], {
      timeout: GIT_GH_COMMAND_TIMEOUT_MS,
    });
    if (!killed && code === 0 && mergeBase.trim()) {
      return mergeBase.trim();
    }

    return null;
  } catch {
    return null;
  }
}

async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
  const { stdout, code, killed } = await pi.exec("git", ["branch", "--format=%(refname:short)"], {
    timeout: GIT_GH_COMMAND_TIMEOUT_MS,
  });
  if (killed || code !== 0) return [];
  return stdout
    .trim()
    .split("\n")
    .filter((b) => b.trim());
}

async function getRecentCommits(
  pi: ExtensionAPI,
  limit: number = 10,
): Promise<Array<{ sha: string; title: string }>> {
  const { stdout, code, killed } = await pi.exec("git", ["log", `--oneline`, `-n`, `${limit}`], {
    timeout: GIT_GH_COMMAND_TIMEOUT_MS,
  });
  if (killed || code !== 0) return [];

  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [sha, ...rest] = line.trim().split(" ");
      return { sha, title: rest.join(" ") };
    });
}

async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
  const { stdout, code, killed } = await pi.exec("git", ["status", "--porcelain"], {
    timeout: GIT_GH_COMMAND_TIMEOUT_MS,
  });
  return !killed && code === 0 && stdout.trim().length > 0;
}

// Tracked staged/unstaged changes block branch switches. Untracked files (??) do not.
async function hasPendingChanges(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean | null> {
  const { stdout, code, killed } = await pi.exec("git", ["status", "--porcelain"], {
    timeout: GIT_GH_COMMAND_TIMEOUT_MS,
  });
  if (killed || code !== 0) {
    ctx.ui.notify(
      killed
        ? "Cannot checkout PR: uncommitted-changes check failed (git status timed out)."
        : "Cannot checkout PR: uncommitted-changes check failed (git status failed).",
      "error",
    );
    return null;
  }

  const lines = stdout
    .trim()
    .split("\n")
    .filter((line) => line.trim());
  const trackedChanges = lines.filter((line) => !line.startsWith("??"));
  return trackedChanges.length > 0;
}

function parsePrReference(ref: string): number | null {
  const trimmed = ref.trim();

  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isSafeInteger(num) && num > 0) {
      return num;
    }
  }

  // Try to extract from GitHub URL
  // Formats: https://github.com/owner/repo/pull/123
  //          github.com/owner/repo/pull/123
  const urlMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:[/?#]|$)/i,
  );
  if (urlMatch) {
    const num = Number(urlMatch[1]);
    return Number.isSafeInteger(num) && num > 0 ? num : null;
  }

  return null;
}

async function getPrInfo(
  pi: ExtensionAPI,
  prNumber: number,
): Promise<{ baseBranch: string; title: string; headBranch: string } | null | "timedOut"> {
  const { stdout, code, killed } = await pi.exec(
    "gh",
    ["pr", "view", String(prNumber), "--json", "baseRefName,title,headRefName"],
    { timeout: GIT_GH_COMMAND_TIMEOUT_MS },
  );

  if (killed) return "timedOut";
  if (code !== 0) return null;

  try {
    const data = JSON.parse(stdout);
    return {
      baseBranch: data.baseRefName,
      title: data.title,
      headBranch: data.headRefName,
    };
  } catch {
    return null;
  }
}

async function checkoutPullRequest(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  ref: string,
): Promise<ReviewTarget | null> {
  const prNumber = parsePrReference(ref);
  if (!prNumber) {
    ctx.ui.notify("Invalid PR reference. Enter a number or GitHub PR URL.", "error");
    return null;
  }

  ctx.ui.notify(`Fetching PR #${prNumber} info...`, "info");
  const prInfo = await getPrInfo(pi, prNumber);
  if (prInfo === "timedOut") {
    ctx.ui.notify(`gh pr view timed out while fetching PR #${prNumber}.`, "error");
    return null;
  }
  if (!prInfo) {
    ctx.ui.notify(
      `Could not find PR #${prNumber}. Make sure gh is authenticated and the PR exists.`,
      "error",
    );
    return null;
  }

  const pendingChanges = await hasPendingChanges(pi, ctx);
  if (pendingChanges === null) return null;
  if (pendingChanges) {
    ctx.ui.notify(
      "Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.",
      "error",
    );
    return null;
  }

  await getRunModels(ctx, "reviewModel");
  ctx.ui.notify(`Checking out PR #${prNumber}...`, "info");
  const { stdout, stderr, code, killed } = await pi.exec(
    "gh",
    ["pr", "checkout", String(prNumber)],
    { timeout: PR_CHECKOUT_TIMEOUT_MS },
  );
  if (killed) {
    ctx.ui.notify("gh pr checkout timed out; check the working tree before retrying.", "error");
    return null;
  }
  if (code !== 0) {
    ctx.ui.notify(`Failed to checkout PR: ${stderr || stdout || "Failed to checkout PR"}`, "error");
    return null;
  }

  ctx.ui.notify(`Checked out PR #${prNumber} (${prInfo.headBranch})`, "info");
  return {
    type: "pullRequest",
    prNumber,
    baseBranch: prInfo.baseBranch,
    title: prInfo.title,
  };
}

async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
  const { stdout, code, killed } = await pi.exec("git", ["branch", "--show-current"], {
    timeout: GIT_GH_COMMAND_TIMEOUT_MS,
  });
  if (!killed && code === 0 && stdout.trim()) {
    return stdout.trim();
  }
  return null;
}

async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
  const { stdout, code, killed } = await pi.exec(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    { timeout: GIT_GH_COMMAND_TIMEOUT_MS },
  );
  if (!killed && code === 0 && stdout.trim()) {
    return stdout.trim().replace("origin/", "");
  }

  const branches = await getLocalBranches(pi);
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";

  return "main";
}

async function buildReviewPrompt(
  pi: ExtensionAPI,
  target: ReviewTarget,
  options?: { includeLocalChanges?: boolean },
): Promise<string> {
  const includeLocalChanges = options?.includeLocalChanges === true;

  switch (target.type) {
    case "uncommitted":
      return UNCOMMITTED_PROMPT;

    case "baseBranch": {
      const mergeBase = await getMergeBase(pi, target.branch);
      const basePrompt = mergeBase
        ? BASE_BRANCH_PROMPT_WITH_MERGE_BASE.replace(/{baseBranch}/g, target.branch).replace(
            /{mergeBaseSha}/g,
            mergeBase,
          )
        : BASE_BRANCH_PROMPT_FALLBACK.replace(/{branch}/g, target.branch);
      return includeLocalChanges
        ? `${basePrompt} ${LOCAL_CHANGES_REVIEW_INSTRUCTIONS}`
        : basePrompt;
    }

    case "commit":
      if (target.title) {
        return COMMIT_PROMPT_WITH_TITLE.replace("{sha}", target.sha).replace(
          "{title}",
          target.title,
        );
      }
      return COMMIT_PROMPT.replace("{sha}", target.sha);

    case "pullRequest": {
      const mergeBase = await getMergeBase(pi, target.baseBranch);
      const basePrompt = mergeBase
        ? PULL_REQUEST_PROMPT.replace(/{prNumber}/g, String(target.prNumber))
            .replace(/{title}/g, target.title)
            .replace(/{baseBranch}/g, target.baseBranch)
            .replace(/{mergeBaseSha}/g, mergeBase)
        : PULL_REQUEST_PROMPT_FALLBACK.replace(/{prNumber}/g, String(target.prNumber))
            .replace(/{title}/g, target.title)
            .replace(/{baseBranch}/g, target.baseBranch);
      return includeLocalChanges
        ? `${basePrompt} ${LOCAL_CHANGES_REVIEW_INSTRUCTIONS}`
        : basePrompt;
    }

    case "folder":
      return FOLDER_REVIEW_PROMPT.replace("{paths}", target.paths.join(", "));
  }
}

type ComposeReviewPromptOptions = {
  customInstructions?: string;
  extraInstruction?: string;
  projectGuidelines?: string | null;
};

function composeReviewPrompt(prompt: string, options: ComposeReviewPromptOptions = {}): string {
  let fullPrompt = `${REVIEW_RUBRIC}\n\n---\n\nPlease perform a code review with the following focus:\n\n${prompt}`;

  if (options.customInstructions?.trim()) {
    fullPrompt += `\n\nShared custom review instructions (applies to all reviews):\n\n${options.customInstructions.trim()}`;
  }

  if (options.extraInstruction?.trim()) {
    fullPrompt += `\n\nAdditional user-provided review instruction:\n\n${options.extraInstruction.trim()}`;
  }

  if (options.projectGuidelines?.trim()) {
    fullPrompt += `\n\nThis project has additional instructions for code reviews:\n\n${options.projectGuidelines.trim()}`;
  }

  return fullPrompt;
}

function getUserFacingHint(target: ReviewTarget): string {
  switch (target.type) {
    case "uncommitted":
      return "current changes";
    case "baseBranch":
      return `changes against '${target.branch}'`;
    case "commit": {
      const shortSha = target.sha.slice(0, 7);
      return target.title ? `commit ${shortSha}: ${target.title}` : `commit ${shortSha}`;
    }

    case "pullRequest": {
      const shortTitle =
        target.title.length > 30 ? target.title.slice(0, 27) + "..." : target.title;
      return `PR #${target.prNumber}: ${shortTitle}`;
    }

    case "folder": {
      const joined = target.paths.join(", ");
      return joined.length > 40 ? `folders: ${joined.slice(0, 37)}...` : `folders: ${joined}`;
    }
  }
}

type AssistantSnapshot = {
  id: string;
  text: string;
  stopReason?: string;
};

function extractAssistantTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const textParts = content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part,
      ),
    )
    .map((part) => part.text);
  return textParts.join("\n").trim();
}

function getLastAssistantSnapshot(ctx: ExtensionContext): AssistantSnapshot | null {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }

    const assistantMessage = entry.message as { content?: unknown; stopReason?: string };
    return {
      id: entry.id,
      text: extractAssistantTextContent(assistantMessage.content),
      stopReason: assistantMessage.stopReason,
    };
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenizeArgs(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];

    if (quote) {
      if (char === "\\" && i + 1 < value.length) {
        current += value[i + 1];
        i += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function parseReviewPaths(value: string): string[] {
  return tokenizeArgs(value)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

type ParsedReviewArgs = {
  target: ReviewTarget | { type: "pr"; ref: string } | null;
  extraInstruction?: string;
  error?: string;
};

function parseArgs(args: string | undefined): ParsedReviewArgs {
  if (!args?.trim()) return { target: null };

  const rawParts = tokenizeArgs(args.trim());
  const parts: string[] = [];
  let extraInstruction: string | undefined;

  for (let i = 0; i < rawParts.length; i++) {
    const part = rawParts[i];
    if (part === "--extra") {
      const next = rawParts[i + 1];
      if (!next) {
        return { target: null, error: "Missing value for --extra" };
      }
      extraInstruction = next;
      i += 1;
      continue;
    }

    if (part.startsWith("--extra=")) {
      extraInstruction = part.slice("--extra=".length);
      continue;
    }

    parts.push(part);
  }

  if (parts.length === 0) {
    return { target: null, extraInstruction };
  }

  const subcommand = parts[0]?.toLowerCase();

  switch (subcommand) {
    case "uncommitted":
      return { target: { type: "uncommitted" }, extraInstruction };

    case "branch": {
      const branch = parts[1];
      if (!branch) return { target: null, extraInstruction };
      return { target: { type: "baseBranch", branch }, extraInstruction };
    }

    case "commit": {
      const sha = parts[1];
      if (!sha) return { target: null, extraInstruction };
      const title = parts.slice(2).join(" ") || undefined;
      return { target: { type: "commit", sha, title }, extraInstruction };
    }

    case "folder": {
      const paths = parts
        .slice(1)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (paths.length === 0) return { target: null, extraInstruction };
      return { target: { type: "folder", paths }, extraInstruction };
    }

    case "pr": {
      const ref = parts[1];
      if (!ref) return { target: null, extraInstruction };
      return { target: { type: "pr", ref }, extraInstruction };
    }

    default:
      return { target: null, extraInstruction };
  }
}

async function waitForLoopTurnToStart(
  ctx: ExtensionContext,
  previousAssistantId?: string,
): Promise<boolean> {
  const deadline = Date.now() + REVIEW_LOOP_START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const lastAssistantId = getLastAssistantSnapshot(ctx)?.id;
    if (
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      (lastAssistantId && lastAssistantId !== previousAssistantId)
    ) {
      return true;
    }
    await sleep(REVIEW_LOOP_START_POLL_MS);
  }

  return false;
}

// Review preset options for the selector (keep this order stable)
const REVIEW_PRESETS = [
  { value: "uncommitted", label: "Review uncommitted changes", description: "" },
  { value: "baseBranch", label: "Review against a base branch", description: "(local)" },
  { value: "commit", label: "Review a commit", description: "" },
  { value: "pullRequest", label: "Review a pull request", description: "(GitHub PR)" },
  { value: "folder", label: "Review a folder (or more)", description: "(snapshot, not diff)" },
] as const;

const TOGGLE_LOOP_FIXING_VALUE = "toggleLoopFixing" as const;
const TOGGLE_CUSTOM_INSTRUCTIONS_VALUE = "toggleCustomInstructions" as const;
type ReviewPresetValue =
  | (typeof REVIEW_PRESETS)[number]["value"]
  | "modelSettings"
  | typeof TOGGLE_LOOP_FIXING_VALUE
  | typeof TOGGLE_CUSTOM_INSTRUCTIONS_VALUE;

const REVIEW_SUMMARY_PROMPT = `We are leaving a code-review branch and returning to the main coding branch.
Create a structured handoff that can be used immediately to implement fixes.

You MUST summarize the review that happened in this branch so findings can be acted on.
Do not omit findings: include every actionable issue that was identified.

Required sections (in order):

## Review Scope
- What was reviewed (files/paths, changes, and scope)

## Verdict
- "correct" or "needs attention"

## Findings
For EACH finding, include:
- Priority tag ([P0]..[P3]) and short title
- File location (\`path/to/file.ext:line\`)
- Why it matters (brief)
- What should change (brief, actionable)

## Fix Queue
1. Ordered implementation checklist (highest priority first)

## Constraints & Preferences
- Any constraints or preferences mentioned during review
- Or "(none)"

${HUMAN_REVIEWER_CALLOUTS}

Preserve exact file paths, function names, and error messages where available.`;

export const __test__ = {
  saveModelSetting,
  applyReviewSettings,
  applyReviewState,
  buildReviewPrompt,
  composeReviewPrompt,
  getReviewRuntimeState,
  getReviewSettings,
  getReviewState,
  hasBlockingReviewFindings,
  hasNeedsAttentionVerdict,
  getUserFacingHint,
  parseArgs,
  parsePrReference,
  parseReviewPaths,
  HUMAN_REVIEWER_CALLOUTS,
  REVIEW_RUBRIC,
  REVIEW_SUMMARY_PROMPT,
  loadProjectReviewGuidelines,
  resetReviewRuntimeState,
  tokenizeArgs,
};

export default function reviewExtension(pi: ExtensionAPI) {
  if (lt(VERSION, "0.86.0")) {
    throw new Error(`pi-review requires Pi 0.86.0 or newer (running ${VERSION}).`);
  }
  async function trySetModel(model: Model, ctx: ExtensionContext) {
    const ref = modelRef(model);
    try {
      const available = ctx.modelRegistry.getAvailable().find(m => modelRef(m) === ref);
      if (!available || !await pi.setModel(available)) throw new Error("Model unavailable.");
      return true;
    } catch (error) {
      const current = ctx.model ? ` Using ${modelRef(ctx.model)}.` : "";
      ctx.ui.notify(`Could not select ${ref}. ${error instanceof Error ? error.message : error}${current}`, "warning");
      return false;
    }
  }

  // sendUserMessage returns before input hooks finish. Scope model selection and restoration to this run.
  type ModelSnapshot = { model: Model; thinking: ThinkingLevel; leaf: string | null; defaults: ThinkingDefaults };
  type Phase = RunModel & { waitForIdle: () => Promise<void>; restore?: () => Promise<void> };
  const promptModel = new AsyncLocalStorage<Phase>();
  const activePhases = new WeakMap<ExtensionContext["sessionManager"], Phase>();
  const quitting = new WeakSet<ExtensionContext["sessionManager"]>();
  // Pi appends a clamp directly after model_change. Earlier event handlers may append more entries.
  const selectionAdjustments = new WeakMap<ModelChangeEntry, object | undefined>();
  pi.on("model_select", (event, ctx) => {
    if (event.source === "restore") return;
    let entry = ctx.sessionManager.getLeafEntry();
    let child;
    while (entry && entry.type !== "model_change") {
      child = entry;
      entry = entry.parentId ? ctx.sessionManager.getEntry(entry.parentId) : undefined;
    }
    if (entry?.provider === event.model.provider && entry.modelId === event.model.id) {
      selectionAdjustments.set(entry, child?.type === "thinking_level_change" ? child : undefined);
    }
  });

  function thinkingDefaults(ctx: ExtensionContext): ThinkingDefaults {
    if ("getSettings" in pi && typeof pi.getSettings === "function") return pi.getSettings();
    // Pi 0.86 exposes the configured defaults through SettingsManager.
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
    return { defaultThinkingLevel: settings.getDefaultThinkingLevel(), modelThinkingLevels: settings.getAllModelThinkingLevels() };
  }

  pi.on("before_agent_start", async (event, ctx) => {
    const override = promptModel.getStore();
    if (!override || override.restore || !("prompt" in event) || !ctx.model) return;
    const session = ctx.sessionManager;
    if (quitting.has(session)) return;
    const start = {
      model: ctx.model, thinking: pi.getThinkingLevel(),
      leaf: ctx.sessionManager.getLeafId(), defaults: thinkingDefaults(ctx),
    };
    const applied = Promise.withResolvers<void>();
    let restoring: Promise<void> | undefined;
    override.restore = () => {
      restoring ??= applied.promise.then(() => restoreModel(ctx, start)).finally(() => {
        if (activePhases.get(session) === override) activePhases.delete(session);
      });
      return restoring;
    };
    activePhases.set(session, override);
    try {
      if (override.model && modelRef(override.model) !== modelRef(start.model)) {
        if (!await trySetModel(override.model, ctx)) return;
        const selectedLevel = pi.getThinkingLevel();
        // An embedded Pi session can supply an in-memory default instead of the on-disk one.
        if (selectedLevel !== clampThinkingLevel(override.model, start.thinking)) {
          (start.defaults.modelThinkingLevels ??= {})[modelRef(override.model)] = selectedLevel;
        }
      }
      if (override.thinking !== undefined && override.thinking !== pi.getThinkingLevel()) {
        pi.setThinkingLevel(override.thinking);
        // Only later changes can be user overrides of this phase's level.
        start.leaf = ctx.sessionManager.getLeafId();
      }
    } finally {
      applied.resolve();
      if (quitting.has(session)) await override.restore();
    }
  });

  async function restoreModel(ctx: ExtensionContext, start: ModelSnapshot) {
    let manualThinking: ThinkingLevel | undefined;
    let recordedModel: string | undefined;
    let entry = ctx.sessionManager.getLeafEntry();
    while (entry && entry.id !== start.leaf && (!recordedModel || manualThinking === undefined)) {
      const change = entry;
      entry = change.parentId ? ctx.sessionManager.getEntry(change.parentId) : undefined;
      // On resume Pi also takes the model from the latest assistant message, including an aborted one.
      if (recordedModel === undefined) {
        if (change.type === "model_change") recordedModel = `${change.provider}/${change.modelId}`;
        else if (change.type === "message" && change.message.role === "assistant") {
          recordedModel = `${change.message.provider}/${change.message.model}`;
        }
      }
      if (manualThinking !== undefined || change.type !== "thinking_level_change") continue;
      if (entry?.type === "model_change") {
        if (selectionAdjustments.has(entry)) {
          if (selectionAdjustments.get(entry) === change) continue;
        } else {
          // Pi skips model_select on reselection. An adjacent manual change can differ from its default.
          const level = start.defaults.modelThinkingLevels?.[`${entry.provider}/${entry.modelId}`] ?? start.defaults.defaultThinkingLevel;
          const model = ctx.modelRegistry.find(entry.provider, entry.modelId);
          if (model && level && clampThinkingLevel(model, level) === change.thinkingLevel) continue;
        }
      }
      manualThinking = change.thinkingLevel as ThinkingLevel;
    }
    const original = modelRef(start.model);
    if (!ctx.model || modelRef(ctx.model) !== original || (recordedModel && recordedModel !== original)) {
      await trySetModel(start.model, ctx);
    }
    const thinking = manualThinking ?? start.thinking;
    if (pi.getThinkingLevel() !== thinking) pi.setThinkingLevel(thinking);
  }

  pi.on("agent_settled", () => promptModel.getStore()?.restore?.());
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "quit") return;
    const session = ctx.sessionManager;
    quitting.add(session);
    const phase = activePhases.get(session);
    if (!phase) return;
    // Pi 0.86 emits shutdown before aborting. Let the final message reach the transcript first.
    try {
      if (!ctx.isIdle()) {
        ctx.abort();
        await phase.waitForIdle();
      }
    } finally {
      await phase.restore?.();
    }
  });

  function persistReviewSettings() {
    pi.appendEntry(REVIEW_SETTINGS_TYPE, {
      loopFixingEnabled: reviewLoopFixingEnabled,
      customInstructions: reviewCustomInstructions,
    });
  }

  function setReviewLoopFixingEnabled(enabled: boolean) {
    reviewLoopFixingEnabled = enabled;
    persistReviewSettings();
  }

  function setReviewCustomInstructions(instructions: string | undefined) {
    reviewCustomInstructions = instructions?.trim() || undefined;
    persistReviewSettings();
  }

  function applyAllReviewState(ctx: ExtensionContext) {
    applyReviewSettings(ctx);
    applyReviewState(ctx);
  }

  pi.on("session_start", (_event, ctx) => {
    quitting.delete(ctx.sessionManager);
    applyAllReviewState(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    applyAllReviewState(ctx);
  });

  async function getSmartDefault(): Promise<"uncommitted" | "baseBranch" | "commit"> {
    if (await hasUncommittedChanges(pi)) {
      return "uncommitted";
    }

    const currentBranch = await getCurrentBranch(pi);
    const defaultBranch = await getDefaultBranch(pi);
    if (currentBranch && currentBranch !== defaultBranch) {
      return "baseBranch";
    }

    return "commit";
  }

  async function showModelSettings(ctx: ExtensionContext) {
    const settings = await readModelSettings();
    const useSession = "Use session model";
    const fields = ["reviewModel", "fixModel"] as const;
    const labels = fields.map(field => {
      const value = settings[field];
      const selection = typeof value === "string" ? value : value === undefined ? useSession : "Invalid selection";
      const level = settings[THINKING_FIELD[field]];
      return `${field === "reviewModel" ? "Review" : "Fix"}: ${selection}${typeof level === "string" ? ` (${level})` : ""}`;
    });
    const choice = await ctx.ui.select("Model settings", labels);
    if (choice === undefined) return;
    const field = fields[labels.indexOf(choice)];
    const phase = field === "reviewModel" ? "Review" : "Fix";
    const scope = new Set(ctx.scopedModels.map(({ model }) => modelRef(model)));
    const available = ctx.modelRegistry.getAvailable();
    const models = available.map(modelRef).filter(ref => !scope.size || scope.has(ref)).sort();
    const selected = await showSearchableSelect(ctx, {
      title: `${phase} model`,
      items: [useSession, ...models].map(value => ({ value, label: value })),
      emptyCopy: "No matching models",
      mapResult: item => item.value,
    });
    if (selected === null) return;
    const model = available.find(m => modelRef(m) === selected);
    let thinking: ThinkingLevel | undefined;
    if (model) {
      const levels = getSupportedThinkingLevels(model);
      if (!levels.length) {
        ctx.ui.notify(`${selected} has no supported thinking levels.`, "warning");
        return;
      }
      const current = levels.find(level => selected === settings[field] && level === settings[THINKING_FIELD[field]]);
      const choices = current ? [current, ...levels.filter(level => level !== current)] : levels;
      const selectedLevel = await ctx.ui.select(`${phase} thinking level`, choices);
      thinking = levels.find(level => level === selectedLevel);
      if (thinking === undefined) return;
    }
    await saveModelSetting(path.join(getAgentDir(), "review.json"), field, settings, model && selected, thinking);
    ctx.ui.notify("Model settings saved.", "info");
  }

  async function showReviewSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
    // Determine smart default (but keep the list order stable)
    const smartDefault = await getSmartDefault();
    const presetItems: SelectItem[] = REVIEW_PRESETS.map((preset) => ({
      value: preset.value,
      label: preset.label,
      description: preset.description,
    }));
    const smartDefaultIndex = presetItems.findIndex((item) => item.value === smartDefault);

    while (true) {
      const customInstructionsLabel = reviewCustomInstructions
        ? "Remove custom review instructions"
        : "Add custom review instructions";
      const customInstructionsDescription = reviewCustomInstructions
        ? "(currently set)"
        : "(applies to all review modes)";
      const loopToggleLabel = reviewLoopFixingEnabled
        ? "Disable Loop Fixing"
        : "Enable Loop Fixing";
      const loopToggleDescription = reviewLoopFixingEnabled ? "(currently on)" : "(currently off)";
      const items: SelectItem[] = [
        ...presetItems,
        {
          value: TOGGLE_CUSTOM_INSTRUCTIONS_VALUE,
          label: customInstructionsLabel,
          description: customInstructionsDescription,
        },
        { value: "modelSettings", label: "Model settings", description: "(review and fix)" },
        {
          value: TOGGLE_LOOP_FIXING_VALUE,
          label: loopToggleLabel,
          description: loopToggleDescription,
        },
      ];

      const result = await ctx.ui.custom<ReviewPresetValue | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Select a review preset"))));

        const selectList = new SelectList(items, Math.min(items.length, 10), {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        });

        // Preselect the smart default without reordering the list
        if (smartDefaultIndex >= 0) {
          selectList.setSelectedIndex(smartDefaultIndex);
        }

        selectList.onSelect = (item) => done(item.value as ReviewPresetValue);
        selectList.onCancel = () => done(null);

        container.addChild(selectList);
        container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to go back")));
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

        return {
          capturesViewportInput: true,
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      }, SELECTOR_BLOCKED_OPTIONS("Select a review preset"));

      if (!result) return null;

      if (result === "modelSettings") {
        await showModelSettings(ctx);
        continue;
      }

      if (result === TOGGLE_LOOP_FIXING_VALUE) {
        const nextEnabled = !reviewLoopFixingEnabled;
        setReviewLoopFixingEnabled(nextEnabled);
        ctx.ui.notify(nextEnabled ? "Loop fixing enabled" : "Loop fixing disabled", "info");
        continue;
      }

      if (result === TOGGLE_CUSTOM_INSTRUCTIONS_VALUE) {
        if (reviewCustomInstructions) {
          setReviewCustomInstructions(undefined);
          ctx.ui.notify("Custom review instructions removed", "info");
          continue;
        }

        const customInstructions = await ctx.ui.editor(
          "Enter custom review instructions (applies to all review modes):",
          "",
        );

        if (!customInstructions?.trim()) {
          ctx.ui.notify("Custom review instructions not changed", "info");
          continue;
        }

        setReviewCustomInstructions(customInstructions);
        ctx.ui.notify("Custom review instructions saved", "info");
        continue;
      }

      switch (result) {
        case "uncommitted":
          return { type: "uncommitted" };

        case "baseBranch": {
          const target = await showBranchSelector(ctx);
          if (target) return target;
          break;
        }

        case "commit": {
          if (reviewLoopFixingEnabled) {
            ctx.ui.notify("Loop mode does not work with commit review.", "error");
            break;
          }
          const target = await showCommitSelector(ctx);
          if (target) return target;
          break;
        }

        case "folder": {
          const target = await showFolderInput(ctx);
          if (target) return target;
          break;
        }

        case "pullRequest": {
          const target = await showPrInput(ctx);
          if (target) return target;
          break;
        }

        default:
          return null;
      }
    }
  }

  // Pi >= 1.5.0 reports "waiting for user" while this inline component is shown; older hosts ignore it.
  const SELECTOR_BLOCKED_OPTIONS = (message: string) =>
    ({ blocked: { kind: "question", message } }) as Record<string, unknown>;

  async function showSearchableSelect<T>(
    ctx: ExtensionContext,
    options: {
      title: string;
      items: SelectItem[];
      emptyCopy: string;
      mapResult: (item: SelectItem) => T | null;
    },
  ): Promise<T | null> {
    const { title, items, emptyCopy, mapResult } = options;
    return ctx.ui.custom<T | null>((tui, theme, keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title))));

      const searchInput = new Input();
      container.addChild(searchInput);
      container.addChild(new Spacer(1));

      const listContainer = new Container();
      container.addChild(listContainer);
      container.addChild(
        new Text(theme.fg("dim", "Type to filter • enter to select • esc to cancel")),
      );
      container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

      let filteredItems = items;
      let selectList: SelectList | null = null;

      const updateList = () => {
        listContainer.clear();
        if (filteredItems.length === 0) {
          listContainer.addChild(new Text(theme.fg("warning", emptyCopy)));
          selectList = null;
          return;
        }

        selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 10), {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        });

        selectList.onSelect = (item) => done(mapResult(item));
        selectList.onCancel = () => done(null);
        listContainer.addChild(selectList);
      };

      const applyFilter = () => {
        const query = searchInput.getValue();
        filteredItems = query
          ? fuzzyFilter(
              items,
              query,
              (item) => `${item.label} ${item.value} ${item.description ?? ""}`,
            )
          : items;
        updateList();
      };

      applyFilter();

      return {
        capturesViewportInput: true,
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          if (
            keybindings.matches(data, "tui.select.pageUp") ||
            keybindings.matches(data, "tui.select.pageDown") ||
            keybindings.matches(data, "tui.select.up") ||
            keybindings.matches(data, "tui.select.down") ||
            keybindings.matches(data, "tui.select.confirm") ||
            keybindings.matches(data, "tui.select.cancel")
          ) {
            if (selectList) {
              selectList.handleInput(data);
            } else if (keybindings.matches(data, "tui.select.cancel")) {
              done(null);
            }
            tui.requestRender();
            return;
          }

          searchInput.handleInput(data);
          applyFilter();
          tui.requestRender();
        },
      };
    }, SELECTOR_BLOCKED_OPTIONS(title));
  }

  async function showBranchSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
    const branches = await getLocalBranches(pi);
    const currentBranch = await getCurrentBranch(pi);
    const defaultBranch = await getDefaultBranch(pi);

    // Never offer the current branch as a base branch (reviewing against itself is meaningless).
    const candidateBranches = currentBranch
      ? branches.filter((b) => b !== currentBranch)
      : branches;

    if (candidateBranches.length === 0) {
      ctx.ui.notify(
        currentBranch
          ? `No other branches found (current branch: ${currentBranch})`
          : "No branches found",
        "error",
      );
      return null;
    }

    // Sort branches with default branch first
    const sortedBranches = candidateBranches.sort((a, b) => {
      if (a === defaultBranch) return -1;
      if (b === defaultBranch) return 1;
      return a.localeCompare(b);
    });

    const items: SelectItem[] = sortedBranches.map((branch) => ({
      value: branch,
      label: branch,
      description: branch === defaultBranch ? "(default)" : "",
    }));

    const branch = await showSearchableSelect(ctx, {
      title: "Select base branch",
      items,
      emptyCopy: "  No matching branches",
      mapResult: (item) => item.value,
    });
    if (!branch) return null;
    return { type: "baseBranch", branch };
  }

  async function showCommitSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
    const commits = await getRecentCommits(pi, 20);

    if (commits.length === 0) {
      ctx.ui.notify("No commits found", "error");
      return null;
    }

    const items: SelectItem[] = commits.map((commit) => ({
      value: commit.sha,
      label: `${commit.sha.slice(0, 7)} ${commit.title}`,
      description: "",
    }));

    const commit = await showSearchableSelect(ctx, {
      title: "Select commit to review",
      items,
      emptyCopy: "  No matching commits",
      mapResult: (item) => commits.find((candidate) => candidate.sha === item.value) ?? null,
    });
    if (!commit) return null;
    return { type: "commit", sha: commit.sha, title: commit.title };
  }

  async function showFolderInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
    const result = await ctx.ui.editor(
      "Enter folders/files to review (space-separated or one per line):",
      ".",
    );

    if (!result?.trim()) return null;
    const paths = parseReviewPaths(result);
    if (paths.length === 0) return null;

    return { type: "folder", paths };
  }

  async function showPrInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
    const prRef = await ctx.ui.editor(
      "Enter PR number or URL (e.g. 123 or https://github.com/owner/repo/pull/123):",
      "",
    );

    if (!prRef?.trim()) return null;
    return checkoutPullRequest(pi, ctx, prRef);
  }

  async function executeReview(
    ctx: ExtensionCommandContext,
    target: ReviewTarget,
    useFreshSession: boolean,
    options?: {
      includeLocalChanges?: boolean;
      extraInstruction?: string;
      onBeforeSend?: () => void;
    },
  ): Promise<boolean> {
    if (reviewOriginId) {
      ctx.ui.notify("Already in a review. Use /end-review to finish first.", "warning");
      return false;
    }

    const { override, session, fallback } = await getRunModels(ctx, "reviewModel");
    if (fallback) ctx.ui.notify("Review model unavailable. Using the session model.", "warning");
    if (!session && override.model) {
      if (!await pi.setModel(override.model)) throw new Error(`Could not select ${modelRef(override.model)} as the session model.`);
      ctx.ui.notify(`Using ${modelRef(override.model)} as the session model.`, "info");
    }
    if (useFreshSession) {
      // In an empty session there is no leaf yet, so create a lightweight anchor first.
      let originId = ctx.sessionManager.getLeafId() ?? undefined;
      if (!originId) {
        pi.appendEntry(REVIEW_ANCHOR_TYPE, { createdAt: new Date().toISOString() });
        originId = ctx.sessionManager.getLeafId() ?? undefined;
      }
      if (!originId) {
        ctx.ui.notify("Failed to determine review origin.", "error");
        return false;
      }
      reviewOriginId = originId;

      // Keep a local copy so session_tree events during navigation don't wipe it
      const lockedOriginId = originId;

      // No user message (brand-new session): stay on the current leaf.
      const entries = ctx.sessionManager.getEntries();
      const firstUserMessage = entries.find(
        (e) => e.type === "message" && e.message.role === "user",
      );

      if (firstUserMessage) {
        // Label the new branch so it stays visible in the session tree.
        try {
          const result = await ctx.navigateTree(firstUserMessage.id, {
            summarize: false,
            label: "code-review",
          });
          if (result.cancelled) {
            reviewOriginId = undefined;
            return false;
          }
        } catch (error) {
          reviewOriginId = undefined;
          ctx.ui.notify(
            `Failed to start review: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          return false;
        }

        // Clear the editor (navigating to user message fills it with the message text)
        ctx.ui.setEditorText("");
      }

      // Restore origin after navigation events (session_tree can reset it)
      reviewOriginId = lockedOriginId;

      setReviewWidget(ctx, true);

      // Persist review state so tree navigation can restore/reset it
      pi.appendEntry(REVIEW_STATE_TYPE, { active: true, originId: lockedOriginId });
    }

    const prompt = await buildReviewPrompt(pi, target, {
      includeLocalChanges: options?.includeLocalChanges === true,
    });
    const hint = getUserFacingHint(target);
    const projectGuidelines = canReadProjectConfig(ctx)
      ? await loadProjectReviewGuidelines(ctx.cwd)
      : null;

    const fullPrompt = composeReviewPrompt(prompt, {
      customInstructions: reviewCustomInstructions,
      extraInstruction: options?.extraInstruction,
      projectGuidelines,
    });

    const modeHint = useFreshSession ? " (fresh session)" : "";
    ctx.ui.notify(`Starting review: ${hint}${modeHint}`, "info");

    options?.onBeforeSend?.();
    promptModel.run({ ...override, waitForIdle: () => ctx.waitForIdle() }, () => pi.sendUserMessage(fullPrompt));
    return true;
  }

  async function runLoopFixingReview(
    ctx: ExtensionCommandContext,
    target: ReviewTarget,
    extraInstruction?: string,
  ): Promise<void> {
    if (reviewLoopInProgress) {
      ctx.ui.notify("Loop fixing review is already running.", "warning");
      return;
    }

    reviewLoopInProgress = true;
    setReviewWidget(ctx, Boolean(reviewOriginId));
    try {
      ctx.ui.notify(
        "Loop fixing enabled: using Empty branch mode and cycling until no blocking findings remain.",
        "info",
      );

      for (let pass = 1; pass <= REVIEW_LOOP_MAX_ITERATIONS; pass++) {
        let reviewBaselineAssistantId: string | undefined;
        const started = await executeReview(ctx, target, true, {
          includeLocalChanges: true,
          extraInstruction,
          onBeforeSend: () => {
            reviewBaselineAssistantId = getLastAssistantSnapshot(ctx)?.id;
          },
        });
        if (!started) {
          ctx.ui.notify("Loop fixing stopped before starting the review pass.", "warning");
          return;
        }

        const reviewTurnStarted = await waitForLoopTurnToStart(ctx, reviewBaselineAssistantId);
        if (!reviewTurnStarted) {
          ctx.ui.notify("Loop fixing stopped: review pass did not start in time.", "error");
          return;
        }

        await ctx.waitForIdle();

        const reviewSnapshot = getLastAssistantSnapshot(ctx);
        if (!reviewSnapshot || reviewSnapshot.id === reviewBaselineAssistantId) {
          ctx.ui.notify("Loop fixing stopped: could not read the review result.", "warning");
          return;
        }

        if (reviewSnapshot.stopReason === "aborted") {
          ctx.ui.notify("Loop fixing stopped: review was aborted.", "warning");
          return;
        }

        if (reviewSnapshot.stopReason === "error") {
          ctx.ui.notify("Loop fixing stopped: review failed with an error.", "error");
          return;
        }

        if (reviewSnapshot.stopReason === "length") {
          ctx.ui.notify(
            "Loop fixing stopped: review output was truncated (stopReason=length).",
            "warning",
          );
          return;
        }

        if (!hasBlockingReviewFindings(reviewSnapshot.text)) {
          const finalized = await executeEndReviewAction(ctx, "returnAndSummarize", {
            showSummaryLoader: true,
            notifySuccess: false,
          });
          if (finalized === "late-success") {
            ctx.ui.notify("Loop fixing stopped: review result was not finalized.", "warning");
            return;
          }
          if (finalized !== "ok") {
            return;
          }

          ctx.ui.notify("Loop fixing complete: no blocking findings remain.", "info");
          return;
        }

        ctx.ui.notify(
          `Loop fixing pass ${pass}: found blocking findings, returning to fix them...`,
          "info",
        );

        let fixBaselineAssistantId: string | undefined;
        const sentFixPrompt = await executeEndReviewAction(ctx, "returnAndFix", {
          showSummaryLoader: true,
          notifySuccess: false,
          onBeforeSend: () => {
            fixBaselineAssistantId = getLastAssistantSnapshot(ctx)?.id;
          },
        });
        if (sentFixPrompt === "late-success") {
          ctx.ui.notify("Loop fixing stopped: no fix prompt was submitted.", "warning");
          return;
        }
        if (sentFixPrompt !== "ok") {
          return;
        }

        const fixTurnStarted = await waitForLoopTurnToStart(ctx, fixBaselineAssistantId);
        if (!fixTurnStarted) {
          ctx.ui.notify("Loop fixing stopped: fix pass did not start in time.", "error");
          return;
        }

        await ctx.waitForIdle();

        const fixSnapshot = getLastAssistantSnapshot(ctx);
        if (!fixSnapshot || fixSnapshot.id === fixBaselineAssistantId) {
          ctx.ui.notify("Loop fixing stopped: could not read the fix pass result.", "warning");
          return;
        }
        if (fixSnapshot.stopReason === "aborted") {
          ctx.ui.notify("Loop fixing stopped: fix pass was aborted.", "warning");
          return;
        }
        if (fixSnapshot.stopReason === "error") {
          ctx.ui.notify("Loop fixing stopped: fix pass failed with an error.", "error");
          return;
        }
        if (fixSnapshot.stopReason === "length") {
          ctx.ui.notify(
            "Loop fixing stopped: fix pass output was truncated (stopReason=length).",
            "warning",
          );
          return;
        }
      }

      ctx.ui.notify(
        `Loop fixing stopped after ${REVIEW_LOOP_MAX_ITERATIONS} passes (safety limit reached).`,
        "warning",
      );
    } finally {
      reviewLoopInProgress = false;
      setReviewWidget(ctx, Boolean(reviewOriginId));
    }
  }

  pi.registerCommand("review", {
    description: "Review code changes (PR, uncommitted, branch, commit, or folder)",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Review requires interactive mode", "error");
        return;
      }

      if (reviewLoopInProgress) {
        ctx.ui.notify("Loop fixing review is already running.", "warning");
        return;
      }

      if (reviewOriginId) {
        ctx.ui.notify("Already in a review. Use /end-review to finish first.", "warning");
        return;
      }

      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify(
          "Wait for the current response to finish before starting a review.",
          "warning",
        );
        return;
      }

      const { code, killed } = await pi.exec("git", ["rev-parse", "--git-dir"], {
        timeout: GIT_GH_COMMAND_TIMEOUT_MS,
      });
      if (killed || code !== 0) {
        ctx.ui.notify(killed ? "git rev-parse timed out" : "Not a git repository", "error");
        return;
      }

      let target: ReviewTarget | null = null;
      let fromSelector = false;
      let extraInstruction: string | undefined;
      const parsed = parseArgs(args);
      if (parsed.error) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }
      extraInstruction = parsed.extraInstruction?.trim() || undefined;

      if (parsed.target) {
        if (parsed.target.type === "pr") {
          target = await checkoutPullRequest(pi, ctx, parsed.target.ref);
          if (!target) {
            ctx.ui.notify("PR review failed. Returning to review menu.", "warning");
          }
        } else {
          target = parsed.target;
        }
      }

      if (!target) {
        fromSelector = true;
      }

      while (true) {
        if (!target && fromSelector) {
          target = await showReviewSelector(ctx);
        }

        if (!target) {
          ctx.ui.notify("Review cancelled", "info");
          return;
        }

        if (reviewLoopFixingEnabled && target.type === "commit") {
          ctx.ui.notify("Loop mode does not work with commit review.", "error");
          if (fromSelector) {
            target = null;
            continue;
          }
          return;
        }

        if (reviewLoopFixingEnabled) {
          await runLoopFixingReview(ctx, target, extraInstruction);
          return;
        }

        const entries = ctx.sessionManager.getEntries();
        const messageCount = entries.filter((e) => e.type === "message").length;

        // In an empty session, default to fresh review mode so /end-review works consistently.
        let useFreshSession = messageCount === 0;

        if (messageCount > 0) {
          const choice = await ctx.ui.select("Start review in:", [
            "Empty branch",
            "Current session",
          ]);

          if (choice === undefined) {
            if (fromSelector) {
              target = null;
              continue;
            }
            ctx.ui.notify("Review cancelled", "info");
            return;
          }

          useFreshSession = choice === "Empty branch";
        }

        await executeReview(ctx, target, useFreshSession, { extraInstruction });
        return;
      }
    },
  });

  const REVIEW_FIX_FINDINGS_PROMPT = `Use the latest review summary in this session and implement the review findings now.

Instructions:
1. Treat the summary's Findings/Fix Queue as a checklist.
2. Fix in priority order: P0, P1, then P2 (include P3 if quick and safe).
3. If a finding is invalid/already fixed/not possible right now, briefly explain why and continue.
4. Treat "Human Reviewer Callouts (Non-Blocking)" as informational only; do not convert them into fix tasks unless there is a separate explicit finding.
5. Follow fail-fast error handling: do not add local catch/fallback recovery unless this scope is an explicit boundary that can safely translate the failure.
6. If you add or keep a \`try/catch\`, explain the expected failure mode and either rethrow with context or return a boundary-safe error response.
7. JSON parsing/decoding should fail loudly by default; avoid silent fallback parsing.
8. Run relevant tests/checks for touched code where practical.
9. End with: fixed items, deferred/skipped items (with reasons), and verification results.`;

  type EndReviewAction = "returnOnly" | "returnAndFix" | "returnAndSummarize";
  type EndReviewActionResult = "ok" | "cancelled" | "late-success" | "error";
  type EndReviewActionOptions = {
    showSummaryLoader?: boolean;
    notifySuccess?: boolean;
    onBeforeSend?: () => void;
  };

  function getActiveReviewOrigin(ctx: ExtensionContext): string | undefined {
    if (reviewOriginId) {
      return reviewOriginId;
    }

    const state = getReviewState(ctx);
    if (state?.active && state.originId) {
      reviewOriginId = state.originId;
      return reviewOriginId;
    }

    if (state?.active) {
      setReviewWidget(ctx, false);
      pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
      ctx.ui.notify("Review state was missing origin info; cleared review status.", "warning");
    }

    return undefined;
  }

  function clearReviewState(ctx: ExtensionContext) {
    setReviewWidget(ctx, false);
    reviewOriginId = undefined;
    pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
  }

  type SummaryNavigationResult =
    | { status: "success" }
    | { status: "cancelled" }
    | { status: "late-success" }
    | { status: "error"; error: string };

  async function navigateWithSummary(
    ctx: ExtensionCommandContext,
    originId: string,
    showLoader: boolean,
  ): Promise<SummaryNavigationResult> {
    if (showLoader && ctx.mode === "tui") {
      return ctx.ui.custom<SummaryNavigationResult>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, "Returning and summarizing review branch...");
        let finished = false;
        let abortRequested = false;

        const finish = (result: SummaryNavigationResult) => {
          if (finished) return;
          finished = true;
          done(result);
        };

        const navigationPromise = ctx
          .navigateTree(originId, {
            summarize: true,
            customInstructions: REVIEW_SUMMARY_PROMPT,
            replaceInstructions: true,
          })
          .then((result) => {
            finish(
              result.cancelled
                ? { status: "cancelled" }
                : abortRequested
                  ? { status: "late-success" }
                  : { status: "success" },
            );
          })
          .catch((err) => {
            finish({ status: "error", error: err instanceof Error ? err.message : String(err) });
          });

        loader.onAbort = () => {
          if (abortRequested) return;
          abortRequested = true;
          void Promise.resolve()
            .then(() => ctx.abort())
            .catch(() => undefined)
            .then(() => navigationPromise)
            .catch(() => undefined);
        };

        return loader;
      });
    }

    try {
      const result = await ctx.navigateTree(originId, {
        summarize: true,
        customInstructions: REVIEW_SUMMARY_PROMPT,
        replaceInstructions: true,
      });
      return result.cancelled ? { status: "cancelled" } : { status: "success" };
    } catch (error) {
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function executeEndReviewAction(
    ctx: ExtensionCommandContext,
    action: EndReviewAction,
    options: EndReviewActionOptions = {},
  ): Promise<EndReviewActionResult> {
    const originId = getActiveReviewOrigin(ctx);
    if (!originId) {
      if (!getReviewState(ctx)?.active) {
        ctx.ui.notify(
          "Not in a review branch (use /review first, or review was started in current session mode)",
          "info",
        );
      }
      return "error";
    }

    const notifySuccess = options.notifySuccess ?? true;

    if (action === "returnOnly") {
      try {
        const result = await ctx.navigateTree(originId, { summarize: false });
        if (result.cancelled) {
          ctx.ui.notify("Navigation cancelled. Use /end-review to try again.", "info");
          return "cancelled";
        }
      } catch (error) {
        ctx.ui.notify(
          `Failed to return: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return "error";
      }

      clearReviewState(ctx);
      if (notifySuccess) {
        ctx.ui.notify("Review complete! Returned to original position.", "info");
      }
      return "ok";
    }

    let fixOverride: RunModel = {};
    if (action === "returnAndFix") {
      const { override, fallback } = await getRunModels(ctx, "fixModel");
      fixOverride = override;
      if (fallback) ctx.ui.notify("Fix model unavailable. Using the session model.", "warning");
    }
    const summaryResult = await navigateWithSummary(
      ctx,
      originId,
      options.showSummaryLoader ?? false,
    );
    if (summaryResult.status === "error") {
      ctx.ui.notify(`Summarization failed: ${summaryResult.error}`, "error");
      return "error";
    }

    if (summaryResult.status === "cancelled") {
      ctx.ui.notify("Navigation cancelled. Use /end-review to try again.", "info");
      return "cancelled";
    }

    clearReviewState(ctx);
    if (summaryResult.status === "late-success") {
      ctx.ui.notify(
        "Cancellation arrived too late; review already completed, and no follow-up was queued.",
        "warning",
      );
      return "late-success";
    }

    if (action === "returnAndSummarize") {
      if (!ctx.ui.getEditorText().trim()) {
        ctx.ui.setEditorText("Act on the review findings");
      }
      if (notifySuccess) {
        ctx.ui.notify("Review complete! Returned and summarized.", "info");
      }
      return "ok";
    }

    options.onBeforeSend?.();
    promptModel.run({ ...fixOverride, waitForIdle: () => ctx.waitForIdle() }, () =>
      pi.sendUserMessage(REVIEW_FIX_FINDINGS_PROMPT, { deliverAs: "followUp" }),
    );
    if (notifySuccess) {
      ctx.ui.notify("Review complete! Returned and queued a follow-up to fix findings.", "info");
    }
    return "ok";
  }

  async function runEndReview(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("End-review requires interactive mode", "error");
      return;
    }

    if (reviewLoopInProgress) {
      ctx.ui.notify("Loop fixing review is running. Wait for it to finish.", "info");
      return;
    }

    if (!getActiveReviewOrigin(ctx)) {
      if (!getReviewState(ctx)?.active) {
        ctx.ui.notify(
          "Not in a review branch (use /review first, or review was started in current session mode)",
          "info",
        );
      }
      return;
    }

    if (endReviewInProgress) {
      ctx.ui.notify("/end-review is already running", "info");
      return;
    }

    endReviewInProgress = true;
    try {
      const choice = await ctx.ui.select("Finish review:", [
        "Return only",
        "Return and fix findings",
        "Return and summarize",
      ]);

      if (choice === undefined) {
        ctx.ui.notify("Cancelled. Use /end-review to try again.", "info");
        return;
      }

      const action: EndReviewAction =
        choice === "Return and fix findings"
          ? "returnAndFix"
          : choice === "Return and summarize"
            ? "returnAndSummarize"
            : "returnOnly";

      await executeEndReviewAction(ctx, action, {
        showSummaryLoader: true,
        notifySuccess: true,
      });
    } finally {
      endReviewInProgress = false;
    }
  }

  pi.registerCommand("end-review", {
    description: "Complete review and return to original position",
    handler: async (_args, ctx) => {
      await runEndReview(ctx);
    },
  });
}
