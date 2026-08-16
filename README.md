# Full Browser — Chromium Inside VS Code

A full Chromium browser running inside VS Code / Antigravity IDE. Browse the entire internet without iframe restrictions using real Chrome rendering via CDP screencast.

## Features

- 🌐 **Browse any website** — No X-Frame-Options or CSP restrictions
- 🖱️ **Full mouse interaction** — Click, scroll, hover, drag
- ⌨️ **Keyboard input** — Type in search boxes, forms, text editors
- 🔎 **Zoom controls** — In-browser zoom support (`Ctrl+Plus` / `Ctrl+Minus` / `Ctrl+0`)
- 📑 **Quick Bookmarks Bar** — Fast access to Google, YouTube, GitHub, TakeUForward, ChatGPT, Stack Overflow
- 🔄 **Navigation** — Back, Forward, Reload, Home, URL bar with auto-HTTPS
- 🔒 **Security indicator** — Shows HTTPS status
- 🍪 **Chrome Session Sync** — Sync cookies from your Chrome browser profile
- 📊 **Status Bar** — FPS counter and Zoom indicator
- 🎨 **Theme integration** — Matches your IDE theme automatically

## How to Use

1. Press `Ctrl+Shift+P` to open the Command Palette
2. Type `Open Full Browser` and press **Enter** (or click the 🌐 icon in the status bar / editor title)
3. Browse the web directly inside your IDE!

### Keyboard Shortcuts (inside the browser panel)

| Shortcut | Action |
|----------|--------|
| `Ctrl+L` | Focus the URL bar |
| `F5` | Reload page |
| `Alt+Left` | Go back |
| `Alt+Right` | Go forward |
| `Ctrl+Plus` / `Ctrl+=` | Zoom in |
| `Ctrl+Minus` | Zoom out |
| `Ctrl+0` | Reset zoom |
| `Enter` (in URL bar) | Navigate to URL |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `fullBrowser.chromePath` | *(auto-detect)* | Path to Chrome/Edge/Brave executable |
| `fullBrowser.homepage` | `https://www.google.com` | Default homepage URL |
| `fullBrowser.quality` | `95` | Screencast JPEG quality (10–100) |
| `fullBrowser.everyNthFrame` | `1` | Capture every Nth frame |
| `fullBrowser.profileMode` | `persistent` | Browser profile mode (`persistent`, `chrome`, `temporary`) |
| `fullBrowser.profileDirectory` | `auto` | Chrome profile directory name |

---

*For build steps, packaging commands, and internal mechanics, see [`DEVELOPER.md`](DEVELOPER.md).*
