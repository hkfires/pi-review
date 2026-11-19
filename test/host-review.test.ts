import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AgentSessionRuntime, createAgentSession, DefaultResourceLoader, initTheme, type KeybindingsManager, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import reviewExtension, { __test__ } from "../index.ts";

const review = { reviewModel: "local/review" };
const fix = { fixModel: "fix-provider/fix" };
const menuModelId = "team/Fix Model";
const menuFix = { fixModel: `fix-provider/${menuModelId}` };
const both = { ...review, ...fix };
const expiredFix = { ...review, fixModel: "fix-provider/retired", other: 42 };
const cases = [
  { name: "defaults", config: {}, models: ["session", "session", "session"] },
  { name: "review only", config: review, models: ["review", "session", "session"] },
  { name: "fix only", config: fix, models: ["session", "session", "fix"] },
  { name: "both", config: both, models: ["review", "session", "fix"] },
  { name: "review.json with a UTF-8 BOM", config: both, bom: true, models: ["review", "session", "fix"] },
  { name: "quit and resume during Review", config: { ...both, reviewThinkingLevel: "low" }, quitDuring: "review", reasoningModels: true, models: ["session", "review", "session"] },
  { name: "quit and resume during Fix", config: { ...both, fixThinkingLevel: "low" }, quitDuring: "fix", reasoningModels: true, models: ["session", "review", "session", "fix", "session"] },
  { name: "quit after switching back to the session model", config: { ...both, reviewThinkingLevel: "low" }, quitDuring: "review", manualReturn: true, reasoningModels: true, models: ["session", "review", "session"] },
  { name: "quit during the switch to the Review model", config: { ...both, reviewThinkingLevel: "low" }, quitDuring: "switch", reasoningModels: true, models: [] },
  { name: "independent model and thinking pairs", config: { ...both, reviewThinkingLevel: "medium", fixThinkingLevel: "low" }, models: ["review", "session", "fix"], reasoningModels: true, levels: ["medium", "high", "low"] },
  { name: "independent thinking on the session model", config: { reviewThinkingLevel: "off", fixThinkingLevel: "medium" }, models: ["session", "session", "session"], levels: ["off", "high", "medium"] },
  { name: "an earlier extension logs model changes", config: both, models: ["review", "session", "fix"], audit: true, levels: ["off", "high", "off"] },
  { name: "switch once during review", config: both, switchTo: ["alternate"], models: ["review", "session", "fix"] },
  { name: "switch back to review model", config: both, switchTo: ["alternate", "review"], models: ["review", "session", "fix"] },
  { name: "reselect Review with a thinking default", config: { ...both, reviewThinkingLevel: "low" }, reasoningModels: true, switchTo: ["review"], reselectDefault: "medium" as const, models: ["review", "session", "fix"], levels: ["low", "high", "high"] },
  { name: "reselect Fix with a thinking default", config: { ...both, fixThinkingLevel: "low" }, reasoningModels: true, switchTo: ["fix"], switchOnRequest: 3, reselectDefault: "medium" as const, models: ["review", "session", "fix"], levels: ["high", "high", "low"] },
  { name: "reselect the session model with a global thinking default", config: { reviewThinkingLevel: "low" }, switchTo: ["session"], reselectDefault: "medium" as const, models: ["session", "session", "session"], levels: ["low", "high", "high"] },
  { name: "manual thinking after reselecting Review", config: { ...both, reviewThinkingLevel: "medium" }, reasoningModels: true, switchTo: ["review"], reselectDefault: "medium" as const, manualThinking: true, models: ["review", "session", "fix"], levels: ["medium", "low", "low"] },
  { name: "return to original model with clamped thinking", config: both, switchTo: ["session"], models: ["review", "session", "fix"] },
  { name: "keep explicit thinking across another model switch", config: { ...both, reviewThinkingLevel: "medium" }, reasoningModels: true, audit: true, switchTo: ["session"], manualThinking: true, models: ["review", "session", "fix"] },
  { name: "switch during fix", config: both, switchOnRequest: 3, switchTo: ["alternate"], models: ["review", "session", "fix"] },
  { name: "queued follow-up after manual switch", config: both, switchTo: ["alternate"], followUp: true, models: ["review", "alternate", "session", "fix"] },
  { name: "manual switch during host fallback", config: both, switchTo: ["alternate"], fallback: true, models: ["session", "session", "fix"] },
  { name: "switch while using session model", config: {}, switchTo: ["alternate"], models: ["session", "session", "session"] },
  { name: "switch with matching override", config: { reviewModel: "local/session" }, switchTo: ["alternate"], models: ["session", "session", "session"] },
  { name: "menu", config: { ...review, reviewThinkingLevel: "medium", other: 42 }, bom: true, models: ["session", "session", menuModelId], levels: ["high", "high", "low"] },
  { name: "current session", config: both, models: ["review"] },
  { name: "loop", config: { ...both, reviewThinkingLevel: "low", fixThinkingLevel: "medium" }, reasoningModels: true, models: ["review", "session", "fix", "review", "session"], levels: ["low", "high", "medium", "low", "high"] },
  { name: "clean loop with retired Fix", config: expiredFix, loopMode: "clean", models: ["review", "session"] },
  { name: "blocking loop falls back for retired Fix", config: expiredFix, loopMode: "blocking", models: ["review", "session", "session", "review", "session"] },
  { name: "intercepted", config: both, models: [] },
  { name: "unavailable Review falls back", config: { reviewModel: "local/missing", reviewThinkingLevel: "off" }, models: ["session", "session", "session"], levels: ["high", "high", "high"] },
  { name: "provider error", config: both, models: ["review"] },
  { name: "promote Review after logout", config: both, logout: true, models: ["review", "review", "fix"] },
  { name: "promote Review after logout in another session", config: both, logout: true, externalLogout: true, models: ["review", "review", "fix"] },
  { name: "restore thinking after the original model loses authorization", config: { ...both, reviewThinkingLevel: "low" }, logout: true, externalLogout: true, reasoningModels: true, models: ["review", "review", "fix"], levels: ["low", "high", "high"] },
  { name: "logout without Review override", config: {}, logout: true, models: [] },
  { name: "Review selection fails after logout", config: both, logout: true, models: [] },
  { name: "PR mode cancelled after logout", config: both, logout: true, prExit: "cancel", models: [] },
  { name: "PR checkout failed after logout", config: both, logout: true, prExit: "failure", models: [] },
  { name: "unavailable Fix falls back", config: expiredFix, models: ["review", "session", "session"] },
  { name: "malformed Fix falls back", config: { ...review, fixModel: { invalid: true } }, models: ["review", "session", "session"] },
  { name: "account-filtered Fix falls back", config: both, restrictFix: true, models: ["review", "session", "session"] },
  { name: "new external grant waits for Pi", config: { ...review, fixModel: "spare/backup" }, newGrant: true, models: ["review", "session", "session"] },
  { name: "Fix switch fails", config: { ...both, fixThinkingLevel: "low" }, reasoningModels: true, failFix: true, models: ["review", "session", "session"], levels: ["high", "high", "high"] },
  { name: "Fix disappears during summary", config: both, models: ["review", "session", "session"] },
];

for (const { name, config, models, switchTo, switchOnRequest = 1, followUp, fallback, logout, externalLogout, restrictFix, manualThinking, prExit, loopMode, newGrant, failFix, reasoningModels, audit, levels, reselectDefault, bom, quitDuring, manualReturn } of cases) {
  test(name, { timeout: 15_000 }, async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-review-"));
    const oldDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    t.after(async () => {
      __test__.resetReviewRuntimeState();
      if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldDir;
      await rm(dir, { recursive: true, force: true });
    });
    execFileSync("git", ["init", "-q", dir]);
    const configFile = path.join(dir, "review.json");
    const configText = (bom ? "\uFEFF" : "") + JSON.stringify(config);
    if (Object.keys(config).length) await writeFile(configFile, configText);
    const phaseRequest = Promise.withResolvers<void>();
    const requests: string[] = [];
    const requestLevels: string[] = [];
    const wireEfforts: (string | undefined)[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const part of req) body += part;
      const { model, reasoning_effort } = JSON.parse(body);
      requests.push(model);
      requestLevels.push(session.thinkingLevel);
      wireEfforts.push(reasoning_effort);
      if (model === quitDuring) {
        phaseRequest.resolve();
        return; // Keep the request in flight until the host exits.
      }
      if (name === "Fix disappears during summary" && requests.length === 2) runtime.unregisterProvider("fix-provider");
      if (name === "provider error" && model === "review") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Fixture request failed" } }));
        return;
      }
      const text = requests.length === 1 && loopMode !== "clean"
        ? "## Findings\n- [P1] Fix the bug.\nVerdict: needs attention"
        : "## Findings\n- (none)\nVerdict: correct";
      const chunk = {
        id: "mock", object: "chat.completion.chunk", created: 1, model,
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
      };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const authPath = path.join(dir, "auth.json");
    if (logout) await writeFile(authPath, JSON.stringify({ original: { type: "api_key", key: "test" } }));
    if (restrictFix) await writeFile(authPath, JSON.stringify({ "fix-provider": { type: "api_key", key: "full-access" } }));
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
    const providers: Record<string, string[]> = { local: ["session", "review", "alternate"], "fix-provider": ["fix", menuModelId] };
    if (logout) providers.original = ["session"];
    if (newGrant) providers.spare = ["backup"];
    for (const [provider, ids] of Object.entries(providers)) {
      runtime.registerProvider(provider, {
        api: "openai-completions", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        apiKey: provider === "original" || provider === "spare" || (restrictFix && provider === "fix-provider") ? undefined : "test",
        models: ids.map((id) => ({ id, name: id, input: ["text"], reasoning: id === "session" || id === menuModelId || (!!reasoningModels && ["review", "fix"].includes(id)),
          contextWindow: 100_000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      });
    }
    if (restrictFix) {
      runtime.registerNativeProvider({
        ...runtime.getProvider("fix-provider")!,
        filterModels: (models, credential) => credential?.type === "api_key" && credential.key === "limited-access"
          ? models.filter((model) => model.id === menuModelId)
          : models,
      });
    }
    const globalDefault = switchTo?.[0] === "session" && reselectDefault;
    const settings = globalDefault ? SettingsManager.create(dir, dir) : SettingsManager.inMemory({ retry: { enabled: false } });
    if (reselectDefault) {
      if (globalDefault) {
        settings.setDefaultThinkingLevel(globalDefault);
        await settings.flush();
      } else {
        const [provider, id] = (switchOnRequest === 3 ? fix.fixModel : review.reviewModel).split("/");
        settings.setModelThinkingLevel(provider, id, reselectDefault);
      }
    }
    const ghCommands: string[] = [];
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      extensionFactories: [(pi) => {
        if (audit) pi.on("model_select", () => { pi.appendEntry("model-audit", {}); });
      }, (pi) => {
        if (prExit) {
          const exec = pi.exec.bind(pi);
          t.mock.method(pi, "exec", (cmd: string, args: string[], options?: Parameters<typeof exec>[2]) => {
            if (cmd !== "gh") return exec(cmd, args, options);
            ghCommands.push(args[1]);
            return Promise.resolve({
              code: args[1] === "checkout" && prExit === "failure" ? 1 : 0,
              stdout: JSON.stringify({ baseRefName: "main", headRefName: "feature", title: "Fixture" }),
              stderr: "", killed: false,
            });
          });
        }
        reviewExtension(pi);
      }, (pi) => {
        if (switchTo) {
          pi.on("message_end", async ({ message }) => {
            if (message.role !== "assistant" || requests.length !== switchOnRequest) return;
            for (const id of switchTo) assert.ok(await pi.setModel(runtime.getModel(id === "fix" ? "fix-provider" : "local", id)!));
            if (reselectDefault) assert.equal(pi.getThinkingLevel(), reselectDefault);
            if (manualThinking) {
              pi.setThinkingLevel("low");
              assert.ok(await pi.setModel(runtime.getModel("local", "alternate")!));
            }
            if (followUp) pi.sendUserMessage("Queued question", { deliverAs: "followUp" });
          });
        }
        pi.on("input", (event) => {
          if (event.source !== "extension") return;
          if (name === "intercepted") return { action: "handled" };
          return { action: "transform", text: "Review workflow\n" + event.text };
        });
      }],
    });
    await loader.reload();
    const storage = quitDuring ? SessionManager.create(dir, dir) : SessionManager.inMemory(dir);
    storage.appendMessage({ role: "user", content: "Original conversation", timestamp: Date.now() });
    if (name === "loop" || loopMode) storage.appendCustomEntry("review-settings", { loopFixingEnabled: true });
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel(logout ? "original" : "local", "session"),
      scopedModels: name === "menu" ? runtime.getModels("fix-provider").map(model => ({ model })) : undefined,
      thinkingLevel: "high", settingsManager: settings, resourceLoader: loader, sessionManager: storage });
    t.after(() => session.dispose());
    const errors: string[] = [];
    const warnings: string[] = [];
    initTheme("dark");
    const ui = session.extensionRunner.getUIContext();
    const pickerKeys = [menuFix.fixModel, menuFix.fixModel, "Use session model"];
    let menuVisits = 0;
    await session.bindExtensions({
      mode: "tui", onError: (e) => errors.push(e.error),
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(), navigateTree: (id, opts) => session.navigateTree(id, opts),
        newSession: () => assert.fail(), switchSession: () => assert.fail(), fork: () => assert.fail(), reload: () => assert.fail(),
      },
      uiContext: {
        ...ui,
        notify: (msg, type) => {
          if (type === "error") errors.push(msg);
          if (type === "warning") warnings.push(msg);
        },
        setWidget() {}, setEditorText() {}, getEditorText: () => "",
        select: async (title, choices) => {
          if (prExit && title === "Start review in:") return undefined;
          if (title === "Model settings") {
            if (menuVisits === 2) assert.equal(await readFile(configFile, "utf8"), configText);
            return choices[pickerKeys.length > 1 ? 1 : 0];
          }
          if (title === "Fix thinking level") {
            assert.deepEqual(choices, ["off", "minimal", "low", "medium", "high"]);
            return menuVisits === 1 ? undefined : "low";
          }
          if (title === "Review thinking level") assert.fail("Use session model should clear both settings immediately");
          if (title === "Start review in:") return name === "current session" || quitDuring === "switch" ? "Current session" : "Empty branch";
          return "Return and fix findings";
        },
        custom: async <T>(factory: Parameters<typeof ui.custom<T>>[0], options?: Parameters<typeof ui.custom<T>>[1]) => {
          const dialog = (options as { blocked?: { message: string } } | undefined)?.blocked?.message;
          if (dialog === "Select a review preset") {
            if (prExit) return null as T;
            const component = await factory(
              { requestRender() {} } as TUI, ui.theme, getKeybindings() as KeybindingsManager, () => {},
            );
            try {
              const rows = component.render(150);
              const modelIndex = rows.findIndex(row => row.includes("Model settings"));
              const loopIndex = rows.findIndex(row => row.includes("Loop Fixing"));
              assert.ok(modelIndex >= 0);
              assert.equal(loopIndex, modelIndex + 1);
            } finally {
              component.dispose?.();
            }
            return (menuVisits++ < 3 ? "modelSettings" : null) as T;
          }
          const result = Promise.withResolvers<T>();
          const component = await factory(
            { requestRender() {} } as TUI, ui.theme, getKeybindings() as KeybindingsManager, result.resolve,
          );
          if (dialog?.endsWith(" model")) {
            const rows = component.render(150).join("\n");
            assert.ok(rows.includes(menuFix.fixModel));
            assert.ok(!rows.includes("local/alternate"));
            const pick = pickerKeys.shift();
            assert.ok(pick, "Unexpected model picker");
            for (const key of pick + "\r") component.handleInput?.(key);
          }
          return result.promise.finally(() => component.dispose?.());
        },
      },
    });
    if (fallback) {
      t.mock.method(session, "setModel", async () => { throw new Error("Fixture startup switch failed"); }, { times: 1 });
    }
    const expectedSessionModel = logout ? "review" : "session";
    async function run(command: string) {
      const settled = new Promise<void>((resolve) => {
        const off = session.subscribe((e) => {
          if (e.type !== "agent_settled") return;
          off();
          resolve();
        });
      });
      await session.prompt(command);
      await settled;
      if (name !== "provider error") {
        const reply = storage.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
        if (reply?.type === "message" && reply.message.role === "assistant") {
          assert.notEqual(reply.message.stopReason, "error", reply.message.errorMessage ?? "Fixture request failed");
        }
      }
      assert.equal(session.model?.id, expectedSessionModel);
      assert.equal(session.thinkingLevel, logout && !reasoningModels ? "off" : manualThinking ? "low" : "high");
    }
    if (quitDuring) {
      await session.prompt("Previous conversation"); // Flush the transcript on Pi 0.86.
      if (quitDuring === "fix") await run("/review uncommitted");
      const releaseSwitch = Promise.withResolvers<void>();
      const setModel = session.setModel.bind(session);
      let restores = 0;
      t.mock.method(session, "setModel", async (...args: Parameters<typeof setModel>) => {
        if (quitDuring === "switch" && args[0].id === "review") {
          phaseRequest.resolve();
          await releaseSwitch.promise;
        }
        if (args[0].id === "session") restores++;
        await setModel(...args);
      });
      await session.prompt(quitDuring === "fix" ? "/end-review" : "/review uncommitted");
      await phaseRequest.promise;
      if (quitDuring !== "switch") assert.equal(session.thinkingLevel, "low");
      if (manualReturn) {
        await session.setModel(runtime.getModel("local", "session")!);
        session.setThinkingLevel("medium");
      }
      const services = { cwd: dir, agentDir: dir, modelRuntime: runtime, settingsManager: settings, resourceLoader: loader, diagnostics: [] };
      const host = new AgentSessionRuntime(session, services, async () => assert.fail("Unexpected session replacement"));
      const closing = host.dispose();
      releaseSwitch.resolve();
      await closing;
      if (!manualReturn) assert.equal(restores, 1);

      const reopened = SessionManager.open(storage.getSessionFile()!);
      const saved = reopened.buildSessionContext();
      assert.deepEqual(saved.model, { provider: "local", modelId: "session" });
      const expectedLevel = manualReturn ? "medium" : "high";
      assert.equal(saved.thinkingLevel, expectedLevel);
      const { session: resumed } = await createAgentSession({ ...services, sessionManager: reopened });
      t.after(() => resumed.dispose());
      assert.equal(resumed.model?.id, "session");
      assert.equal(resumed.thinkingLevel, expectedLevel);
      await resumed.prompt("A regular message");
      if (quitDuring === "switch") assert.ok(requests.every(model => model === "session"));
      else assert.deepEqual(requests, models);
      assert.equal(wireEfforts.at(-1), expectedLevel);
      return;
    }
    if (logout) {
      const source = externalLogout ? await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false }) : runtime;
      await source.logout("original");
      assert.equal(await runtime.checkAuth("original"), undefined);
      if (externalLogout) assert.equal(runtime.hasConfiguredAuth("original"), true);
      if (prExit) {
        const leaf = storage.getLeafId();
        await session.prompt("/review pr 1");
        assert.deepEqual(ghCommands, ["view", "checkout"]);
        assert.equal(session.model?.provider, "original");
        assert.equal(storage.getLeafId(), leaf);
        assert.deepEqual(requests, []);
        return;
      }
      if (!models.length) {
        if (name === "Review selection fails after logout") t.mock.method(runtime, "checkAuth", async () => undefined);
        const leaf = storage.getLeafId();
        await session.prompt("/review uncommitted");
        assert.match(errors.join(" "), "reviewModel" in config ? /local\/review/ : /authorized session or Review model/);
        assert.equal(session.model?.provider, "original");
        assert.equal(storage.getLeafId(), leaf);
        assert.equal(__test__.getReviewRuntimeState().reviewOriginId, undefined);
        assert.deepEqual(requests, []);
        return;
      }
    }
    if (name === "menu") {
      await session.prompt("/review");
      assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), { ...menuFix, fixThinkingLevel: "low", other: 42 });
    }
    if (name === "intercepted") {
      await session.prompt("/review uncommitted");
    } else {
      if (loopMode || name === "loop") {
        // Loop commands await their own review, summary and fix requests.
        await session.prompt("/review uncommitted");
        assert.equal(session.model?.id, expectedSessionModel);
        assert.equal(session.thinkingLevel, "high");
      } else {
        await run("/review uncommitted");
      }
      if (newGrant) {
        await writeFile(authPath, JSON.stringify({ spare: { type: "api_key", key: "new-access" } }));
        assert.ok(!runtime.hasConfiguredAuth("spare"));
      }
      if (restrictFix) {
        await writeFile(authPath, JSON.stringify({ "fix-provider": { type: "api_key", key: "limited-access" } }));
        // The extension consumes Pi's published list when the host updates it.
        await runtime.refresh({ providers: ["fix-provider"], allowNetwork: false });
        assert.ok(!runtime.getAvailableSnapshot().some(m => m.provider === "fix-provider" && m.id === "fix"));
      }
      if (failFix) t.mock.method(session, "setModel", async () => { throw new Error("Fixture Fix unavailable"); }, { times: 1 });
      if (!loopMode && !["loop", "current session", "provider error"].includes(name)) await run("/end-review");
      if (newGrant) assert.ok(!runtime.hasConfiguredAuth("spare"), "The extension must leave authorization refresh to Pi");
    }
    assert.deepEqual(requests, models);
    if (levels) assert.deepEqual(requestLevels, levels);
    if (name === "independent model and thinking pairs") {
      assert.equal(wireEfforts[0], "medium");
      assert.equal(wireEfforts[2], "low");
    }
    if (name !== "menu" && Object.keys(config).length) {
      assert.equal(await readFile(configFile, "utf8"), configText);
    }
    if (name.includes("falls back") || newGrant) assert.match(warnings.join(" "), /Using the session model/);
    if (name === "clean loop with retired Fix") assert.deepEqual(warnings, []);
    if (fallback || failFix) assert.match(warnings.join(" "), /Fixture (startup switch failed|Fix unavailable)/);
    if (name === "Fix disappears during summary") assert.match(warnings.join(" "), /Using local\/session/);
    assert.deepEqual(errors, []);
    await run("A regular message");
    assert.equal(requests.at(-1), expectedSessionModel);
  });
}

test("a BOM does not hide invalid settings JSON", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-review-bom-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "review.json");
  const invalid = '\uFEFF{"reviewModel":';
  await writeFile(file, invalid);
  await assert.rejects(__test__.saveModelSetting(file, "fixModel", {}, fix.fixModel, "low"), /Could not read/);
  assert.equal(await readFile(file, "utf8"), invalid);
});

for (const state of ["active", "stale", "stale with legacy temp"]) {
  test(`settings lock: ${state}`, async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-review-lock-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "review.json");
    const lock = file + ".lock";
    await writeFile(file, JSON.stringify(review));
    await mkdir(lock);
    if (state === "stale with legacy temp") await writeFile(path.join(lock, "review.json"), "{partial");
    if (state !== "active") await utimes(lock, new Date(0), new Date(0));

    const save = __test__.saveModelSetting(file, "fixModel", {}, fix.fixModel, undefined);
    if (state === "active") {
      await assert.rejects(save, { code: "ELOCKED" });
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), review);
    } else {
      await save;
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), both);
    }
  });
}
