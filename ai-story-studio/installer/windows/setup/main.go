// AI Story Studio setup program for Windows.
//
// One .exe that carries the whole app. It copies the app into a folder in your user profile,
// then runs installer\windows\install.ps1, which checks Node.js, Python and FFmpeg (installing
// only what is missing), builds the app, creates a safe .env (mock mode, cloud GPU off) and the
// desktop shortcut. Running it again upgrades an existing installation; your .env and data
// folder (projects, database, API key) are never changed.
//
// Built by installer/windows/build-setup.sh (cross-compiled; no Windows tools needed).
package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var version = "1.1.0" // overridden with -ldflags "-X main.version=..."

//go:embed payload
var payloadFS embed.FS

type options struct {
	dir         string
	yes         bool // no questions, no pauses (for automated tests)
	extractOnly bool // copy the files but do not run install.ps1
	noStart     bool
	noShortcut  bool
}

type ui struct {
	in          *bufio.Reader
	out         io.Writer
	interactive bool
}

func (u *ui) say(format string, a ...any) { fmt.Fprintf(u.out, format+"\n", a...) }

func (u *ui) ask(prompt string) string {
	if !u.interactive {
		return ""
	}
	fmt.Fprint(u.out, prompt)
	line, _ := u.in.ReadString('\n')
	return strings.TrimSpace(line)
}

func main() {
	var o options
	flag.StringVar(&o.dir, "dir", "", "installation folder (default: %USERPROFILE%\\AI-Story-Studio)")
	flag.BoolVar(&o.yes, "yes", false, "do not ask questions (automated installs)")
	flag.BoolVar(&o.extractOnly, "extract-only", false, "only copy the app files; do not run the installer script")
	flag.BoolVar(&o.noStart, "no-start", false, "do not offer to start the app at the end")
	flag.BoolVar(&o.noShortcut, "no-shortcut", false, "do not create the desktop shortcut")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	u := &ui{in: bufio.NewReader(os.Stdin), out: os.Stdout, interactive: !o.yes}
	code := run(o, u)
	// Double-clicked console windows close immediately; keep the messages readable.
	u.ask("\nPress Enter to close this window.")
	os.Exit(code)
}

func run(o options, u *ui) int {
	u.say("==============================================================")
	u.say("  AI Story Studio %s - Setup", version)
	u.say("==============================================================")
	u.say("This installs AI Story Studio for your Windows user (no administrator rights needed).")
	u.say("- It needs an internet connection for about 5-15 minutes.")
	u.say("- It installs Node.js, Python or FFmpeg ONLY if they are missing (via WinGet).")
	u.say("- It does NOT install CUDA or NVIDIA drivers; your PC needs no NVIDIA GPU.")
	u.say("- The app starts in MOCK mode: no cloud GPU, no costs, until you enable it yourself.")
	u.say("")

	zr, err := openPayload()
	if err != nil {
		u.say("ERROR: %v", err)
		return 1
	}

	dir, kind, err := chooseDir(o, u)
	if err != nil {
		u.say("ERROR: %v", err)
		return 2
	}
	if kind == targetExisting {
		u.say("An existing AI Story Studio installation was found in %s.", dir)
		u.say("It will be UPGRADED. Your .env settings and your data folder (projects, database,")
		u.say("saved API key) are kept exactly as they are.")
	}
	if appRunning() {
		u.say("")
		u.say("AI Story Studio (or another program) is using port 3000. If AI Story Studio is running,")
		u.say("close its black window now.")
	}
	if u.interactive {
		u.ask(fmt.Sprintf("\nPress Enter to install into %s (or close this window to cancel). ", dir))
	}

	u.say("")
	u.say("Copying the app files...")
	res, err := installPayload(zr, dir)
	if err != nil {
		u.say("ERROR: %v", err)
		return 1
	}
	u.say("  %d files copied%s.", res.Written, plural(res.Removed, ", %d outdated files removed"))

	if o.extractOnly {
		u.say("Files copied (extract-only). To finish, run installer\\windows\\Install-AI-Story-Studio.bat.")
		return 0
	}
	if runtime.GOOS != "windows" {
		u.say("This setup program finishes the installation on Windows only. Files are in %s.", dir)
		return 0
	}

	u.say("")
	u.say("Running the installer script (checks and installs prerequisites, builds the app)...")
	u.say("A log is written to %s", filepath.Join(dir, "installer", "windows", "install.log"))
	u.say("")
	if err := runInstallScript(dir, o.noShortcut); err != nil {
		u.say("")
		u.say("INSTALLATION DID NOT FINISH: %v", err)
		u.say("Read the messages above, fix what they describe, then run this setup again.")
		u.say("Help: %s", filepath.Join(dir, "docs", "TROUBLESHOOTING_WINDOWS.md"))
		return 1
	}
	if _, err := os.Stat(filepath.Join(dir, "dist", "src", "web", "server.js")); err != nil {
		u.say("INSTALLATION DID NOT FINISH: the app was not built. See the log above.")
		return 1
	}

	u.say("")
	u.say("==============================================================")
	u.say("  AI Story Studio is installed.")
	u.say("==============================================================")
	if !o.noShortcut {
		u.say("Start it any time with the \"AI Story Studio\" shortcut on your desktop.")
	}
	u.say("It opens in your browser at http://127.0.0.1:3000/ . Keep its black window open while")
	u.say("you use it; closing that window stops the app.")
	u.say("Cloud GPU stays OFF until you follow docs\\RUNPOD_SETUP.md.")

	if !o.noStart && u.interactive {
		answer := strings.ToLower(u.ask("\nStart AI Story Studio now? [Y/n] "))
		if answer == "" || strings.HasPrefix(answer, "y") {
			if err := startApp(dir); err != nil {
				u.say("Could not start it automatically (%v). Use the desktop shortcut.", err)
			}
		}
	}
	return 0
}

func plural(n int, format string) string {
	if n == 0 {
		return ""
	}
	return fmt.Sprintf(format, n)
}

func openPayload() (*zip.Reader, error) {
	data, err := payloadFS.ReadFile("payload/app.zip")
	if err != nil {
		return nil, errors.New("this setup program was built without the app package; rebuild it with installer/windows/build-setup.sh")
	}
	return zip.NewReader(bytes.NewReader(data), int64(len(data)))
}

func defaultDir() string {
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, "AI-Story-Studio")
	}
	return "AI-Story-Studio"
}

// chooseDir asks for the folder (Enter keeps the default) and refuses folders that hold anything
// other than AI Story Studio, so the setup can never overwrite unrelated files.
func chooseDir(o options, u *ui) (string, targetKind, error) {
	dir := o.dir
	if dir == "" {
		dir = defaultDir()
		if u.interactive {
			u.say("Installation folder: %s", dir)
			if typed := u.ask("Press Enter to use it, or type another folder: "); typed != "" {
				dir = typed
			}
		}
	}
	for attempt := 0; ; attempt++ {
		dir = strings.Trim(strings.TrimSpace(dir), "\"")
		abs, err := filepath.Abs(dir)
		if err != nil {
			return "", targetForeign, err
		}
		kind, err := inspectTarget(abs)
		if err == nil && kind != targetForeign {
			return abs, kind, nil
		}
		reason := "it already contains other files that are not AI Story Studio"
		if err != nil {
			reason = err.Error()
		}
		u.say("Cannot install into %s: %s.", abs, reason)
		if !u.interactive || attempt >= 4 {
			return "", targetForeign, errors.New("choose an empty folder or an existing AI Story Studio folder")
		}
		dir = u.ask("Type another folder (for example " + defaultDir() + "): ")
		if dir == "" {
			dir = defaultDir()
		}
	}
}

func appRunning() bool {
	conn, err := net.DialTimeout("tcp", "127.0.0.1:3000", 300*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func runInstallScript(dir string, noShortcut bool) error {
	script := filepath.Join(dir, "installer", "windows", "install.ps1")
	args := []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script}
	if noShortcut {
		args = append(args, "-NoShortcut")
	}
	cmd := exec.Command("powershell.exe", args...)
	cmd.Dir = dir
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

func startApp(dir string) error {
	bat := filepath.Join(dir, "installer", "windows", "Start-AI-Story-Studio.bat")
	if _, err := os.Stat(bat); err != nil {
		return err
	}
	// "start" opens the app in its own window, so closing this setup window does not stop it.
	// The folder is passed as the working directory, not on the cmd.exe command line, so
	// characters such as & in a user name cannot be misread by cmd.exe.
	cmd := exec.Command("cmd.exe", "/c", "start", "AI Story Studio", `installer\windows\Start-AI-Story-Studio.bat`)
	cmd.Dir = dir
	return cmd.Start()
}
