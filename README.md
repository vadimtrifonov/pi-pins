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

- Pins are saved in the session as entries on its conversation tree.
  Each branch has its own pins, and going back in `/tree` or forking restores the pins of that point.
- Pinning a fourth message asks which pin to replace.
- **All** combines the current session's pins with pins from saved sessions, oldest message first.
- Pinning does not keep a message in the model's context.

## Limitations

- Pins from other sessions are read-only; to unpin one, open its session.
- Search checks message beginnings, not full bodies or command output.
- Clicking the shelf works only in Pi fullscreen mode.

## Development

```bash
mise install    # Node
mise deps       # npm packages
mise run check  # type check
mise run test   # tests
```
