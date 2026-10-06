// Throwaway probe: verifies the OAuth client and prints granted scopes.
// Run with: node scripts/verify-google.js
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(__dirname, "..", ".env"), "utf8")
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
];

const verifier = crypto.randomBytes(48).toString("base64url");
const challenge = crypto
  .createHash("sha256")
  .update(verifier)
  .digest("base64url");
const redirect = new URL(env.GOOGLE_REDIRECT_URI);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${redirect.port}`);
  if (url.pathname !== redirect.pathname) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<p>Done. Return to the terminal.</p>");
  server.close();

  const code = url.searchParams.get("code");
  if (!code) {
    console.log("FAILED:", url.searchParams.get("error"));
    return;
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: env.GOOGLE_REDIRECT_URI,
    }),
  });
  const token = await tokenRes.json();
  if (!tokenRes.ok) {
    console.log("TOKEN EXCHANGE FAILED:", JSON.stringify(token, null, 2));
    return;
  }

  console.log("\nGRANTED SCOPES:\n  " + token.scope.split(" ").join("\n  "));
  console.log("REFRESH TOKEN:", token.refresh_token ? "yes" : "NO");

  const driveRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?pageSize=3&fields=files(name,mimeType)",
    { headers: { Authorization: `Bearer ${token.access_token}` } },
  );
  console.log("\nDRIVE LIST:", driveRes.status, await driveRes.text());

  const pickerRes = await fetch(
    "https://photospicker.googleapis.com/v1/sessions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  console.log(
    "\nPHOTOS PICKER SESSION:",
    pickerRes.status,
    await pickerRes.text(),
  );

  const libraryRes = await fetch(
    "https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=3",
    { headers: { Authorization: `Bearer ${token.access_token}` } },
  );
  console.log(
    "\nLEGACY LIBRARY LIST:",
    libraryRes.status,
    await libraryRes.text(),
  );
});

server.listen(Number(redirect.port), "127.0.0.1", () => {
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", env.GOOGLE_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  console.log("Opening browser for consent...\n");
  exec(`open "${authUrl.toString()}"`);
});
