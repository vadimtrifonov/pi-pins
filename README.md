# Pins

Pins keeps up to three messages from a [Pi](https://github.com/earendil-works/pi) session listed above the editor.
Open a pin to read it again, copy it, or insert it into your prompt.

## Install

```bash
pi install git:github.com/vadimtrifonov/pi-pins
```

Then start Pi, or run `/reload` in a running session.

## Try it

1. Run `/pins` to browse the session's messages.
2. Press `p` to pin or unpin the selected message.
   Pins appear on the shelf above the editor.
3. Press `Tab` to switch between **Session** and **All**, which shows pins only from all sessions.
4. Press `Enter` to read the full text, and `Esc` to go back.
   Press `c` to copy it, or `i` to insert it into the editor and close the panel.

Click a pin on the shelf to open the panel with that pin selected.

## How it works

- Each session shows the pinned messages it contains, on any branch.
  Forks contain their parent's messages, so they share those pins, and open sessions update as soon as a pin changes.
- Pinning a fourth message asks which pin to replace.
- **All** lists pins oldest first, each with the session where its message was written.
- Pins are saved in `~/.pi/agent/pins/pins.json` with a copy of each message's text.
- Pinning does not keep a message in the model's context.

## Limitations

- Search checks message beginnings, not full bodies or command output.
- Clicking the shelf works only in Pi fullscreen mode.

## Development

```bash
mise install    # Node
mise deps       # npm packages
mise run check  # type check
mise run test   # tests
```
