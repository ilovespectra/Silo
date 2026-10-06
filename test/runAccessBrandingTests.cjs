const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  }).outputText, filename);
};
const { hasFullAccess } = require("../src/demoLimits.ts");

const sourceText = fs.readFileSync(path.join(__dirname, "../src/main.ts"), "utf8");
const ast = ts.createSourceFile("main.ts", sourceText, ts.ScriptTarget.Latest, true);
const functions = new Map();
(function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  ts.forEachChild(node, visit);
})(ast);

function createHarness({ licensed = false, demoTesting = false } = {}) {
  const events = [];
  const window = { title: "", destroyed: false, setTitle(title) { this.title = title; }, isDestroyed() { return this.destroyed; } };
  const context = vm.createContext({
    hasFullAccess,
    lifetimeLicensed: licensed,
    demoTestingModeEnabled: demoTesting,
    applicationMenuInstalled: false,
    sourceListCache: [{ id: "cached" }],
    sourceListCacheAt: 123,
    sourceListPromise: Promise.resolve([]),
    semanticIndexer: null,
    mainWindow: window,
    app: { name: "Silo", setName(name) { this.name = name; } },
    menuBuilds: 0,
    sendToRenderer: (channel, payload) => events.push(JSON.parse(JSON.stringify({ channel, payload }))),
  });
  vm.runInContext("function installApplicationMenu() { applicationMenuInstalled = true; menuBuilds += 1; }", context);
  for (const name of ["fullAccessEnabled", "accessDisplayName", "applyAccessBranding", "enableLifetimeFeatures"]) {
    assert(functions.has(name), `main.ts is missing ${name}`);
    const code = ts.transpileModule(functions.get(name).getText(ast), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText;
    vm.runInContext(code, context);
  }
  return { context, window, events };
}

{
  const { context, window, events } = createHarness();
  assert.equal(context.accessDisplayName(), "Silo Demo", "an unlicensed install is branded as the demo");
  context.installApplicationMenu();
  context.applyAccessBranding();
  assert.equal(context.app.name, "Silo Demo");
  assert.equal(window.title, "Silo Demo");
  assert.deepEqual(events.at(-1), { channel: "lifetime-access-changed", payload: { fullAccess: false, name: "Silo Demo" } });

  const menuBuildsBefore = context.menuBuilds;
  context.enableLifetimeFeatures();
  assert.equal(context.lifetimeLicensed, true);
  assert.equal(context.app.name, "Silo", "purchase renames the app");
  assert.equal(window.title, "Silo", "purchase retitles the open window");
  assert.equal(context.menuBuilds, menuBuildsBefore + 1, "app menu labels (About/Hide/Quit) are rebuilt with the new name");
  assert.equal(context.sourceListCache, null, "demo-limited source list is dropped");
  assert.equal(context.sourceListPromise, null, "an in-flight demo-limited source listing is discarded");
  assert.deepEqual(events.at(-1), { channel: "lifetime-access-changed", payload: { fullAccess: true, name: "Silo" } },
    "renderer is told to leave demo mode without a restart");
}

{
  const { context } = createHarness({ licensed: true, demoTesting: true });
  assert.equal(context.accessDisplayName(), "Silo Demo", "licensed owners previewing demo mode see demo branding");
}

{
  const { context, window, events } = createHarness({ licensed: true });
  window.destroyed = true;
  context.applyAccessBranding();
  assert.equal(window.title, "", "a destroyed window is left alone");
  assert.equal(context.menuBuilds, 0, "the menu is not built before startup installs it");
  assert.equal(events.at(-1).payload.name, "Silo");
}

console.log("Access branding tests passed: Silo Demo naming, clean exit to Silo on purchase, menu/title/renderer refresh.");
