package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func makeZip(t *testing.T, files map[string]string) *zip.Reader {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, body := range files {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	return zr
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

const pkg = `{"name": "ai-story-studio", "version": "1.1.0"}`

func TestFreshInstallWritesFilesAndManifest(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "AI Story Studio")
	zr := makeZip(t, map[string]string{
		"package.json":                         pkg,
		"src/web/server.ts":                    "server",
		"installer/windows/Start.bat":          "@echo off\r\nrem crlf kept\r\n",
		".env.example":                         "MOCK_GENERATION=true\n",
		"docs/README.md":                       "docs",
		"installer/windows/setup/payload/x.md": "x",
	})
	res, err := installPayload(zr, dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.Written != 6 || res.Removed != 0 {
		t.Fatalf("unexpected result %+v", res)
	}
	if got := readFile(t, filepath.Join(dir, "installer", "windows", "Start.bat")); got != "@echo off\r\nrem crlf kept\r\n" {
		t.Fatalf("line endings changed: %q", got)
	}
	if !strings.Contains(readFile(t, filepath.Join(dir, manifestName)), "src/web/server.ts\n") {
		t.Fatal("manifest missing entry")
	}
	if kind, _ := inspectTarget(dir); kind != targetExisting {
		t.Fatalf("installed folder not recognised, kind=%d", kind)
	}
}

func TestUpgradeRemovesOnlyStaleShippedFilesAndKeepsUserData(t *testing.T) {
	dir := t.TempDir()
	v1 := makeZip(t, map[string]string{"package.json": pkg, "src/old/gone.ts": "old", "src/keep.ts": "v1"})
	if _, err := installPayload(v1, dir); err != nil {
		t.Fatal(err)
	}
	// Things created on the PC after installing.
	for name, body := range map[string]string{
		".env":                            "MOCK_GENERATION=false\n",
		"data/secrets.json":               `{"runpod":"rpa_x"}`,
		"data/studio.db":                  "db",
		"node_modules/x/index.js":         "x",
		"dist/src/web/server.js":          "built",
		"worker/.venv/Scripts/python.exe": "py",
		"src/my-notes.txt":                "user file, not from setup",
	} {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	v2 := makeZip(t, map[string]string{
		"package.json": pkg,
		"src/keep.ts":  "v2",
		"src/new.ts":   "new",
		// A malicious or broken package must not overwrite user data either.
		".env":              "MOCK_GENERATION=true\n",
		"data/secrets.json": "{}",
	})
	res, err := installPayload(v2, dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.Removed != 1 || res.Skipped != 2 {
		t.Fatalf("unexpected result %+v", res)
	}
	if exists(filepath.Join(dir, "src", "old", "gone.ts")) || exists(filepath.Join(dir, "src", "old")) {
		t.Fatal("stale file or its empty folder was kept")
	}
	if readFile(t, filepath.Join(dir, "src", "keep.ts")) != "v2" || !exists(filepath.Join(dir, "src", "new.ts")) {
		t.Fatal("upgrade did not write new files")
	}
	checks := map[string]string{
		".env":              "MOCK_GENERATION=false\n",
		"data/secrets.json": `{"runpod":"rpa_x"}`,
		"src/my-notes.txt":  "user file, not from setup",
	}
	for name, want := range checks {
		if got := readFile(t, filepath.Join(dir, filepath.FromSlash(name))); got != want {
			t.Fatalf("%s changed: %q", name, got)
		}
	}
	for _, name := range []string{"data/studio.db", "node_modules/x/index.js", "dist/src/web/server.js", "worker/.venv/Scripts/python.exe"} {
		if !exists(filepath.Join(dir, filepath.FromSlash(name))) {
			t.Fatalf("%s was removed", name)
		}
	}
}

func TestUpgradeOfHandUnzippedInstallWithoutManifest(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(pkg), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "extra.txt"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	if kind, _ := inspectTarget(dir); kind != targetExisting {
		t.Fatalf("hand-unzipped install not recognised, kind=%d", kind)
	}
	if _, err := installPayload(makeZip(t, map[string]string{"package.json": pkg, "a.txt": "a"}), dir); err != nil {
		t.Fatal(err)
	}
	if readFile(t, filepath.Join(dir, "extra.txt")) != "keep" {
		t.Fatal("unknown file removed without a manifest")
	}
}

func TestInspectTargetRefusesUnrelatedFolders(t *testing.T) {
	root := t.TempDir()
	if kind, _ := inspectTarget(filepath.Join(root, "missing")); kind != targetNew {
		t.Fatal("missing folder should be new")
	}
	if kind, _ := inspectTarget(root); kind != targetNew {
		t.Fatal("empty folder should be new")
	}
	other := filepath.Join(root, "other")
	if err := os.MkdirAll(other, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(other, "package.json"), []byte(`{"name":"rahulbot"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if kind, _ := inspectTarget(other); kind != targetForeign {
		t.Fatal("another project must never be used")
	}
	file := filepath.Join(root, "file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if kind, _ := inspectTarget(file); kind != targetForeign {
		t.Fatal("a file is not a folder")
	}
}

func TestUnsafePayloadPathsAreRejected(t *testing.T) {
	for _, name := range []string{"../evil.txt", "a/../../evil.txt", "/etc/evil", "C:/evil.txt", `..\evil.txt`} {
		dir := t.TempDir()
		_, err := installPayload(makeZip(t, map[string]string{"package.json": pkg, name: "x"}), dir)
		if err == nil || !strings.Contains(err.Error(), "unsafe path") {
			t.Fatalf("%q was not rejected: %v", name, err)
		}
		if exists(filepath.Join(filepath.Dir(dir), "evil.txt")) {
			t.Fatalf("%q escaped the folder", name)
		}
	}
}

func TestDamagedManifestLinesAreNeverFollowed(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "app")
	victim := filepath.Join(root, "victim.txt")
	if err := os.WriteFile(victim, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, manifestName), []byte("../victim.txt\n"+victim+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := installPayload(makeZip(t, map[string]string{"package.json": pkg}), dir); err != nil {
		t.Fatal(err)
	}
	if !exists(victim) {
		t.Fatal("a manifest line outside the folder was deleted")
	}
}

func TestChooseDirNonInteractiveRefusesForeignFolder(t *testing.T) {
	other := t.TempDir()
	if err := os.WriteFile(filepath.Join(other, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	u := &ui{in: bufio.NewReader(strings.NewReader("")), out: &out}
	if _, _, err := chooseDir(options{dir: other, yes: true}, u); err == nil {
		t.Fatal("foreign folder accepted")
	}
	if !strings.Contains(out.String(), "not AI Story Studio") {
		t.Fatalf("no explanation: %s", out.String())
	}
}

func TestChooseDirInteractiveAsksAgain(t *testing.T) {
	other := t.TempDir()
	if err := os.WriteFile(filepath.Join(other, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	good := filepath.Join(t.TempDir(), "Studio")
	var out bytes.Buffer
	u := &ui{in: bufio.NewReader(strings.NewReader(other + "\n\"" + good + "\"\n")), out: &out, interactive: true}
	dir, kind, err := chooseDir(options{}, u)
	if err != nil || dir != good || kind != targetNew {
		t.Fatalf("got %q %d %v", dir, kind, err)
	}
}

func TestRunExtractOnlyWithoutPayloadFailsClearly(t *testing.T) {
	if _, err := payloadFS.ReadFile("payload/app.zip"); err == nil {
		t.Skip("built with a payload")
	}
	var out bytes.Buffer
	u := &ui{in: bufio.NewReader(strings.NewReader("")), out: &out}
	if code := run(options{dir: t.TempDir(), yes: true, extractOnly: true}, u); code != 1 {
		t.Fatalf("exit code %d", code)
	}
	if !strings.Contains(out.String(), "built without the app package") {
		t.Fatal(out.String())
	}
}
