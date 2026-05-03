# Toad

A terminal browser for the modern JS web. It runs Chromium headlessly via Puppeteer, extracts readable content with Mozilla's Reader Mode library, and prints it to your terminal.

There's no full-screen TUI. You type a URL or a number, it prints the page, you do it again. The browser is a REPL. Your scrollback is your history.

## Status

v0.1, weekend project. Works:

- Articles render as styled text
- Follow numbered links by typing the number
- Click numbered buttons (`cN`) for things Reader Mode strips out
- Auto-decline cookie banners in nine languages
- Bookmarks, with a startpage that lists them when launched bare
- Back / forward / reload

Not yet:

- Form inputs (text fields, dropdowns)
- Tables (turndown handles them poorly)
- Cookies persisted between runs

## Run

Requires Node 23.6+.

```
npm install
node src/cli.ts                                  # startpage
node src/cli.ts en.wikipedia.org/wiki/Frog
```

Bookmarks live at `~/.toad/bookmarks.json`.

## Commands

```
N        follow link N
cN       click button N
:url     go to URL
b / f    back / forward
r        reload
s        startpage
+        bookmark current page
-N       remove bookmark N (startpage only)
?        help
q        quit
```
