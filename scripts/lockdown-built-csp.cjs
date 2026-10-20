const fs = require("node:fs");
const path = require("node:path");

const htmlPath = path.join(__dirname, "..", "build", "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const marker = "http-equiv=\"Content-Security-Policy\"";
if (!html.includes(marker)) {
  throw new Error("The built app is missing its Content Security Policy.");
}
const locked = html.replaceAll(" 'unsafe-eval'", "");
if (locked === html) {
  throw new Error("The production Content Security Policy was not tightened.");
}
fs.writeFileSync(htmlPath, locked);
