const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

// --- absolutePath ----------------------------------------------------------
// The Files API relativizes `fullName` to the downloads root
// (FileService.cs:341), so the root has to be prepended.

test("absolutePath joins the downloads root with the relative fullName", () => {
  assert.equal(
    plugin._absolutePath("/home/me/downloads", "viboplr/b1/Track.mp3"),
    "/home/me/downloads/viboplr/b1/Track.mp3"
  );
});

test("absolutePath tolerates a trailing slash and a leading slash", () => {
  assert.equal(plugin._absolutePath("/dl/", "/viboplr/x.mp3"), "/dl/viboplr/x.mp3");
});

test("absolutePath uses backslashes for a Windows root", () => {
  assert.equal(
    plugin._absolutePath("C:\\Users\\me\\Downloads", "viboplr/b1/Track.mp3"),
    "C:\\Users\\me\\Downloads\\viboplr\\b1\\Track.mp3"
  );
});

test("absolutePath returns null on missing input", () => {
  assert.equal(plugin._absolutePath(null, "x"), null);
  assert.equal(plugin._absolutePath("/dl", null), null);
});

// --- file:// URLs ----------------------------------------------------------
// parseUrlScheme does a raw url.substring(7) with NO decoding, while
// download_file percent-DEcodes. The two paths need different encoding.

test("playback URLs are NOT encoded — spaces must survive verbatim", () => {
  assert.equal(
    plugin._fileUrlForPlayback("/dl/My Album/01 Track.mp3"),
    "file:///dl/My Album/01 Track.mp3"
  );
});

test("download URLs escape a literal % so the host's decode round-trips", () => {
  assert.equal(
    plugin._fileUrlForDownload("/dl/100% Real/x.mp3"),
    "file:///dl/100%25 Real/x.mp3"
  );
});

test("download URLs leave a %-free path untouched", () => {
  assert.equal(plugin._fileUrlForDownload("/dl/a b.mp3"), "file:///dl/a b.mp3");
});

test("file URL helpers are null-safe", () => {
  assert.equal(plugin._fileUrlForPlayback(null), null);
  assert.equal(plugin._fileUrlForDownload(null), null);
});

// --- matchFile -------------------------------------------------------------

test("matchFile prefers a unique size match", () => {
  const t = { filename: "peer\\Music\\Track.mp3", size: 1234 };
  const files = [
    { name: "Other.mp3", fullName: "viboplr/b1/Other.mp3", length: 999 },
    { name: "Renamed (1).mp3", fullName: "viboplr/b1/Renamed (1).mp3", length: 1234 }
  ];
  assert.equal(plugin._matchFile(t, files).name, "Renamed (1).mp3");
});

test("matchFile disambiguates equal sizes by basename", () => {
  const t = { filename: "peer\\Music\\Track.mp3", size: 1234 };
  const files = [
    { name: "Decoy.mp3", fullName: "viboplr/b1/Decoy.mp3", length: 1234 },
    { name: "Track.mp3", fullName: "viboplr/b1/Track.mp3", length: 1234 }
  ];
  assert.equal(plugin._matchFile(t, files).name, "Track.mp3");
});

test("matchFile falls back to basename when no size matches", () => {
  const t = { filename: "peer\\Music\\Track.mp3", size: 1234 };
  const files = [{ name: "Track.mp3", fullName: "viboplr/b1/Track.mp3", length: 4321 }];
  assert.equal(plugin._matchFile(t, files).name, "Track.mp3");
});

test("matchFile returns null when ambiguous rather than guessing", () => {
  const t = { filename: "peer\\Music\\Track.mp3", size: 1234 };
  const files = [
    { name: "A.mp3", fullName: "viboplr/b1/A.mp3", length: 1234 },
    { name: "B.mp3", fullName: "viboplr/b1/B.mp3", length: 1234 }
  ];
  assert.equal(plugin._matchFile(t, files), null);
});

test("matchFile handles an empty listing", () => {
  assert.equal(plugin._matchFile({ filename: "a\\b.mp3", size: 1 }, []), null);
  assert.equal(plugin._matchFile({ filename: "a\\b.mp3", size: 1 }, null), null);
});

// --- flattenListing --------------------------------------------------------

test("flattenListing walks nested directories", () => {
  const tree = {
    files: [{ name: "root.mp3", fullName: "root.mp3" }],
    directories: [
      { files: [{ name: "a.mp3", fullName: "d/a.mp3" }], directories: [
        { files: [{ name: "b.mp3", fullName: "d/e/b.mp3" }] }
      ] }
    ]
  };
  const out = plugin._flattenListing(tree);
  assert.deepEqual(out.map((f) => f.name).sort(), ["a.mp3", "b.mp3", "root.mp3"]);
});

test("flattenListing tolerates empty nodes", () => {
  assert.deepEqual(plugin._flattenListing(null), []);
  assert.deepEqual(plugin._flattenListing({}), []);
});

test("flattenListing handles slskd's actual FLAT recursive shape", () => {
  // Verbatim from GET /api/v0/files/downloads/directories?recursive=true on
  // slskd 0.26.0: every file sits at the root with a full relative fullName, and
  // nested directories are listed as flat siblings carrying no files of their own.
  const real = {
    name: "dl",
    fullName: "",
    files: [{
      name: "03 - Radiohead - Karma Police.mp3",
      fullName: "viboplr/1-OK_Computer/03 - Radiohead - Karma Police.mp3",
      length: 28
    }],
    directories: [
      { name: "viboplr", fullName: "viboplr" },
      { name: "1-OK_Computer", fullName: "viboplr/1-OK_Computer" }
    ]
  };
  const out = plugin._flattenListing(real);
  assert.equal(out.length, 1, "flat shape must not double-count or drop files");
  assert.equal(out[0].fullName, "viboplr/1-OK_Computer/03 - Radiohead - Karma Police.mp3");
});

test("matchFile compares against BYTES — Files API length is size, not duration", () => {
  // Beware: `length` means bytes here but duration-in-seconds in the search API.
  const flat = [{
    name: "03 - Radiohead - Karma Police.mp3",
    fullName: "viboplr/1-OK_Computer/03 - Radiohead - Karma Police.mp3",
    length: 28
  }];
  const transfer = { filename: "peer\\Music\\OK Computer\\03 - Radiohead - Karma Police.mp3", size: 28 };
  const hit = plugin._matchFile(transfer, flat);
  assert.ok(hit, "a byte-size match must resolve");
  assert.equal(
    plugin._absolutePath("/downloads", hit.fullName),
    "/downloads/viboplr/1-OK_Computer/03 - Radiohead - Karma Police.mp3"
  );
});

// --- base64 / destinations -------------------------------------------------
// slskd decodes the {base64SubdirectoryName} route with Convert.FromBase64String,
// so it must be standard base64 — and a '/' in the output would break the route.

test("b64encode matches standard base64", () => {
  assert.equal(plugin._b64encode("viboplr/b1"), "dmlib3Bsci9iMQ==");
  assert.equal(plugin._b64encode("a"), "YQ==");
  assert.equal(plugin._b64encode("ab"), "YWI=");
  assert.equal(plugin._b64encode("abc"), "YWJj");
  assert.equal(plugin._b64encode(""), "");
});

test("b64encode handles multi-byte UTF-8 and astral characters", () => {
  assert.equal(plugin._b64encode("Björk"), Buffer.from("Björk", "utf8").toString("base64"));
  assert.equal(plugin._b64encode("Jóga — 日本"), Buffer.from("Jóga — 日本", "utf8").toString("base64"));
  assert.equal(plugin._b64encode("🎵"), Buffer.from("🎵", "utf8").toString("base64"));
});

test("safeDestination always yields a route-safe base64, or reports it can't", () => {
  for (let seq = 1; seq < 200; seq++) {
    const d = plugin._safeDestination(seq, "Album Name");
    assert.ok(d.destination.indexOf("viboplr/") === 0, "destination must stay under our root");
    if (d.b64 !== null) {
      assert.ok(d.b64.indexOf("/") < 0, "a returned base64 must not contain '/'");
      assert.equal(
        Buffer.from(d.b64, "base64").toString("utf8"),
        d.destination,
        "the base64 must decode back to the destination"
      );
    }
  }
});

test("safeDestination produces a relative, non-traversing path", () => {
  const d = plugin._safeDestination(7, "../../etc/passwd");
  assert.ok(d.destination.indexOf("..") < 0, "must not contain traversal segments");
  assert.ok(d.destination.charAt(0) !== "/", "must be relative");
});

test("sanitizeSegment strips separators and never returns empty", () => {
  assert.equal(plugin._sanitizeSegment("a/b\\c"), "a_b_c");
  assert.equal(plugin._sanitizeSegment("   "), "x");
  assert.equal(plugin._sanitizeSegment(null), "x");
  assert.ok(plugin._sanitizeSegment("x".repeat(200)).length <= 48);
});
