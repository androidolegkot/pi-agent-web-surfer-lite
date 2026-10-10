# Pi Agent Web Surfer Lite

A lightweight web browsing extension for [Pi Coding Agent](https://github.com/earendil-works/pi) using headless Chromium via the Chrome DevTools Protocol (CDP).

## Features

- Search the web and navigate to URLs.
- Read page content with links included inline.
- Extract page content as text, HTML, or DOM JSON.
- Save full page output to files instead of flooding the model's context.
- Retrieve content in chunks using `limit` and `offset`.
- Click elements and enter text into page fields.
- Start, stop, and check the browser status.
- Combine navigation and reading in a single tool call.

## How It Works

The extension communicates with a headless Chromium browser through CDP. Page content can be saved locally, returning only metadata and a file path to the model.

This lets Pi Agent inspect large pages using its built-in file tools, grep, jq, or custom scripts without including the entire page in the conversation context.

## Tools

| Tool | Description |
| --- | --- |
| `search` | Navigate to web search results |
| `go_to_url` | Open a URL |
| `search_and_read` | Search and read results in one call |
| `go_to_url_and_read` | Open and read a page in one call |
| `get_page_content` | Extract readable text and links |
| `get_page_html` | Retrieve page HTML |
| `get_page_json` | Retrieve DOM data as JSON |
| `get_page_title` | Get the page title |
| `click_element` | Click a page element |
| `set_element_text` | Enter text into a page field |
| `start_browser` | Start the browser |
| `stop_browser` | Stop the browser |
| `get_browser_status` | Check browser status |

## Output Formats

Combined navigation-and-reading tools support three formats:

- `content` — readable page text with URLs included inline.
- `json` — DOM data represented as JSON.
- `html` — page HTML.

By default, page output is saved to a local file, and the tool returns short metadata and the file path. Set `as_file: false` to return content directly in the tool response.

For direct output, `limit` and `offset` can be used to retrieve a specific portion of the content. These parameters are ignored when saving the full output to a file.

## Requirements

- [Pi Coding Agent](https://github.com/earendil-works/pi)
- Node.js
- Chromium or a compatible headless Chromium executable
- A running CDP endpoint accessible to the extension

## Configuration

The browser and storage settings are defined at the top of `web-surfer-lite-typescript.ts`.

| Setting | Default |
| --- | --- |
| `SEARCH_URL` | `https://www.google.com/search?q=` |
| `CDP_HOST` | `127.0.0.1` |
| `CDP_PORT` | `9223` |
| `BROWSER_PID_FILE` | `/tmp/web-surfer-lite-typescript-browser.pid` |
| `SAVE_PAGE_DIR` | `/tmp` |
| `BROWSER_BIN` | `/opt/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell` |
| Browser profile | `~/chromium_headless_shell-profile` |

`BROWSER_ARGS` defines the Chromium launch arguments, including headless mode, the CDP endpoint, language, user agent, and browser profile.

Edit these constants to match your environment. The browser executable must exist, and the CDP host and port must be accessible to the extension.

### Default Limits

| Setting | Default |
| --- | --- |
| `DEFAULT_TEXT_LIMIT` | 100,000 characters |
| `DEFAULT_HTML_LIMIT` | 1,000,000 characters |
| `DEFAULT_JSON_LIMIT` | 1,000 DOM elements |
| `DEFAULT_READ_TIMEOUT` | 10 seconds |
| `NO_LIMIT` | `Number.MAX_SAFE_INTEGER` |

The default read timeout applies to combined `*_and_read` operations when no timeout is specified. When `as_file` is enabled, the full page output is saved to `SAVE_PAGE_DIR`, and the content limits and offsets are ignored.

## Installation

Place `web-surfer-lite.ts` in your Pi Agent extensions directory, for example:

```bash
mkdir -p ~/.pi/agent/extensions
cp web-surfer-lite-typescript.ts ~/.pi/agent/extensions/
```

Configure the Chromium executable and CDP settings for your environment, then restart Pi Agent or reload extensions as appropriate.

## Acknowledgments

Developed with assistance from [ChatGPT](chatgpt.com) and [Claude](claude.ai).
