package main

import (
	"archive/zip"
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// manifestName lists every file this setup program installed, so an upgrade can remove files
// that a newer version no longer ships - and never touches anything else in the folder.
const manifestName = ".ais-install-manifest.txt"

type targetKind int

const (
	targetNew      targetKind = iota // missing or empty folder
	targetExisting                   // an earlier AI Story Studio installation (upgrade)
	targetForeign                    // something else: never written to
)

// inspectTarget decides whether dir may be used as the installation folder.
func inspectTarget(dir string) (targetKind, error) {
	info, err := os.Stat(dir)
	if errors.Is(err, os.ErrNotExist) {
		return targetNew, nil
	}
	if err != nil {
		return targetForeign, err
	}
	if !info.IsDir() {
		return targetForeign, nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return targetForeign, err
	}
	if len(entries) == 0 {
		return targetNew, nil
	}
	if _, err := os.Stat(filepath.Join(dir, manifestName)); err == nil {
		return targetExisting, nil
	}
	// An installation unzipped by hand (no manifest yet) is recognised by its package.json.
	raw, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err == nil {
		var pkg struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(raw, &pkg) == nil && pkg.Name == "ai-story-studio" {
			return targetExisting, nil
		}
	}
	return targetForeign, nil
}

// protected reports paths that belong to the user or are generated on the PC. The setup program
// never writes or deletes them: .env (settings), data/ (database, API key, projects), the
// installed dependencies and the build output.
func protected(name string) bool {
	if name == ".env" || (strings.HasPrefix(name, ".env.") && name != ".env.example") {
		return true
	}
	for _, prefix := range []string{"data/", "node_modules/", "dist/", "worker/.venv/", "worker/worker-data/"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return name == manifestName
}

// cleanEntry validates a payload path: relative, no "..", no drive letters or absolute paths.
func cleanEntry(name string) (string, error) {
	clean := path.Clean(strings.ReplaceAll(name, "\\", "/"))
	if clean == "." || !filepath.IsLocal(filepath.FromSlash(clean)) || strings.Contains(clean, ":") {
		return "", fmt.Errorf("unsafe path in the app package: %q", name)
	}
	return clean, nil
}

type installResult struct {
	Written int
	Removed int
	Skipped int
}

// installPayload copies the app package into dir. On an upgrade it first deletes files that the
// previous setup installed but this version no longer ships. User data is never touched.
func installPayload(zr *zip.Reader, dir string) (installResult, error) {
	var res installResult
	type entry struct {
		name string
		file *zip.File
	}
	var files []entry
	shipped := map[string]bool{}
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		if f.Mode()&os.ModeSymlink != 0 {
			return res, fmt.Errorf("unexpected link in the app package: %q", f.Name)
		}
		name, err := cleanEntry(f.Name)
		if err != nil {
			return res, err
		}
		if protected(name) {
			res.Skipped++
			continue
		}
		files = append(files, entry{name, f})
		shipped[name] = true
	}
	if len(files) == 0 {
		return res, errors.New("the app package is empty")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return res, err
	}

	old, err := readManifest(dir)
	if err != nil {
		return res, err
	}
	for _, name := range old {
		if shipped[name] || protected(name) {
			continue
		}
		clean, err := cleanEntry(name)
		if err != nil || clean != name {
			continue // a damaged manifest line is ignored, never followed
		}
		target := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.Remove(target); err == nil {
			res.Removed++
			removeEmptyParents(dir, filepath.Dir(target))
		} else if !errors.Is(err, os.ErrNotExist) {
			return res, fmt.Errorf("could not remove the outdated file %s: %w", target, err)
		}
	}

	for _, e := range files {
		if err := writeEntry(e.file, filepath.Join(dir, filepath.FromSlash(e.name))); err != nil {
			return res, err
		}
		res.Written++
	}

	names := make([]string, 0, len(files))
	for _, e := range files {
		names = append(names, e.name)
	}
	sort.Strings(names)
	return res, writeFileAtomic(filepath.Join(dir, manifestName), []byte(strings.Join(names, "\n")+"\n"))
}

func readManifest(dir string) ([]string, error) {
	f, err := os.Open(filepath.Join(dir, manifestName))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var names []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if line := strings.TrimSpace(sc.Text()); line != "" {
			names = append(names, line)
		}
	}
	return names, sc.Err()
}

func removeEmptyParents(root, dir string) {
	root = filepath.Clean(root)
	for dir = filepath.Clean(dir); dir != root && strings.HasPrefix(dir, root+string(filepath.Separator)); dir = filepath.Dir(dir) {
		if os.Remove(dir) != nil {
			return // not empty (or in use): stop
		}
	}
}

func writeEntry(f *zip.File, target string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	rc, err := f.Open()
	if err != nil {
		return fmt.Errorf("the app package is damaged (%s): %w", f.Name, err)
	}
	defer rc.Close()
	data, err := io.ReadAll(rc)
	if err != nil {
		return fmt.Errorf("the app package is damaged (%s): %w", f.Name, err)
	}
	return writeFileAtomic(target, data)
}

// writeFileAtomic writes next to the target and renames over it, so an interrupted setup never
// leaves a half-written file behind.
func writeFileAtomic(target string, data []byte) error {
	tmp := target + ".ais-new"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("could not write %s: %w", target, err)
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("could not replace %s (is AI Story Studio still running? close its window first): %w", target, err)
	}
	return nil
}
